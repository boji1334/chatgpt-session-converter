#!/usr/bin/env python3
"""JSON bridge for the full Plus subscription checker.

The Node quota service launches this process for one request at a time. The
bridge deliberately returns hashes and metadata only; access tokens never
appear in stdout or in the returned JSON.
"""
from __future__ import annotations

import csv
import io
import json
import re
import sys
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

import check_subscription as checker


EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
CODE_URL_RE = re.compile(r"https?://[^\s]+?(?=----|\s|$)")
TWOFA_URL_RE = re.compile(r"https?://2fa\.fb\.tools/([A-Za-z0-9]+)")


def extract_line_extra(line: str) -> dict[str, str]:
    raw = line.strip()
    jwt = checker.TOKEN_RE.search(raw)
    prefix = raw[:jwt.start()] if jwt else raw
    plus_txt_line = prefix.strip()
    if plus_txt_line.endswith("----"):
        plus_txt_line = plus_txt_line[:-4].rstrip()
    elif plus_txt_line.endswith("---"):
        plus_txt_line = plus_txt_line[:-3].rstrip()
    email_match = EMAIL_RE.search(prefix)
    url_match = CODE_URL_RE.search(prefix)
    code_url = (url_match.group(0) if url_match else "").strip().rstrip("]})>,.;\"'")
    export_line = ""
    if email_match:
        parts = [part.strip() for part in re.split(r"----|——|---", plus_txt_line) if part.strip()]
        password = parts[1] if len(parts) >= 2 and parts[0] == email_match.group(0) else ""
        secret = ""
        if len(parts) >= 3 and parts[0] == email_match.group(0):
            secret_match = TWOFA_URL_RE.search(parts[2])
            secret = (secret_match.group(1) if secret_match else parts[2]).strip()
        if not secret:
            secret_match = TWOFA_URL_RE.search(prefix)
            secret = secret_match.group(1) if secret_match else ""
        export_line = f"{email_match.group(0)}——{password}——{secret}"
    return {
        "email": email_match.group(0) if email_match else "",
        "code_url": code_url,
        "plus_txt_line": export_line,
    }


def parse_items_from_text(text: str):
    items: list[checker.TokenItem] = []
    errors: list[str] = []
    seen: set[str] = set()
    extras_by_hash: dict[str, dict[str, str]] = {}
    raw_count = 0

    def add_item(item: checker.TokenItem, extra: dict[str, str]) -> None:
        nonlocal raw_count
        raw_count += 1
        token_hash = checker.token_hash(item.token)
        if token_hash in seen:
            return
        seen.add(token_hash)
        extras_by_hash[token_hash] = extra
        items.append(item)

    for line_no, line in enumerate(text.splitlines(), 1):
        raw = line.strip()
        if not raw:
            continue
        extra = extract_line_extra(raw)
        jwt_matches = list(checker.TOKEN_RE.finditer(raw))
        if not jwt_matches:
            errors.append(f"line {line_no}: no JWT access token")
            continue
        try:
            parsed = checker.parse_token_line(raw, line_no)
            if parsed:
                if extra.get("email"):
                    parsed = checker.TokenItem(label=extra["email"], token=parsed.token, line_no=parsed.line_no)
                add_item(parsed, extra)
        except Exception as error:
            errors.append(str(error))
        if len(jwt_matches) > 1:
            for index, match in enumerate(jwt_matches[1:], 2):
                label = extra.get("email") or f"line{line_no}_token{index}"
                add_item(checker.TokenItem(label=label, token=match.group(0), line_no=line_no), extra)

    return items, errors, raw_count, extras_by_hash


def preview_row(item: checker.TokenItem, extra: dict[str, str] | None = None) -> dict[str, str]:
    extra = extra or {}
    metadata = checker.jwt_metadata(item.token)
    claim_sub, claim_raw, account_id, email, claim_source = checker.classify_jwt_claims(item.token)
    return {
        "label": item.label,
        "line_no": str(item.line_no),
        "email": email or extra.get("email") or item.label,
        "code_url": extra.get("code_url", ""),
        "plus_txt_line": extra.get("plus_txt_line", ""),
        "account_id": account_id,
        "token_hash": checker.token_hash(item.token),
        **metadata,
        "claim_subscription": claim_sub,
        "claim_raw_plan": claim_raw,
        "claim_source": claim_source,
        "auth_state": "not_checked",
        "http_status": "",
        "subscription": "pending",
        "subscription_confidence": "not_checked",
        "subscription_source": "",
        "raw_plan": "",
        "first_month_free_promo": "unknown",
        "promo_id": "",
        "promo_plan": "",
        "promo_title": "",
        "promo_discount": "",
        "promo_duration": "",
        "promo_source": "",
        "account_usable": "unknown",
        "ban_state": "not_checked",
        "usable_source": "",
        "needs_fresh_login": "unknown",
        "refresh_reason": "not_checked",
        "source_endpoint": "",
        "error_code": "",
        "error": "",
    }


def summarize(rows: list[dict[str, str]]) -> dict[str, int]:
    summary: dict[str, int] = {}
    for row in rows:
        key = row.get("subscription") or "unknown"
        summary[key] = summary.get(key, 0) + 1
    return summary


