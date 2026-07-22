"""Agent Identity registration backend derived from codex_agent(2).py.

The browser generates the Ed25519 key pair and keeps the private key local.
This service receives only the ChatGPT access token and SSH public key, then
uses curl_cffi's Chrome impersonation to register the Agent Runtime.
"""

from __future__ import annotations

import base64
import binascii
import json
import os
import re
import threading
import time
from collections import defaultdict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlsplit

from curl_cffi import requests


AUTHAPI_BASE = os.getenv("AUTHAPI_BASE", "https://auth.openai.com/api/accounts").rstrip("/")
IMPERSONATE = os.getenv("IMPERSONATE", "chrome")
AGENT_VERSION = os.getenv("AGENT_VERSION", "0.138.0-alpha.6")
AGENT_HARNESS_ID = os.getenv("AGENT_HARNESS_ID", "codex-cli")
RUNNING_LOCATION = os.getenv("AGENT_RUNNING_LOCATION", "local")

HOST = os.getenv("AGENT_HOST", "127.0.0.1")
PORT = int(os.getenv("AGENT_PORT", "8788"))
REQUEST_TIMEOUT_SECONDS = float(os.getenv("AGENT_REQUEST_TIMEOUT_SECONDS", "15"))
MAX_BODY_BYTES = int(os.getenv("AGENT_MAX_BODY_BYTES", str(256 * 1024)))
RATE_LIMIT_MAX = int(os.getenv("AGENT_RATE_LIMIT_MAX", "30"))
RATE_LIMIT_WINDOW_SECONDS = int(os.getenv("AGENT_RATE_LIMIT_WINDOW_SECONDS", "60"))

DEFAULT_ALLOWED_ORIGINS = (
    "https://boji1334.github.io,http://localhost:4173,http://127.0.0.1:4173"
)
ALLOWED_ORIGINS = {
    origin.strip()
    for origin in os.getenv("ALLOWED_ORIGINS", DEFAULT_ALLOWED_ORIGINS).split(",")
    if origin.strip()
}

JWT_PATTERN = re.compile(r"^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$")
_rate_limit_lock = threading.Lock()
_rate_limit_hits: dict[str, deque[float]] = defaultdict(deque)


