import base64
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


SERVER_DIR = Path(__file__).resolve().parents[1] / "server"
sys.path.insert(0, str(SERVER_DIR))

import subscription_bridge as bridge  # noqa: E402


def encode_part(value):
    raw = json.dumps(value, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def sample_token(account_id="acct-test"):
    header = encode_part({"alg": "RS256", "typ": "JWT"})
    payload = encode_part({
        "https://api.openai.com/auth": {
            "chatgpt_plan_type": "free",
            "chatgpt_account_id": account_id,
            "is_signup": True,
        },
        "https://api.openai.com/profile": {"email": "test@example.com"},
        "exp": 4102444800,
    })
    return f"{header}.{payload}.signature"


def transient_then_success():
    calls = {}

    def fake_check_one(item, endpoints, timeout, raw_dir, retries, extra_headers, probe_all):
        token_hash = bridge.checker.token_hash(item.token)
        calls[token_hash] = calls.get(token_hash, 0) + 1
        common = {
            "label": item.label,
            "line_no": str(item.line_no),
            "token_hash": token_hash,
            "email": "test@example.com",
            "claim_subscription": "free",
            "subscription": "free",
            "needs_fresh_login": "no",
        }
        if calls[token_hash] == 1:
            return ({
                **common,
                "auth_state": "error",
                "account_usable": "unknown",
                "first_month_free_promo": "unknown",
                "error_code": "network_error",
            }, [])
        return ({
            **common,
            "auth_state": "ok",
            "account_usable": "yes",
            "first_month_free_promo": "likely",
            "error_code": "",
        }, [])

    return calls, fake_check_one


class SubscriptionBridgeRetryTests(unittest.TestCase):
    def test_batch_plus_inference_requires_a_revoked_cohort(self):
        candidate = {
            "subscription": "free",
            "claim_subscription": "free",
            "jwt_state": "jwt_not_expired",
            "needs_fresh_login": "yes",
            "auth_state": "invalid_or_wrong_token",
            "account_usable": "unknown",
            "subscription_source": "jwt_claim_auth_failed",
        }
        isolated = bridge.apply_batch_plus_inference([dict(candidate)])
        self.assertEqual(isolated[0]["subscription"], "free")

        cohort = bridge.apply_batch_plus_inference([dict(candidate), dict(candidate)])
        self.assertEqual([row["subscription"] for row in cohort], ["plus", "plus"])
        self.assertTrue(all(row["subscription_source"] == "batch_revoked_token_inferred_plus" for row in cohort))

    def test_probe_all_batch_retries_transient_account(self):
        calls, fake_check_one = transient_then_success()
        with patch.object(bridge.checker, "check_one", side_effect=fake_check_one):
            result = bridge.run_check({
                "text": sample_token(),
                "probe_all": True,
                "concurrency": 1,
                "timeout": 3,
            })

        self.assertEqual(result["retry_count"], 1)
        self.assertEqual(result["extra_summary"]["account_usable_yes"], 1)
        self.assertEqual(result["extra_summary"]["free_first_month_promo_candidate"], 1)
        self.assertEqual(next(iter(calls.values())), 2)

    def test_probe_all_stream_retries_before_progress(self):
        calls, fake_check_one = transient_then_success()
        events = []
        with patch.object(bridge.checker, "check_one", side_effect=fake_check_one):
            result = bridge.run_check_stream({
                "text": sample_token(),
                "probe_all": True,
                "concurrency": 1,
                "timeout": 3,
            }, events.append)

        progress = next(event for event in events if event["type"] == "progress")
        self.assertEqual(progress["row"]["account_usable"], "yes")
        self.assertEqual(progress["row"]["first_month_free_promo"], "likely")
        self.assertEqual(result["retry_count"], 1)
        self.assertEqual(next(iter(calls.values())), 2)

    def test_stream_isolates_worker_exception_and_still_returns_result(self):
        def failing_check_one(item, endpoints, timeout, raw_dir, retries, extra_headers, probe_all):
            raise RuntimeError("fixture worker failure")

        events = []
        with patch.object(bridge.checker, "check_one", side_effect=failing_check_one):
            result = bridge.run_check_stream({
                "text": sample_token(),
                "concurrency": 1,
                "timeout": 3,
            }, events.append)

        self.assertEqual(result["rows"][0]["error_code"], "worker_exception")
        self.assertEqual(result["rows"][0]["error"], "fixture worker failure")
        self.assertEqual(result["rows"][0]["account_usable"], "unknown")
        self.assertEqual(events[-1]["type"], "result")


if __name__ == "__main__":
    unittest.main()
