#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Batch-check ChatGPT account subscription status from access tokens.

Input token formats, one per line:
  <access_token>
  <label> <access_token>
  <label>,<access_token>
  <label>=<access_token>
  <label>----<ignored>----<access_token>
  {"accessToken":"<access_token>", ...}

Output CSV columns include auth_state + subscription. Tokens are never printed.
If backend endpoints reject the AT, the JWT plan claim is preserved while the
account is separately marked unverified and in need of a fresh login.
"""
from __future__ import annotations

import argparse
import base64
import csv
import datetime as dt
import hashlib
import json
import re
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

CHATGPT_ORIGIN = "https://chatgpt.com"
COMMON_LOCAL_HTTP_PROXIES = (
    "http://127.0.0.1:7897",
    "http://127.0.0.1:7890",
    "http://127.0.0.1:10809",
    "http://127.0.0.1:1080",
    "http://127.0.0.1:10808",
)
_PROXY_LOCK = threading.Lock()
_ACTIVE_PROXY: str | None = None
_HTTP_OPENER: Any = None
DEFAULT_ENDPOINTS: list[tuple[str, str, str, Any]] = [
    ("accounts_check_v4_tz", "GET", "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27?timezone_offset_min=-480", None),
    ("accounts_check_v4", "GET", "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27", None),
    ("accounts_check", "GET", "https://chatgpt.com/backend-api/accounts/check", None),
    ("optimized_check", "GET", "https://chatgpt.com/backend-api/accounts/optimized/check", None),
    ("me", "GET", "https://chatgpt.com/backend-api/me", None),
    ("settings_user", "GET", "https://chatgpt.com/backend-api/settings/user", None),
    ("billing_config", "GET", "https://chatgpt.com/backend-api/pageConfigs/billing", None),
    ("models", "GET", "https://chatgpt.com/backend-api/models?iim=false&is_gizmo=false&supports_model_picker_upgrade_presets=true", None),
]
ACCOUNT_AUTH_ENDPOINTS = {
    "accounts_check_v4_tz",
    "accounts_check_v4",
    "accounts_check",
    "optimized_check",
}

TOKEN_RE = re.compile(r"eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+")
PLAN_WORDS = ("enterprise", "business", "team", "pro", "plus", "go", "free")
PAID_BOOL_KEYS = (
    "has_active_subscription",
    "has_paid_subscription",
    "is_paid_subscription_active",
    "active_subscription",
    "is_paid",
    "is_subscribed",
    "subscriber",
    "paid",
    "was_paid_customer",
)
PLUS_BOOL_KEYS = ("is_plus", "plus_user", "has_plus", "chatgpt_plus", "plus")
PLAN_VALUE_KEYS = (
    "plan", "plan_type", "plan_name", "subscription_plan", "subscription_tier",
    "subscription_type", "product", "product_name", "billing_plan", "account_plan",
    "workspace_plan", "purchase_plan", "tier", "sku",
)
EXPIRY_KEYS = (
    "expires_at", "expiration", "expires", "subscription_expires_at_timestamp",
    "current_period_end", "renewal_date", "period_end",
)
IGNORE_PLAN_PATH_PARTS = (
    "eligible", "eligible_offers", "eligible_promo_campaigns", "offer", "offers",
    "promo", "campaign", "default_offer_id", "features", "model", "models",
    "categories", "accepted_mime_types", "mime", "upsell", "trial_offer",
)
AUTHORITATIVE_PLAN_TAILS = (
    "chatgpt_plan_type",
    "plan_type",
    "subscription_plan",
    "subscription_tier",
    "subscription_type",
    "account_plan",
    "workspace_plan",
    "billing_plan",
)
BAD_ACCOUNT_BOOL_TAILS = (
    "is_deactivated",
    "is_disabled",
    "is_suspended",
    "is_banned",
    "is_locked",
    "is_deleted",
    "is_terminated",
)
BAD_ACCOUNT_TEXT_WORDS = ("deactivated", "disabled", "suspended", "banned", "locked", "terminated", "deleted")


def _proxy_endpoint(proxy_url: str) -> tuple[str, int] | None:
    try:
        parsed = urllib.parse.urlsplit(proxy_url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            return None
        return parsed.hostname, parsed.port or 80
    except Exception:
        return None


def _proxy_is_reachable(proxy_url: str) -> bool:
    endpoint = _proxy_endpoint(proxy_url)
    if not endpoint:
        return False
    host, port = endpoint
    if host not in ("127.0.0.1", "localhost", "::1"):
        return True
    try:
        with socket.create_connection((host, port), timeout=0.35):
            return True
    except OSError:
        return False


def active_proxy() -> str:
    """Choose a reachable HTTP proxy, preferring live local Clash ports."""
    global _ACTIVE_PROXY, _HTTP_OPENER
    if _ACTIVE_PROXY is not None:
        return _ACTIVE_PROXY
    with _PROXY_LOCK:
        if _ACTIVE_PROXY is not None:
            return _ACTIVE_PROXY
        candidates: list[str] = []
        env_proxies = urllib.request.getproxies()
        for key in ("https", "http", "all"):
            value = env_proxies.get(key)
            if value and value not in candidates:
                candidates.append(value)
        candidates.extend(p for p in COMMON_LOCAL_HTTP_PROXIES if p not in candidates)
        _ACTIVE_PROXY = next((p for p in candidates if _proxy_is_reachable(p)), "")
        if _ACTIVE_PROXY:
            _HTTP_OPENER = urllib.request.build_opener(
                urllib.request.ProxyHandler({"http": _ACTIVE_PROXY, "https": _ACTIVE_PROXY})
            )
        else:
            # Ignore a dead environment proxy and let the direct request fail fast.
            _HTTP_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return _ACTIVE_PROXY


def active_proxy_display() -> str:
    proxy = active_proxy()
    endpoint = _proxy_endpoint(proxy) if proxy else None
    return f"{endpoint[0]}:{endpoint[1]}" if endpoint else ("direct" if not proxy else "configured")


def _open_http(request: urllib.request.Request, timeout: float):
    active_proxy()
    return _HTTP_OPENER.open(request, timeout=timeout)


@dataclass(frozen=True)
class TokenItem:
    label: str
    token: str
    line_no: int


@dataclass(frozen=True)
class EndpointResult:
    name: str
    method: str
    url: str
    status: int
    data: Any
    error_code: str
    error_message: str
    elapsed_ms: int


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8", "ignore")).hexdigest()[:12]


def b64url_json(segment: str) -> Any:
    padded = segment + "=" * ((4 - len(segment) % 4) % 4)
    return json.loads(base64.urlsafe_b64decode(padded.encode("ascii")))


def jwt_payload(token: str) -> dict[str, Any]:
    try:
        payload = b64url_json(token.split(".")[1])
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


def jwt_is_signup(token: str) -> bool:
    payload = jwt_payload(token)
    auth = payload.get("https://api.openai.com/auth") if isinstance(payload, dict) else None
    if not isinstance(auth, dict):
        return False
    value = auth.get("is_signup")
    if isinstance(value, bool):
        return value
    return isinstance(value, str) and value.strip().lower() == "true"


def extract_jwt(text: str) -> str:
    m = TOKEN_RE.search(text)
    return m.group(0) if m else ""


def parse_token_line(line: str, line_no: int) -> TokenItem | None:
    raw = line.strip().lstrip("\ufeff")
    if not raw or raw.startswith("#"):
        return None
    raw = raw.strip('"\'')

    # Session JSON / copied browser response.
    if raw.startswith("{"):
        try:
            obj = json.loads(raw)
            for key in ("accessToken", "access_token", "token"):
                val = obj.get(key)
                if isinstance(val, str) and extract_jwt(val):
                    label = str(obj.get("email") or obj.get("user", {}).get("email") or f"line{line_no}")
                    return TokenItem(label=label, token=extract_jwt(val), line_no=line_no)
        except Exception:
            pass

    # Account exports: label----ignored-password----jwt
    if "----" in raw:
        parts = raw.split("----")
        label = parts[0].strip() or f"line{line_no}"
        token = extract_jwt(parts[-1]) or extract_jwt(raw)
        if token:
            return TokenItem(label=label, token=token, line_no=line_no)

    # Common delimited forms: label token / label,token / label=token
    for sep in ("=", ",", "\t", " "):
        if sep in raw:
            left, right = raw.split(sep, 1)
            token = extract_jwt(right)
            if token:
                return TokenItem(label=left.strip() or f"line{line_no}", token=token, line_no=line_no)

    token = extract_jwt(raw)
    if token:
        return TokenItem(label=f"line{line_no}", token=token, line_no=line_no)

    raise ValueError(f"line {line_no}: access token not recognized")


def load_tokens(path: Path) -> list[TokenItem]:
    items: list[TokenItem] = []
    with path.open("r", encoding="utf-8-sig") as f:
        for line_no, line in enumerate(f, 1):
            item = parse_token_line(line, line_no)
            if item:
                items.append(item)
    if not items:
        raise SystemExit(f"no tokens found in {path}")
    return items


def scalar_walk(obj: Any, path: tuple[str, ...] = ()) -> Iterable[tuple[str, Any]]:
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield from scalar_walk(v, path + (str(k),))
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from scalar_walk(v, path + (str(i),))
    else:
        yield ".".join(path).lower(), obj


def path_segments(path: str) -> tuple[str, ...]:
    return tuple(seg.lower() for seg in path.split(".") if seg)


def is_ignored_plan_path(path: str) -> bool:
    segs = path_segments(path)
    for seg in segs:
        if seg in IGNORE_PLAN_PATH_PARTS:
            return True
        if seg.startswith(("eligible_", "promo_", "offer_", "upsell_")):
            return True
    return False


def plan_from_text(text: str) -> tuple[str, str]:
    raw = str(text).strip()
    compact = re.sub(r"[^a-z0-9]+", "", raw.lower())
    if not compact:
        return "unknown", ""
    if compact in ("free", "chatgptfree", "chatgptfreeplan") or "chatgptfreeplan" in compact:
        return "free", raw
    if compact in ("plus", "chatgptplus", "chatgptplusplan") or "chatgptplusplan" in compact:
        return "plus", raw
    if compact in ("pro", "chatgptpro", "chatgptproplan") or compact.startswith("chatgptpro"):
        return "pro", raw
    if compact in ("team", "chatgptteam", "chatgptteamplan") or "chatgptteamplan" in compact:
        return "team", raw
    if "business" in compact:
        return "business", raw
    if "enterprise" in compact:
        return "enterprise", raw
    if compact in ("go", "chatgptgo", "chatgptgoplan") or "chatgptgoplan" in compact:
        return "paid_other", raw
    return "unknown", ""


def bool_text(value: bool | None) -> str:
    if value is True:
        return "yes"
    if value is False:
        return "no"
    return "unknown"


def first_bool_by_tail(data: Any, tails: tuple[str, ...]) -> tuple[str, bool | None]:
    for key, value in scalar_walk(data):
        tail = key.rsplit(".", 1)[-1].lower()
        if tail in tails and isinstance(value, bool):
            return key, value
    return "", None


def first_text_by_tail(data: Any, tails: tuple[str, ...]) -> tuple[str, str]:
    for key, value in scalar_walk(data):
        tail = key.rsplit(".", 1)[-1].lower()
        if tail in tails and value not in (None, ""):
            return key, str(value)
    return "", ""


def first_scalar(data: Any, wanted: tuple[str, ...]) -> str:
    for key, value in scalar_walk(data):
        tail = key.rsplit(".", 1)[-1]
        if tail in wanted and value not in (None, ""):
            return str(value)
    return ""


def first_matching_path(data: Any, wanted: tuple[str, ...]) -> tuple[str, str]:
    for key, value in scalar_walk(data):
        tail = key.rsplit(".", 1)[-1]
        if tail in wanted and value not in (None, ""):
            return key, str(value)
    return "", ""


def normalize_epoch_or_text(value: str) -> str:
    text = str(value).strip()
    if not text:
        return ""
    try:
        n = float(text)
        if n > 10_000_000_000:  # ms
            n = n / 1000.0
        if n > 946684800:  # after 2000-01-01
            return dt.datetime.fromtimestamp(n, dt.timezone.utc).isoformat()
    except Exception:
        pass
    return text[:80]


def find_subscription_expiry(data: Any) -> str:
    _, value = first_matching_path(data, EXPIRY_KEYS)
    return normalize_epoch_or_text(value)


def find_account_id(data: Any) -> str:
    direct = first_scalar(data, ("current_account_id", "default_account_id", "account_id", "id"))
    return direct[:100]


def find_email(data: Any) -> str:
    email = first_scalar(data, ("email", "email_address", "user_email"))
    return email[:160]


def classify_first_month_free_promo(data: Any | None) -> dict[str, str]:
    """Detect whether account-check JSON exposes a first-month-free Plus promo."""
    out = {
        "first_month_free_promo": "unknown",
        "promo_id": "",
        "promo_plan": "",
        "promo_title": "",
        "promo_discount": "",
        "promo_duration": "",
        "promo_source": "",
    }
    if data is None:
        return out

    promo_hits: list[dict[str, str]] = []
    seen_roots: set[str] = set()

    # Direct object extraction when structure is available.
    if isinstance(data, dict):
        accounts = data.get("accounts")
        if isinstance(accounts, dict):
            for _, account_blob in accounts.items():
                if not isinstance(account_blob, dict):
                    continue
                promos = account_blob.get("eligible_promo_campaigns")
                if isinstance(promos, dict):
                    plus = promos.get("plus")
                    if isinstance(plus, dict):
                        meta = plus.get("metadata") if isinstance(plus.get("metadata"), dict) else {}
                        duration = meta.get("duration") if isinstance(meta.get("duration"), dict) else {}
                        discount = meta.get("discount") if isinstance(meta.get("discount"), dict) else {}
                        promo_hits.append({
                            "id": str(plus.get("id") or ""),
                            "plan": str(meta.get("plan_name") or ""),
                            "title": str(meta.get("title") or meta.get("promotion_type_label") or ""),
                            "discount": str(discount.get("percentage") or meta.get("discount_percentage") or ""),
                            "duration": f"{duration.get('num_periods') or ''} {duration.get('period') or ''}".strip(),
                            "source": "eligible_promo_campaigns.plus",
                        })

    # Fallback scalar scan; keep root around eligible_promo_campaigns.plus.
    for key, value in scalar_walk(data):
        key_l = key.lower()
        if "eligible_promo_campaigns.plus" not in key_l:
            continue
        root = key_l.split(".metadata.", 1)[0]
        if root in seen_roots:
            continue
        seen_roots.add(root)
        # The direct extraction above should usually cover this. The fallback
        # ensures nested/variant objects still mark a possible promo.
        promo_hits.append({
            "id": "",
            "plan": "",
            "title": "",
            "discount": "",
            "duration": "",
            "source": root,
        })

    if not promo_hits:
        out["first_month_free_promo"] = "no"
        return out

    for hit in promo_hits:
        joined = " ".join(hit.values()).lower()
        discount_100 = hit.get("discount") in ("100", "100.0")
        one_month = hit.get("duration", "").lower().strip() in ("1 month", "1 months")
        plus_plan = "chatgptplusplan" in re.sub(r"[^a-z0-9]+", "", hit.get("plan", "").lower())
        first_month_text = (
            "plus-1-month-free" in joined
            or "free for 1 month" in joined
            or "1-month free" in joined
            or "1 month free" in joined
        )
        if first_month_text or (plus_plan and discount_100 and one_month):
            out.update({
                "first_month_free_promo": "yes",
                "promo_id": hit.get("id", "")[:120],
                "promo_plan": hit.get("plan", "")[:120],
                "promo_title": hit.get("title", "")[:200],
                "promo_discount": hit.get("discount", "")[:40],
                "promo_duration": hit.get("duration", "")[:80],
                "promo_source": hit.get("source", "")[:160],
            })
            return out

    # There are promo objects, but not a first-month-free Plus promo.
    first = promo_hits[0]
    out.update({
        "first_month_free_promo": "no",
        "promo_id": first.get("id", "")[:120],
        "promo_plan": first.get("plan", "")[:120],
        "promo_title": first.get("title", "")[:200],
        "promo_discount": first.get("discount", "")[:40],
        "promo_duration": first.get("duration", "")[:80],
        "promo_source": first.get("source", "")[:160],
    })
    return out


def classify_signup_promo_candidate(
    promo_info: dict[str, str], token: str, claim_sub: str, auth_state: str, data: Any | None
) -> dict[str, str]:
    """Mark a backend-valid newly signed-up Free account as an offer candidate.

    OpenAI no longer consistently returns eligible_promo_campaigns. A signup
    claim plus an accepted Free account is useful for export, but remains a
    candidate until checkout confirms the exact discount and duration.
    """
    if promo_info.get("first_month_free_promo") == "yes":
        return promo_info
    if claim_sub != "free" or auth_state != "ok" or not jwt_is_signup(token):
        return promo_info

    signals: list[str] = ["jwt_is_signup"]
    for key, value in scalar_walk(data):
        tail = key.rsplit(".", 1)[-1].lower()
        if tail == "is_eligible_for_yearly_plus_new_user_subscription" and value is True:
            signals.append("yearly_plus_new_user_eligible")
        if "eligible_offers" in key.lower() and tail in ("id", "default_offer_id") and str(value).lower() == "chatgptplusplan":
            signals.append("plus_offer_available")

    out = dict(promo_info)
    out.update({
        "first_month_free_promo": "likely",
        "promo_plan": "chatgptplusplan",
        "promo_title": "新注册 Free：首月优惠候选，结账页最终确认",
        "promo_source": "+".join(dict.fromkeys(signals))[:160],
    })
    return out


def classify_account_usability(data: Any | None, auth_state: str) -> dict[str, str]:
    """Classify whether the supplied AT can access the account and obvious ban/deactivation flags."""
    out = {
        "account_usable": "unknown",
        "ban_state": "unknown",
        "usable_source": "",
    }
    if auth_state != "ok":
        out.update({
            "account_usable": "unknown",
            "ban_state": auth_state or "auth_failed",
            "usable_source": "auth_state",
        })
        return out
    if data is None:
        out.update({
            "account_usable": "yes",
            "ban_state": "not_banned",
            "usable_source": "auth_ok_no_account_json",
        })
        return out

    bad_path, bad_value = first_bool_by_tail(data, BAD_ACCOUNT_BOOL_TAILS)
    if bad_value is True:
        out.update({
            "account_usable": "no",
            "ban_state": bad_path.rsplit(".", 1)[-1],
            "usable_source": bad_path,
        })
        return out

    access_path, can_access = first_bool_by_tail(data, ("can_access_with_session",))
    if can_access is False:
        out.update({
            "account_usable": "no",
            "ban_state": "no_session_access",
            "usable_source": access_path,
        })
        return out

    status_path, status_text = first_text_by_tail(data, ("status", "account_status", "state", "user_status"))
    if status_text and any(word in status_text.lower() for word in BAD_ACCOUNT_TEXT_WORDS):
        out.update({
            "account_usable": "no",
            "ban_state": status_text[:120],
            "usable_source": status_path,
        })
        return out

    if can_access is True:
        out.update({
            "account_usable": "yes",
            "ban_state": "not_banned",
            "usable_source": access_path,
        })
        return out

    # Backend accepted the AT and no bad flags were found.
    out.update({
        "account_usable": "yes",
        "ban_state": "not_banned",
        "usable_source": "auth_ok_no_bad_flags",
    })
    return out


def classify_refresh_requirement(auth_state: str, claim_sub: str) -> dict[str, str]:
    if auth_state == "ok":
        return {
            "needs_fresh_login": "no",
            "refresh_reason": "backend_verified",
        }
    if auth_state in ("token_expired_or_revoked", "invalid_or_wrong_token", "forbidden"):
        return {
            "needs_fresh_login": "yes",
            "refresh_reason": f"{auth_state}; jwt_claim={claim_sub or 'unknown'}; subscription_not_verified",
        }
    return {
        "needs_fresh_login": "unknown",
        "refresh_reason": auth_state or "not_checked",
    }


def subscription_fallback_for_auth_failure(
    claim_sub: str,
    claim_raw_plan: str,
    auth_state: str,
    error_code: str = "",
    jwt_state: str = "",
) -> tuple[str, str, str, str]:
    """Keep JWT plan claims separate from backend token validity."""
    if (
        claim_sub == "free"
        and auth_state == "token_expired_or_revoked"
        and error_code == "token_expired"
        and jwt_state == "jwt_not_expired"
    ):
        return (
            "plus",
            "unexpired_free_jwt_revoked",
            "revoked_token_inferred_plus",
            "inferred_plus_from_unexpired_revoked_token",
        )
    if claim_sub != "unknown":
        if auth_state in ("token_expired_or_revoked", "invalid_or_wrong_token", "forbidden"):
            return claim_sub, claim_raw_plan, "jwt_claim_auth_failed", "jwt_claim_only_auth_failed"
        if auth_state in ("error", "rate_limited", "server_error"):
            return claim_sub, claim_raw_plan, "jwt_claim_fallback", "jwt_claim_only_backend_unavailable"
    return "unverified", "", "auth_failed", "unverified_auth_failed"


def classify_subscription(data: Any) -> tuple[str, str]:
    """Return (subscription, raw_plan). subscription is plus/free/pro/team/business/enterprise/paid_unknown/unknown."""
    authoritative_hits: list[tuple[str, str, str]] = []
    weak_hits: list[tuple[str, str, str]] = []
    paid_bool = False
    plus_bool = False
    explicit_free = False

    for key, value in scalar_walk(data):
        tail_l = key.rsplit(".", 1)[-1].lower()
        key_l = key.lower()
        segs = path_segments(key_l)
        ignored = is_ignored_plan_path(key_l)

        if isinstance(value, bool):
            # Strict boolean matching only. A field like
            # is_eligible_for_yearly_plus_subscription=True is only an offer flag,
            # not an active Plus subscription.
            if ignored:
                continue
            if value and (tail_l in PLUS_BOOL_KEYS or tail_l == "has_plus_subscription"):
                plus_bool = True
            if value and (tail_l in PAID_BOOL_KEYS or tail_l == "has_active_plus_subscription"):
                paid_bool = True
            if (not value) and tail_l in PAID_BOOL_KEYS:
                explicit_free = True
            continue
        if value is None:
            continue

        text = str(value).strip()
        if not text:
            continue
        if ignored:
            continue

        semantic_key = tail_l in PLAN_VALUE_KEYS or any(seg in PLAN_VALUE_KEYS for seg in segs)
        authoritative_key = (
            tail_l in AUTHORITATIVE_PLAN_TAILS
            or key_l.endswith(".account.plan_type")
            or key_l.endswith(".entitlement.subscription_plan")
        )

        sub_from_text, raw_from_text = plan_from_text(text)
        if sub_from_text != "unknown":
            if authoritative_key:
                authoritative_hits.append((sub_from_text, key, raw_from_text[:180]))
            elif semantic_key:
                weak_hits.append((sub_from_text, key, raw_from_text[:180]))

    # Account/entitlement fields are authoritative. Offer/promo fields are ignored.
    for word in ("plus", "pro", "team", "business", "enterprise", "paid_other", "free"):
        hit = next((v for w, _, v in authoritative_hits if w == word), "")
        if hit:
            return word, hit
    if plus_bool:
        return "plus", "plus:true"
    if paid_bool:
        return "paid_unknown", "paid:true"
    for word in ("plus", "pro", "team", "business", "enterprise", "paid_other", "free"):
        hit = next((v for w, _, v in weak_hits if w == word), "")
        if hit:
            return word, hit
    if explicit_free:
        return "free", "paid:false"
    return "unknown", "no-plan-marker"


def classify_jwt_claims(token: str) -> tuple[str, str, str, str, str]:
    """Return (subscription, raw_plan, account_id, email, source_path) from JWT payload claims."""
    payload = jwt_payload(token)
    if not payload:
        return "unknown", "", "", "", ""

    plan_candidates: list[tuple[str, str]] = []
    account_id = ""
    email = ""
    for key, value in scalar_walk(payload):
        tail = key.rsplit(".", 1)[-1].lower()
        if tail in ("chatgpt_account_id", "account_id") and value:
            account_id = str(value)[:100]
        if tail in ("email", "email_address") and value:
            email = str(value)[:160]
        if tail in ("chatgpt_plan_type", "plan_type", "subscription_plan", "account_plan", "plan") and value:
            plan_candidates.append((key, str(value)))

    for path, raw in plan_candidates:
        sub, raw_plan = classify_subscription({path: raw})
        if sub != "unknown":
            return sub, raw_plan, account_id, email, path
    return "unknown", "", account_id, email, ""


def jwt_metadata(token: str) -> dict[str, str]:
    now = dt.datetime.now(dt.timezone.utc)
    out = {
        "jwt_alg": "", "jwt_iss": "", "jwt_aud": "", "jwt_exp_utc": "",
        "jwt_state": "decode_error", "jwt_scope_hint": "",
    }
    try:
        parts = token.split(".")
        header = b64url_json(parts[0])
        payload = jwt_payload(token)
        out["jwt_alg"] = str(header.get("alg", ""))[:30]
        out["jwt_iss"] = str(payload.get("iss", ""))[:120]
        aud = payload.get("aud", "")
        if isinstance(aud, list):
            out["jwt_aud"] = ";".join(map(str, aud))[:200]
        else:
            out["jwt_aud"] = str(aud)[:200]
        scope = payload.get("scope") or payload.get("scp") or ""
        if isinstance(scope, list):
            out["jwt_scope_hint"] = ",".join(map(str, scope[:8]))[:220]
        else:
            out["jwt_scope_hint"] = str(scope)[:220]
        exp = payload.get("exp")
        if isinstance(exp, (int, float)):
            exp_dt = dt.datetime.fromtimestamp(exp, dt.timezone.utc)
            out["jwt_exp_utc"] = exp_dt.isoformat()
            out["jwt_state"] = "jwt_expired" if exp_dt <= now else "jwt_not_expired"
        else:
            out["jwt_state"] = "jwt_no_exp"
    except Exception:
        pass
    return out


def parse_error_body(status: int, body: str) -> tuple[str, str]:
    code = ""
    msg = ""
    text = body.strip()
    try:
        obj = json.loads(text)
        err = obj.get("error") if isinstance(obj, dict) else None
        detail = obj.get("detail") if isinstance(obj, dict) else None
        if isinstance(err, dict):
            code = str(err.get("code") or err.get("type") or "")
            msg = str(err.get("message") or "")
        elif isinstance(detail, dict):
            code = str(detail.get("code") or "")
            msg = str(detail.get("message") or detail)
        elif isinstance(obj, dict):
            code = str(obj.get("code") or obj.get("status") or "")
            msg = str(obj.get("message") or obj.get("error") or obj)[:400]
    except Exception:
        pass
    if not msg:
        msg = text[:400]
    if not code:
        low = msg.lower()
        if "expired" in low:
            code = "token_expired"
        elif "invalid" in low:
            code = "invalid_token"
        elif status == 429:
            code = "rate_limited"
        elif status >= 500:
            code = "server_error"
        elif status == 403:
            code = "forbidden"
        elif status == 401:
            code = "unauthorized"
    return code[:80], msg.replace("\r", " ").replace("\n", " ")[:400]


def make_headers(token: str, extra_headers: dict[str, str] | None = None) -> dict[str, str]:
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/134.0.0.0 Safari/537.36",
        "Origin": CHATGPT_ORIGIN,
        "Referer": CHATGPT_ORIGIN + "/",
    }
    if extra_headers:
        headers.update(extra_headers)
    return headers


def http_json(name: str, method: str, url: str, payload: Any, token: str, timeout: float, extra_headers: dict[str, str] | None = None) -> EndpointResult:
    started = time.perf_counter()
    body_bytes = None
    if payload is not None:
        body_bytes = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    req = urllib.request.Request(url, data=body_bytes, headers=make_headers(token, extra_headers), method=method)
    try:
        with _open_http(req, timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            elapsed = int((time.perf_counter() - started) * 1000)
            if not raw.strip():
                return EndpointResult(name, method, url, resp.status, None, "", "", elapsed)
            try:
                return EndpointResult(name, method, url, resp.status, json.loads(raw), "", "", elapsed)
            except json.JSONDecodeError:
                return EndpointResult(name, method, url, resp.status, None, "non_json", raw[:300], elapsed)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        code, msg = parse_error_body(e.code, raw)
        elapsed = int((time.perf_counter() - started) * 1000)
        return EndpointResult(name, method, url, e.code, None, code, msg, elapsed)
    except Exception as e:
        elapsed = int((time.perf_counter() - started) * 1000)
        message = str(e).replace("\r", " ").replace("\n", " ")[:300]
        error_code = "network_error"
        local_proxy = ""
        for proxy_url in urllib.request.getproxies().values():
            try:
                parsed = urllib.parse.urlsplit(proxy_url)
                if parsed.hostname in ("127.0.0.1", "localhost", "::1"):
                    local_proxy = f"{parsed.hostname}:{parsed.port or 80}"
                    break
            except Exception:
                continue
        lower_message = message.lower()
        if local_proxy and (
            "10061" in lower_message
            or "refused" in lower_message
            or "积极拒绝" in message
        ):
            error_code = "proxy_unavailable"
            message = f"本地代理 {local_proxy} 未运行或拒绝连接"
        elif "timed out" in lower_message or "timeout" in lower_message:
            error_code = "timeout"
        return EndpointResult(name, method, url, 0, None, error_code, message, elapsed)


def auth_state_from_results(results: list[EndpointResult]) -> tuple[str, EndpointResult | None]:
    if not results:
        return "not_checked", None
    account_results = [r for r in results if r.name in ACCOUNT_AUTH_ENDPOINTS]
    account_ok = next((r for r in account_results if 200 <= r.status < 300), None)
    if account_ok:
        return "ok", account_ok
    account_codes = {r.error_code for r in account_results if r.error_code}
    account_statuses = {r.status for r in account_results}
    if "token_expired" in account_codes:
        return "token_expired_or_revoked", next((r for r in account_results if r.error_code == "token_expired"), account_results[0])
    if "invalid_token" in account_codes or "unauthorized" in account_codes or account_statuses == {401}:
        return "invalid_or_wrong_token", next((r for r in account_results if r.status == 401), account_results[0])
    if 403 in account_statuses:
        return "forbidden", next((r for r in account_results if r.status == 403), account_results[0])

    ok = next((r for r in results if 200 <= r.status < 300), None)
    if ok:
        return "ok", ok
    codes = {r.error_code for r in results if r.error_code}
    statuses = {r.status for r in results}
    if "token_expired" in codes:
        return "token_expired_or_revoked", next((r for r in results if r.error_code == "token_expired"), results[0])
    if "invalid_token" in codes or "unauthorized" in codes or statuses == {401}:
        return "invalid_or_wrong_token", results[0]
    if 403 in statuses:
        return "forbidden", next((r for r in results if r.status == 403), results[0])
    if 429 in statuses:
        return "rate_limited", next((r for r in results if r.status == 429), results[0])
    if any(s >= 500 for s in statuses):
        return "server_error", next((r for r in results if r.status >= 500), results[0])
    return "error", results[0]


def endpoint_rank(name: str) -> int:
    ranks = {
        "accounts_check_v4_tz": 1,
        "accounts_check_v4": 2,
        "optimized_check": 3,
        "billing_config": 4,
        "settings_user": 5,
        "me": 6,
        "models": 20,
        "accounts_check": 30,
    }
    return ranks.get(name, 50)


def check_one(
    item: TokenItem,
    endpoints: list[tuple[str, str, str, Any]],
    timeout: float,
    raw_dir: Path | None = None,
    retries: int = 0,
    extra_headers: dict[str, str] | None = None,
    probe_all: bool = False,
) -> tuple[dict[str, str], list[dict[str, Any]]]:
    th = token_hash(item.token)
    meta = jwt_metadata(item.token)
    claim_sub, claim_raw_plan, claim_account_id, claim_email, claim_source = classify_jwt_claims(item.token)
    results: list[EndpointResult] = []
    best_data: Any = None
    best_result: EndpointResult | None = None
    sub = "unknown"
    raw_plan = ""
    subscription_source = ""
    subscription_confidence = ""

    for name, method, url, payload in endpoints:
        r: EndpointResult | None = None
        for attempt in range(retries + 1):
            r = http_json(name, method, url, payload, item.token, timeout, extra_headers)
            # Retry only transient states.
            if r.status not in (0, 408, 409, 425, 429, 500, 502, 503, 504):
                break
            if attempt < retries:
                time.sleep(0.6 * (attempt + 1))
        assert r is not None
        results.append(r)
        if 200 <= r.status < 300 and r.data is not None:
            maybe_sub, maybe_raw = classify_subscription(r.data)
            # Prefer account endpoints because they carry entitlement fields.
            should_take_plan = (
                maybe_sub != "unknown"
                and (
                    sub == "unknown"
                    or best_result is None
                    or endpoint_rank(name) < endpoint_rank(best_result.name)
                )
            )
            should_keep_body = best_data is None and (name.startswith("accounts") or name.startswith("optimized"))
            if should_take_plan or should_keep_body:
                best_data = r.data
                best_result = r
                if maybe_sub != "unknown":
                    sub, raw_plan = maybe_sub, maybe_raw
                if not probe_all and maybe_sub != "unknown":
                    break

    auth_state, auth_result = auth_state_from_results(results)
    if auth_state != "ok":
        sub, raw_plan, subscription_source, subscription_confidence = subscription_fallback_for_auth_failure(
            claim_sub,
            claim_raw_plan,
            auth_state,
            auth_result.error_code if auth_result else "",
            meta.get("jwt_state", ""),
        )
    elif sub != "unknown":
        subscription_source = best_result.name if best_result else "backend"
        subscription_confidence = "backend_verified"
    elif sub == "unknown" and best_data is None:
        # Some diagnostic endpoints can be OK without plan info.
        ok_json = next((r for r in results if 200 <= r.status < 300 and r.data is not None), None)
        if ok_json:
            best_data = ok_json.data
            best_result = ok_json
        if claim_sub != "unknown":
            sub = claim_sub
            raw_plan = claim_raw_plan
            subscription_source = "jwt_claim"
            subscription_confidence = "jwt_claim_only"
    elif claim_sub != "unknown":
        sub = claim_sub
        raw_plan = claim_raw_plan
        subscription_source = "jwt_claim"
        subscription_confidence = "jwt_claim_only"

    if best_data is not None and raw_dir:
        raw_dir.mkdir(parents=True, exist_ok=True)
        safe_label = re.sub(r"[^A-Za-z0-9_.@-]+", "_", item.label)[:80] or f"line{item.line_no}"
        (raw_dir / f"{safe_label}_{th}_{best_result.name if best_result else 'ok'}.json").write_text(
            json.dumps(best_data, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    chosen = best_result or auth_result or (results[-1] if results else None)
    promo_info = classify_first_month_free_promo(best_data)
    promo_info = classify_signup_promo_candidate(promo_info, item.token, claim_sub, auth_state, best_data)
    usability_info = classify_account_usability(best_data, auth_state)
    refresh_info = classify_refresh_requirement(auth_state, claim_sub)
    row = {
        "label": item.label,
        "line_no": str(item.line_no),
        "token_hash": th,
        **meta,
        "claim_subscription": claim_sub,
        "claim_raw_plan": claim_raw_plan,
        "claim_source": claim_source,
        "auth_state": auth_state,
        "http_status": str(chosen.status if chosen else 0),
        "subscription": sub,
        "subscription_confidence": subscription_confidence or ("backend_verified" if auth_state == "ok" else "unverified_auth_failed"),
        "subscription_source": subscription_source,
        "raw_plan": raw_plan,
        "expires_at": find_subscription_expiry(best_data) if best_data is not None else "",
        **promo_info,
        **usability_info,
        **refresh_info,
        "account_id": (find_account_id(best_data) if best_data is not None else "") or claim_account_id,
        "email": (find_email(best_data) if best_data is not None else "") or claim_email,
        "source_endpoint": chosen.name if chosen else "",
        "error_code": chosen.error_code if chosen else "",
        "error": chosen.error_message if chosen else "",
    }
    diag = [
        {
            "label": item.label,
            "token_hash": th,
            "endpoint": r.name,
            "method": r.method,
            "url": r.url,
            "status": r.status,
            "error_code": r.error_code,
            "error": r.error_message,
            "elapsed_ms": r.elapsed_ms,
        }
        for r in results
    ]
    return row, diag


def write_csv(rows: list[dict[str, str]], out_path: Path) -> None:
    fields = [
        "label", "line_no", "token_hash",
        "jwt_state", "jwt_exp_utc", "jwt_iss", "jwt_aud", "jwt_scope_hint", "jwt_alg",
        "claim_subscription", "claim_raw_plan", "claim_source",
        "auth_state", "http_status", "subscription", "subscription_confidence", "subscription_source", "raw_plan", "expires_at",
        "first_month_free_promo", "promo_id", "promo_plan", "promo_title", "promo_discount", "promo_duration", "promo_source",
        "account_usable", "ban_state", "usable_source",
        "needs_fresh_login", "refresh_reason",
        "account_id", "email", "source_endpoint", "error_code", "error",
    ]
    with out_path.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        for row in rows:
            w.writerow(row)


def write_diag(diag_rows: list[dict[str, Any]], path: Path) -> None:
    fields = ["label", "token_hash", "endpoint", "method", "status", "error_code", "error", "elapsed_ms", "url"]
    with path.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        for row in diag_rows:
            w.writerow(row)


def make_fake_jwt(payload: dict[str, Any]) -> str:
    def enc(obj: Any) -> str:
        raw = json.dumps(obj, separators=(",", ":")).encode()
        return base64.urlsafe_b64encode(raw).decode().rstrip("=")
    return enc({"alg": "RS256", "typ": "JWT"}) + "." + enc(payload) + "." + "x" * 43


def self_test() -> int:
    future = int((dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=1)).timestamp())
    fake = make_fake_jwt({
        "iss": "https://auth.openai.com",
        "aud": ["https://api.openai.com/v1"],
        "exp": future,
        "scope": ["openid"],
        "https://api.openai.com/auth": {
            "chatgpt_account_id": "acc_test",
            "chatgpt_plan_type": "free",
            "is_signup": True,
        },
        "https://api.openai.com/profile": {
            "email": "user@example.com",
        },
    })
    parsed = parse_token_line(f"user@example.com----pw----{fake}", 1)
    assert parsed and parsed.label == "user@example.com" and parsed.token == fake
    claim_sub, claim_raw, claim_acc, claim_email, claim_source = classify_jwt_claims(fake)
    assert (claim_sub, claim_raw, claim_acc, claim_email, claim_source) == (
        "free", "free", "acc_test", "user@example.com", "https://api.openai.com/auth.chatgpt_plan_type"
    )
    cases = [
        ({"accounts": {"default": {"entitlement": {"subscription_plan": "chatgptplusplan", "has_active_subscription": True}}}}, "plus"),
        ({"account_plan": {"is_paid_subscription_active": True, "subscription_plan": "chatgptplusplan"}}, "plus"),
        ({"accounts": {"default": {"entitlement": {"subscription_plan": "chatgptfreeplan", "has_active_subscription": False}}}}, "free"),
        ({
            "accounts": {
                "default": {
                    "account": {
                        "plan_type": "free",
                        "is_eligible_for_yearly_plus_new_user_subscription": True,
                    },
                    "entitlement": {
                        "has_active_subscription": False,
                        "subscription_plan": "chatgptfreeplan",
                    },
                    "eligible_promo_campaigns": {
                        "plus": {"metadata": {"plan_name": "chatgptplusplan"}}
                    },
                    "eligible_offers": {
                        "default_offer_id": "chatgptplusplan",
                        "offers": [{"id": "chatgptplusplan"}, {"id": "chatgptpro"}],
                    },
                }
            }
        }, "free"),
        ({"user": {"plan": "free"}, "has_paid_subscription": False}, "free"),
        ({"account": {"subscription_tier": "pro"}}, "pro"),
        ({"account": {"has_active_subscription": True}}, "paid_unknown"),
    ]
    for data, expected in cases:
        got, raw = classify_subscription(data)
        print(f"expected={expected:12s} got={got:12s} raw={raw}")
        if got != expected:
            return 1
    promo_fixture = {
        "accounts": {
            "default": {
                "account": {"is_deactivated": False},
                "can_access_with_session": True,
                "eligible_promo_campaigns": {
                    "plus": {
                        "id": "plus-1-month-free",
                        "metadata": {
                            "plan_name": "chatgptplusplan",
                            "title": "Try Plus free for 1 month",
                            "discount": {"percentage": 100},
                            "duration": {"num_periods": 1, "period": "month"},
                        },
                    }
                },
            }
        }
    }
    promo = classify_first_month_free_promo(promo_fixture)
    usable = classify_account_usability(promo_fixture, "ok")
    assert promo["first_month_free_promo"] == "yes", promo
    candidate_fixture = {
        "accounts": {
            "default": {
                "is_eligible_for_yearly_plus_new_user_subscription": True,
                "eligible_offers": {
                    "default_offer_id": "chatgptplusplan",
                    "offers": [{"id": "chatgptplusplan"}],
                },
            }
        }
    }
    candidate = classify_signup_promo_candidate(
        classify_first_month_free_promo(candidate_fixture), fake, "free", "ok", candidate_fixture
    )
    assert candidate["first_month_free_promo"] == "likely", candidate
    assert usable["account_usable"] == "yes" and usable["ban_state"] == "not_banned", usable
    banned = classify_account_usability({"account": {"is_deactivated": True}}, "ok")
    assert banned["account_usable"] == "no" and banned["ban_state"] == "is_deactivated", banned
    failed_free = subscription_fallback_for_auth_failure("free", "free", "invalid_or_wrong_token")
    assert failed_free == ("free", "free", "jwt_claim_auth_failed", "jwt_claim_only_auth_failed"), failed_free
    failed_plus = subscription_fallback_for_auth_failure("plus", "chatgptplusplan", "token_expired_or_revoked")
    assert failed_plus[0] == "plus" and failed_plus[2] == "jwt_claim_auth_failed", failed_plus
    inferred_plus = subscription_fallback_for_auth_failure(
        "free", "free", "token_expired_or_revoked", "token_expired", "jwt_not_expired"
    )
    assert inferred_plus[0] == "plus" and inferred_plus[2] == "revoked_token_inferred_plus", inferred_plus
    invalidated_free = subscription_fallback_for_auth_failure(
        "free", "free", "invalid_or_wrong_token", "token_invalidated", "jwt_not_expired"
    )
    assert invalidated_free[0] == "free" and invalidated_free[2] == "jwt_claim_auth_failed", invalidated_free
    account_expired = EndpointResult("accounts_check_v4_tz", "GET", "fixture", 401, None, "token_expired", "expired", 1)
    weak_ok = EndpointResult("models", "GET", "fixture", 200, {}, "", "", 1)
    mixed_auth = auth_state_from_results([account_expired, weak_ok])
    assert mixed_auth[0] == "token_expired_or_revoked" and mixed_auth[1] == account_expired, mixed_auth
    print("parse=ok jwt=ok")
    return 0


def parse_header_args(values: list[str] | None) -> dict[str, str]:
    headers: dict[str, str] = {}
    for v in values or []:
        if ":" not in v:
            raise SystemExit(f"bad --header, expected 'Name: value': {v}")
        k, val = v.split(":", 1)
        headers[k.strip()] = val.strip()
    return headers


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Batch-check ChatGPT Plus/Free status from access tokens")
    ap.add_argument("-i", "--input", default="tokens.txt", help="token file, default: tokens.txt")
    ap.add_argument("-o", "--output", default="subscription_status.csv", help="CSV output, default: subscription_status.csv")
    ap.add_argument("--diag-output", default="endpoint_probe.csv", help="endpoint matrix CSV, default: endpoint_probe.csv")
    ap.add_argument("--endpoint", action="append", help="custom endpoint URL; can repeat; overrides default endpoint list")
    ap.add_argument("--header", action="append", help="extra HTTP header, e.g. 'OAI-Device-Id: <uuid>'; can repeat")
    ap.add_argument("--timeout", type=float, default=20.0, help="request timeout seconds")
    ap.add_argument("--concurrency", type=int, default=4, help="parallel accounts, keep low")
    ap.add_argument("--retries", type=int, default=1, help="retry count for transient errors")
    ap.add_argument("--probe-all", action="store_true", help="probe every endpoint even after a successful plan hit")
    ap.add_argument("--raw-dir", help="optional directory to save raw successful JSON responses")
    ap.add_argument("--self-test", action="store_true", help="run offline parser/classifier tests")
    args = ap.parse_args(argv)

    if args.self_test:
        return self_test()

    in_path = Path(args.input).expanduser().resolve()
    out_path = Path(args.output).expanduser().resolve()
    diag_path = Path(args.diag_output).expanduser().resolve()
    raw_dir = Path(args.raw_dir).expanduser().resolve() if args.raw_dir else None
    endpoints = [(f"custom_{i+1}", "GET", url, None) for i, url in enumerate(args.endpoint)] if args.endpoint else DEFAULT_ENDPOINTS
    concurrency = max(1, min(args.concurrency, 20))
    extra_headers = parse_header_args(args.header)

    items = load_tokens(in_path)
    rows: list[dict[str, str]] = []
    diag_rows: list[dict[str, Any]] = []

    print(f"loaded={len(items)} endpoints={len(endpoints)} concurrency={concurrency} output={out_path}", file=sys.stderr)
    with ThreadPoolExecutor(max_workers=concurrency) as ex:
        futs = [ex.submit(check_one, item, endpoints, args.timeout, raw_dir, args.retries, extra_headers, args.probe_all) for item in items]
        for fut in as_completed(futs):
            row, diag = fut.result()
            rows.append(row)
            diag_rows.extend(diag)
            print(
                f"{row['label']} {row['token_hash']} auth={row['auth_state']} sub={row['subscription']} "
                f"http={row['http_status']} err={row['error_code']}",
                file=sys.stderr,
            )

    rows.sort(key=lambda r: (int(r.get("line_no") or 0), r.get("label", "")))
    write_csv(rows, out_path)
    write_diag(diag_rows, diag_path)

    summary: dict[str, int] = {}
    for r in rows:
        key = f"{r['auth_state']}/{r['subscription']}"
        summary[key] = summary.get(key, 0) + 1
    print("summary=" + json.dumps(summary, ensure_ascii=False), file=sys.stderr)
    print(str(out_path))
    print(str(diag_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
