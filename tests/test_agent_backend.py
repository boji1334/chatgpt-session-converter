from __future__ import annotations

import base64
import http.client
import importlib.util
import json
import pathlib
import threading
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "server" / "agent_backend.py"
SPEC = importlib.util.spec_from_file_location("agent_backend", MODULE_PATH)
assert SPEC and SPEC.loader
agent_backend = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(agent_backend)


def public_key_fixture() -> str:
    algorithm = b"ssh-ed25519"
    key = bytes(range(32))
    blob = len(algorithm).to_bytes(4, "big") + algorithm + len(key).to_bytes(4, "big") + key
    return "ssh-ed25519 " + base64.b64encode(blob).decode()


class FakeResponse:
    status_code = 200

    @staticmethod
    def json():
        return {"agent_runtime_id": "runtime-python-fixture"}


class AgentBackendTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.original_post = agent_backend.requests.post
        cls.calls = []

        def fake_post(url, **kwargs):
            cls.calls.append((url, kwargs))
            return FakeResponse()

        agent_backend.requests.post = fake_post
        agent_backend.ALLOWED_ORIGINS = {"https://boji1334.github.io"}
        agent_backend.RATE_LIMIT_MAX = 1000
        cls.server = agent_backend.ThreadingHTTPServer(("127.0.0.1", 0), agent_backend.AgentBackendHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.port = cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)
        agent_backend.requests.post = cls.original_post

    def request(self, method, path, payload=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        body = None if payload is None else json.dumps(payload)
        headers = {"Origin": "https://boji1334.github.io"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        data = json.loads(response.read()) if response.status != 204 else None
        connection.close()
        return response.status, data

    def test_health(self):
        status, payload = self.request("GET", "/healthz")
        self.assertEqual(status, 200)
        self.assertEqual(payload["service"], "chatgpt-session-converter-agent")

    def test_registration_matches_original_script_request(self):
        status, payload = self.request(
            "POST",
            "/api/agent/register",
            {"access_token": "header.payload.signature", "agent_public_key": public_key_fixture()},
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload["agent_runtime_id"], "runtime-python-fixture")
        url, kwargs = self.calls[-1]
        self.assertEqual(url, "https://auth.openai.com/api/accounts/v1/agent/register")
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer header.payload.signature")
        self.assertEqual(kwargs["json"]["abom"]["agent_harness_id"], "codex-cli")
        self.assertEqual(kwargs["json"]["agent_public_key"], public_key_fixture())
        self.assertEqual(kwargs["impersonate"], "chrome")

    def test_invalid_request_does_not_call_upstream(self):
        before = len(self.calls)
        status, payload = self.request("POST", "/api/agent/register", {})
        self.assertEqual(status, 400)
        self.assertIn("access_token", payload["error"])
        self.assertEqual(len(self.calls), before)


if __name__ == "__main__":
    unittest.main()