def extra_summarize(rows: list[dict[str, str]]) -> dict[str, int]:
    summary: dict[str, int] = {}
    for row in rows:
        if str(row.get("subscription") or "").startswith("unverified"):
            summary["unverified"] = summary.get("unverified", 0) + 1
        promo_state = row.get("first_month_free_promo")
        if promo_state in ("yes", "likely"):
            summary["first_month_free_promo_candidate"] = summary.get("first_month_free_promo_candidate", 0) + 1
            if row.get("subscription") == "free":
                summary["free_first_month_promo_candidate"] = summary.get("free_first_month_promo_candidate", 0) + 1
        if promo_state == "yes":
            summary["first_month_free_promo_yes"] = summary.get("first_month_free_promo_yes", 0) + 1
            if row.get("subscription") == "free":
                summary["free_first_month_promo_yes"] = summary.get("free_first_month_promo_yes", 0) + 1
        if row.get("account_usable") == "yes":
            summary["account_usable_yes"] = summary.get("account_usable_yes", 0) + 1
        if row.get("account_usable") == "no":
            summary["account_usable_no"] = summary.get("account_usable_no", 0) + 1
        if row.get("needs_fresh_login") == "yes":
            summary["needs_fresh_login_yes"] = summary.get("needs_fresh_login_yes", 0) + 1
    return summary


def rows_to_csv(rows: list[dict[str, str]]) -> str:
    fields = [
        "label", "email", "code_url", "plus_txt_line", "account_id", "token_hash",
        "subscription", "subscription_confidence", "subscription_source", "raw_plan",
        "claim_subscription", "claim_raw_plan", "auth_state", "http_status",
        "account_usable", "ban_state", "usable_source", "needs_fresh_login", "refresh_reason",
        "first_month_free_promo", "promo_id", "promo_plan", "promo_title", "promo_discount",
        "promo_duration", "promo_source", "jwt_state", "jwt_exp_utc", "source_endpoint",
        "error_code", "error",
    ]
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=fields, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)
    return buffer.getvalue()


def run_check(body: dict[str, Any]) -> dict[str, Any]:
    text = str(body.get("text") or "")
    items, errors, raw_count, extras_by_hash = parse_items_from_text(text)
    if not items:
        return {"count": 0, "input_count": raw_count, "unique_count": 0, "rows": [], "summary": {}, "extra_summary": {}, "errors": errors}

    concurrency = max(1, min(int(body.get("concurrency") or 4), 20))
    probe_all = bool(body.get("probe_all", False))
    timeout = max(3.0, min(float(body.get("timeout") or (6 if probe_all else 8)), 25.0))
    endpoints = checker.DEFAULT_ENDPOINTS if probe_all else [checker.DEFAULT_ENDPOINTS[0]]
    started = time.perf_counter()
    diag_rows: list[dict[str, Any]] = []

    def enrich(row: dict[str, str]) -> dict[str, str]:
        extra = extras_by_hash.get(row.get("token_hash", ""), {})
        row["code_url"] = extra.get("code_url", "")
        row["plus_txt_line"] = extra.get("plus_txt_line", "")
        if not row.get("email") and extra.get("email"):
            row["email"] = extra["email"]
        if extra.get("email"):
            row["label"] = extra["email"]
        return row

    def run_batch(batch_items, batch_timeout, batch_concurrency, batch_retries, batch_endpoints=None):
        rows: list[dict[str, str]] = []
        diagnostics: list[dict[str, Any]] = []
        workers = max(1, min(batch_concurrency, len(batch_items) or 1))
        active_endpoints = batch_endpoints or endpoints
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = [executor.submit(checker.check_one, item, active_endpoints, batch_timeout, None, batch_retries, {}, probe_all) for item in batch_items]
            for future in as_completed(futures):
                row, diag = future.result()
                rows.append(enrich(row))
                diagnostics.extend(diag)
        return rows, diagnostics

    rows, diagnostics = run_batch(items, timeout, concurrency, 0)
    diag_rows.extend(diagnostics)

    def needs_retry(row: dict[str, str]) -> bool:
        subscription = (row.get("subscription") or "").lower()
        error_code = (row.get("error_code") or "").lower()
        return subscription in ("", "unknown", "unverified") or error_code in ("network_error", "timeout", "request_error")

    retry_hashes = {row.get("token_hash", "") for row in rows if needs_retry(row)}
    retry_items = [item for item in items if checker.token_hash(item.token) in retry_hashes]
    retry_count = len(retry_items)
    if retry_items:
        retry_endpoints = endpoints if probe_all else [checker.DEFAULT_ENDPOINTS[1]]
        retry_retries = 1 if probe_all else 0
        retry_concurrency = min(concurrency, 4 if probe_all else 8)
        retry_rows, retry_diag = run_batch(retry_items, timeout, retry_concurrency, retry_retries, retry_endpoints)
        diag_rows.extend(retry_diag)
        retry_by_hash = {row.get("token_hash", ""): row for row in retry_rows}
        rows = [retry_by_hash.get(row.get("token_hash", ""), row) for row in rows]

    rows.sort(key=lambda row: (int(row.get("line_no") or 0), row.get("label", "")))
    return {
        "count": len(items),
        "input_count": raw_count,
        "unique_count": len(items),
        "elapsed_ms": int((time.perf_counter() - started) * 1000),
        "retry_count": retry_count,
        "rows": rows,
        "summary": summarize(rows),
        "extra_summary": extra_summarize(rows),
        "diag": diag_rows,
        "errors": errors[:200],
    }


