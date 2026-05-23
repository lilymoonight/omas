# Deployment notes

完整使用手册见 [docs/MANUAL.md](./docs/MANUAL.md)。

omas 是单文件二进制进程。默认绑定 `127.0.0.1`，前面加 TLS 终结反向代理即可对外服务。本文档汇总经反向代理部署时的常见坑。

## WebSocket upgrade

The terminal uses WebSockets. The proxy **must** forward the upgrade headers:

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade    $http_upgrade;
proxy_set_header Connection "upgrade";
```

If you see the terminal stuck in `connecting…`, this is the first thing to check.

Some corporate VIPs **strip `Connection: Upgrade`** entirely. There is no
client-side workaround — switch to an SSH tunnel for that environment.

## Idle timeouts

Default nginx `proxy_read_timeout` is 60 s and will silently close idle
WebSockets. oh-my-agent-shell sends a 20 s heartbeat at the application layer,
so the connection looks "active" to any sane proxy and idle close is unlikely.
If you still see drops, bump:

```nginx
proxy_read_timeout 1h;
proxy_send_timeout 1h;
```

## Buffering

Disable response buffering on the WebSocket location, otherwise nginx will
accumulate output before flushing and the terminal feels laggy:

```nginx
proxy_buffering off;
```

## Sub-path mounts (`/shell/`)

The frontend uses purely relative URLs and a hash-based router, so you can
serve it under any prefix. The only requirement is the **trailing slash on
`proxy_pass`** so nginx strips the prefix:

```nginx
location /shell/ {
    proxy_pass http://127.0.0.1:7681/;   #  ← note the trailing slash
    # ...the WebSocket headers above...
}
```

Without the trailing slash, nginx forwards `/shell/api/...` to the upstream
unchanged and the API 404s.

## VSCode port forwarding

VSCode (and code-server) port forwarding works out of the box. Use the **Ports**
view, forward `7681`, copy the `*.devtunnels.ms` URL, sign in. The cookie domain
is the tunnel host and won't clash with anything else.

## Cookies and HTTPS

The session cookie is set with `SameSite=Lax; HttpOnly; Secure` (when the
request looks like HTTPS — Fastify decides this from `X-Forwarded-Proto` since
we enable `trustProxy: true`). Make sure your proxy sets that header:

```nginx
proxy_set_header X-Forwarded-Proto $scheme;
```

Without it, the cookie is sent as non-Secure and most browsers will refuse to
store it on HTTPS pages.

## Exposing publicly

oh-my-agent-shell binds to `127.0.0.1` by default. To expose on a LAN, change
the bind via `--host 0.0.0.0` **only behind a TLS-terminating proxy**. The
password is the only thing standing between the open internet and a root
shell — keep TLS in front.

The login endpoint is rate-limited (5 fails / 5 min per IP). argon2id is set
to ~50 ms verify time so brute force is fundamentally slow.

## Docker

```bash
docker build -t omas .
docker volume create omas-config

# 1) one-shot init to create the password
docker run -it --rm -v omas-config:/config omas init

# 2) actual server
docker run -d --name omas --restart unless-stopped \
  -p 127.0.0.1:7681:7681 -v omas-config:/config \
  omas
```

Put nginx in front, point `proxy_pass` at `http://127.0.0.1:7681/`.

## Health check

`GET /api/health` is unauthenticated and returns:

```json
{ "ok": true, "uptime": 12345.6, "sessions": 3 }
```

Use it for liveness/readiness in your supervisor.
