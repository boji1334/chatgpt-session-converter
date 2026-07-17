# Quota API deployment

1. Copy the repository to `/opt/chatgpt-session-converter`.
2. Create `/etc/chatgpt-session-converter/quota.env` from `server/.env.example`.
3. Set `ALLOWED_ORIGINS` to the exact frontend origin and keep `HOST=127.0.0.1`.
4. Install the systemd unit from `chatgpt-quota.service.example`.
5. Install Nginx and use `nginx.conf.example` with the real API domain.
6. Issue a TLS certificate with Certbot, then set the frontend `quota-api-url` to `https://api.example.com/api/quota/check`.

The service is intentionally dependency-free and uses the Node.js built-in `fetch` implementation.
