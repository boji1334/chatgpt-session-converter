# Backend API deployment

1. Copy the repository to `/opt/chatgpt-session-converter`.
2. Create `/etc/chatgpt-session-converter/quota.env` from `server/.env.example`.
3. Create `/etc/chatgpt-session-converter/agent.env` from `server/agent.env.example`.
4. Set `ALLOWED_ORIGINS` in both files to the exact frontend origin and keep both services bound to `127.0.0.1`.
5. Create the Python environment and install the Agent backend dependency:

   ```bash
   python3 -m venv /opt/chatgpt-session-converter/.venv
   /opt/chatgpt-session-converter/.venv/bin/pip install -r /opt/chatgpt-session-converter/server/requirements-agent.txt
   ```

6. Install and enable both systemd units from `chatgpt-quota.service.example` and `chatgpt-agent.service.example`.
7. Use `Caddyfile.example` or `nginx.conf.example` with the real API domain. The exact `/api/agent/register` route is sent to the Python service on port 8788; other routes remain on the Node service on port 8787.
8. Issue a TLS certificate with Certbot, then set the frontend `quota-api-url` to `https://api.example.com/api/quota/check` and `agent-api-url` to `https://api.example.com/api/agent/register`.

The quota service remains dependency-free. The Agent service follows `codex_agent(2).py` and uses `curl_cffi` with Chrome impersonation for Runtime registration. It receives the access token and public key only; the private key remains in the browser.
