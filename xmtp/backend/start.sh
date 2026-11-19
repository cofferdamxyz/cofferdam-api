#!/bin/sh
# Container entry point (workspace decision 0042, amended 2026-11-19).
#
# With XMTP_TLS_CERT and XMTP_TLS_KEY set (Cloudflare: the XmtpBackend Durable
# Object passes them from Worker secrets), it runs the backend on 127.0.0.1:5050
# behind Caddy on :8443 (./Caddyfile), and exits when either process does, so the
# object's next alarm starts a fresh container. Without them (the Fly.io
# fallback, whose edge ends TLS) it runs the backend alone, as the published
# image would.
set -u

CONFIG=/etc/xmtp/backend.toml

if [ -z "${XMTP_TLS_CERT:-}" ] && [ -z "${XMTP_TLS_KEY:-}" ]; then
	exec xmtp-backend --config-file "$CONFIG"
fi
if [ -z "${XMTP_TLS_CERT:-}" ] || [ -z "${XMTP_TLS_KEY:-}" ]; then
	echo "start: XMTP_TLS_CERT and XMTP_TLS_KEY must both be set" >&2
	exit 1
fi

umask 077
mkdir -p /run/xmtp-tls
printf '%s\n' "$XMTP_TLS_CERT" >/run/xmtp-tls/cert.pem
printf '%s\n' "$XMTP_TLS_KEY" >/run/xmtp-tls/key.pem
# The backend never needs the key.
unset XMTP_TLS_CERT XMTP_TLS_KEY

xmtp-backend --config-file "$CONFIG" &
backend=$!

stop() {
	kill "$backend" ${proxy:+"$proxy"} 2>/dev/null
	wait
	exit "${1:-0}"
}
trap 'stop 0' TERM INT

# Migrations run before the backend binds; open TLS only once it listens, so a
# client never meets a proxy with nothing behind it.
tries=0
until nc -z 127.0.0.1 5050 2>/dev/null; do
	kill -0 "$backend" 2>/dev/null || stop 1
	tries=$((tries + 1))
	[ "$tries" -gt 300 ] && stop 1
	sleep 0.2
done

caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &
proxy=$!

while kill -0 "$backend" 2>/dev/null && kill -0 "$proxy" 2>/dev/null; do
	sleep 2
done
stop 1