class AgentBackendError(RuntimeError):
    def __init__(self, status: int, message: str, upstream_status: int | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.message = message
        self.upstream_status = upstream_status


def normalize_access_token(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    token = value.strip()
    if token.lower().startswith("bearer "):
        token = token[7:].strip()
    return token


def valid_access_token(token: str) -> bool:
    return bool(token and len(token) <= 32_768 and JWT_PATTERN.fullmatch(token))


def valid_ed25519_ssh_public_key(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    parts = value.strip().split()
    if len(parts) != 2 or parts[0] != "ssh-ed25519":
        return False
    try:
        blob = base64.b64decode(parts[1], validate=True)
    except (binascii.Error, ValueError):
        return False

    def read_field(offset: int) -> tuple[bytes, int] | None:
        if offset + 4 > len(blob):
            return None
        size = int.from_bytes(blob[offset : offset + 4], "big")
        start = offset + 4
        end = start + size
        if end > len(blob):
            return None
        return blob[start:end], end

    algorithm_field = read_field(0)
    if algorithm_field is None:
        return False
    algorithm, offset = algorithm_field
    public_key_field = read_field(offset)
    if public_key_field is None:
        return False
    public_key, offset = public_key_field
    return algorithm == b"ssh-ed25519" and len(public_key) == 32 and offset == len(blob)


def register_agent(access_token: str, public_key_ssh: str) -> str:
    """Register an Agent Runtime using the request shape from codex_agent(2).py."""
    try:
        response = requests.post(
            f"{AUTHAPI_BASE}/v1/agent/register",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {access_token}",
            },
            json={
                "abom": {
                    "agent_version": AGENT_VERSION,
                    "agent_harness_id": AGENT_HARNESS_ID,
                    "running_location": RUNNING_LOCATION,
                },
                "agent_public_key": public_key_ssh,
            },
            impersonate=IMPERSONATE,
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
    except Exception as error:
        raise AgentBackendError(502, "连接 OpenAI Agent 注册服务失败") from error

    if response.status_code != 200:
        status = response.status_code if 400 <= response.status_code < 500 else 502
        messages = {
            401: "AT 已失效或当前账号不能注册 Agent Runtime",
            403: "OpenAI 拒绝了 Agent Runtime 注册请求",
            429: "OpenAI Agent 注册请求过于频繁",
        }
        raise AgentBackendError(
            status,
            messages.get(response.status_code, "OpenAI Agent Runtime 注册失败"),
            upstream_status=response.status_code,
        )

    try:
        payload = response.json()
    except Exception as error:
        raise AgentBackendError(502, "OpenAI Agent 注册响应不是有效 JSON") from error

    runtime_id = payload.get("agent_runtime_id") if isinstance(payload, dict) else None
    if not isinstance(runtime_id, str) or not runtime_id.strip():
        raise AgentBackendError(502, "OpenAI Agent 注册响应缺少 agent_runtime_id")
    return runtime_id.strip()


def client_ip(handler: BaseHTTPRequestHandler) -> str:
    forwarded = handler.headers.get("X-Forwarded-For", "").split(",", 1)[0].strip()
    return forwarded or handler.client_address[0]


def rate_limit_allows(ip_address: str) -> bool:
    if RATE_LIMIT_MAX <= 0:
        return True
    now = time.monotonic()
    cutoff = now - RATE_LIMIT_WINDOW_SECONDS
    with _rate_limit_lock:
        hits = _rate_limit_hits[ip_address]
        while hits and hits[0] <= cutoff:
            hits.popleft()
        if len(hits) >= RATE_LIMIT_MAX:
            return False
        hits.append(now)
        return True


class AgentBackendHandler(BaseHTTPRequestHandler):
    server_version = "ChatGPTSessionConverterAgent/1.0"

    def log_message(self, format_string: str, *args: Any) -> None:
        # BaseHTTPRequestHandler logs method/path/status only; request bodies and
        # authorization values are intentionally never logged.
        super().log_message(format_string, *args)

    def allowed_origin(self) -> str | None:
        origin = self.headers.get("Origin", "").strip()
        if not origin:
            return None
        return origin if origin in ALLOWED_ORIGINS else ""

    def send_json(self, status: int, payload: dict[str, Any], origin: str | None = None) -> None:
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(encoded)

    def do_OPTIONS(self) -> None:
        origin = self.allowed_origin()
        if origin == "":
            self.send_json(403, {"ok": False, "error": "来源未加入允许列表"})
            return
        if urlsplit(self.path).path != "/api/agent/register":
            self.send_json(404, {"ok": False, "error": "Not found"}, origin)
            return
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.end_headers()

    def do_GET(self) -> None:
        origin = self.allowed_origin()
        if origin == "":
            self.send_json(403, {"ok": False, "error": "来源未加入允许列表"})
            return
        if urlsplit(self.path).path == "/healthz":
            self.send_json(
                200,
                {"ok": True, "service": "chatgpt-session-converter-agent", "upstream": "auth.openai.com"},
                origin,
            )
            return
        self.send_json(404, {"ok": False, "error": "Not found"}, origin)

    def do_POST(self) -> None:
        origin = self.allowed_origin()
        if origin == "":
            self.send_json(403, {"ok": False, "error": "来源未加入允许列表"})
            return
        if urlsplit(self.path).path != "/api/agent/register":
            self.send_json(404, {"ok": False, "error": "Not found"}, origin)
            return
        if not rate_limit_allows(client_ip(self)):
            self.send_json(429, {"ok": False, "error": "请求过于频繁，请稍后再试"}, origin)
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            content_length = 0
        if content_length <= 0 or content_length > MAX_BODY_BYTES:
            self.send_json(400, {"ok": False, "error": "请求体为空或过大"}, origin)
            return

        try:
            body = json.loads(self.rfile.read(content_length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.send_json(400, {"ok": False, "error": "请求体不是有效 JSON"}, origin)
            return
        if not isinstance(body, dict):
            self.send_json(400, {"ok": False, "error": "请求体必须是 JSON 对象"}, origin)
            return

        access_token = normalize_access_token(body.get("access_token", body.get("accessToken")))
        public_key = body.get("agent_public_key", body.get("agentPublicKey"))
        if not valid_access_token(access_token):
            self.send_json(400, {"ok": False, "error": "access_token 不是有效的 JWT"}, origin)
            return
        if not valid_ed25519_ssh_public_key(public_key):
            self.send_json(400, {"ok": False, "error": "agent_public_key 不是有效的 Ed25519 SSH 公钥"}, origin)
            return

        try:
            runtime_id = register_agent(access_token, public_key.strip())
        except AgentBackendError as error:
            payload: dict[str, Any] = {"ok": False, "error": error.message}
            if error.upstream_status is not None:
                payload["upstream_status"] = error.upstream_status
            self.send_json(error.status, payload, origin)
            return

        self.send_json(200, {"ok": True, "agent_runtime_id": runtime_id}, origin)


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), AgentBackendHandler)
    print(f"Agent registration backend listening on http://{HOST}:{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