def run_check_stream(body: dict[str, Any], emit) -> dict[str, Any]:
    """Run the same checker while reporting one progress event per finished account."""
    text = str(body.get("text") or "")
    items, errors, raw_count, extras_by_hash = parse_items_from_text(text)
    total = len(items)
    emit({"type": "start", "total": total, "input_count": raw_count})
    if not items:
        result = {"count": 0, "input_count": raw_count, "unique_count": 0, "rows": [], "summary": {}, "extra_summary": {}, "errors": errors[:200]}
        emit({"type": "result", "data": result})
        return result

    concurrency = max(1, min(int(body.get("concurrency") or 4), 20))
    probe_all = bool(body.get("probe_all", False))
    timeout = max(3.0, min(float(body.get("timeout") or (6 if probe_all else 8)), 25.0))
    endpoints = checker.DEFAULT_ENDPOINTS if probe_all else [checker.DEFAULT_ENDPOINTS[0]]
    started = time.perf_counter()
    diag_rows: list[dict[str, Any]] = []

    def enrich(row: dict[str, str]) -> dict[str, str]:
        extra = extras_by_hash.get(row.get("token_hash", ""), {})
        row["code_url"] = extra.get("code_url", "")
        row["plus_txt_line"] = extra.get("plus_txt_line", "")
        if not row.get("email") and extra.get("email"):
            row["email"] = extra["email"]
        if extra.get("email"):
            row["label"] = extra["email"]
        return row

    def needs_retry(row: dict[str, str]) -> bool:
        subscription = (row.get("subscription") or "").lower()
        error_code = (row.get("error_code") or "").lower()
        return subscription in ("", "unknown", "unverified") or error_code in ("network_error", "timeout", "request_error")

    def check_final(item):
        row, diagnostics = checker.check_one(item, endpoints, timeout, None, 0, {}, probe_all)
        row = enrich(row)
        retried = False
        if needs_retry(row):
            retry_endpoints = endpoints if probe_all else [checker.DEFAULT_ENDPOINTS[1]]
            retry_retries = 1 if probe_all else 0
            retry_row, retry_diagnostics = checker.check_one(item, retry_endpoints, timeout, None, retry_retries, {}, probe_all)
            row = enrich(retry_row)
            diagnostics.extend(retry_diagnostics)
            retried = True
        return row, diagnostics, retried

    rows: list[dict[str, str]] = []
    retry_count = 0
    completed = 0
    workers = max(1, min(concurrency, total))
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [executor.submit(check_final, item) for item in items]
        for future in as_completed(futures):
            row, diagnostics, retried = future.result()
            rows.append(row)
            diag_rows.extend(diagnostics)
            retry_count += int(retried)
            completed += 1
            emit({
                "type": "progress",
                "completed": completed,
                "total": total,
                "row": {
                    "label": row.get("label", ""),
                    "email": row.get("email", ""),
                    "subscription": row.get("subscription", ""),
                    "account_usable": row.get("account_usable", ""),
                    "needs_fresh_login": row.get("needs_fresh_login", ""),
                    "first_month_free_promo": row.get("first_month_free_promo", ""),
                    "error_code": row.get("error_code", ""),
                },
            })

    rows.sort(key=lambda row: (int(row.get("line_no") or 0), row.get("label", "")))
    result = {
        "count": total,
        "input_count": raw_count,
        "unique_count": total,
        "elapsed_ms": int((time.perf_counter() - started) * 1000),
        "retry_count": retry_count,
        "rows": rows,
        "summary": summarize(rows),
        "extra_summary": extra_summarize(rows),
        "diag": diag_rows,
        "errors": errors[:200],
    }
    emit({"type": "result", "data": result})
    return result


def main() -> int:
    try:
        body = json.loads(sys.stdin.read() or "{}")
        action = str(body.get("action") or "check")
        text = str(body.get("text") or "")
        if action == "parse":
            items, errors, raw_count, extras_by_hash = parse_items_from_text(text)
            rows = [preview_row(item, extras_by_hash.get(checker.token_hash(item.token), {})) for item in items]
            output = {"count": raw_count, "unique_count": len(items), "rows": rows, "errors": errors[:200]}
        elif action == "csv":
            output = {"csv": "\ufeff" + rows_to_csv(body.get("rows") if isinstance(body.get("rows"), list) else [])}
        elif action == "check_stream":
            def emit(event):
                sys.stdout.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
                sys.stdout.flush()
            run_check_stream(body, emit)
            return 0
        else:
            output = run_check(body)
        sys.stdout.write(json.dumps(output, ensure_ascii=False, separators=(",", ":")))
        return 0
    except Exception as error:
        sys.stdout.write(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
