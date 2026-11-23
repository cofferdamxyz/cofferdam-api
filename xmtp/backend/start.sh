#!/bin/sh
# Container entry point (workspace decision 0042, amended 2026-11-19 and
# 2026-11-20).
#
# Three modes, picked from the environment the XmtpBackend Durable Object passes:
#   acme    XMTP_ACME_R2_ACCESS_KEY_ID and XMTP_ACME_R2_SECRET_ACCESS_KEY set:
#           Caddy (./Caddyfile.acme) obtains and renews xmtp.cofferdam.xyz's
#           certificate itself over TLS-ALPN-01 on :8443, which Spectrum reaches
#           on 443. Its storage (/data/caddy) is restored from the R2 bucket
#           XMTP_ACME_BUCKET at start and copied back every few minutes, so a
#           restart reuses the certificate instead of issuing a new one.
#   manual  XMTP_TLS_CERT and XMTP_TLS_KEY set (the override, and the emergency
#           path of scripts/xmtp/tls-renew.sh): Caddy (./Caddyfile) serves that
#           pair on :8443. Takes precedence over acme.
#   plain   neither: the backend alone on :5050, as the published image would
#           (a local run of this image; containerEnv refuses it on Cloudflare).
# In acme and manual modes it exits when the backend or Caddy does, so the
# object's next alarm starts a fresh container.
set -u

CONFIG=/etc/xmtp/backend.toml
DATA=/data/caddy
# The backend never needs the TLS key or the ACME store's token.
BACKEND_ENV_DROP="-u XMTP_TLS_CERT -u XMTP_TLS_KEY -u XMTP_ACME_R2_ACCESS_KEY_ID -u XMTP_ACME_R2_SECRET_ACCESS_KEY -u RCLONE_CONFIG_STORE_ACCESS_KEY_ID -u RCLONE_CONFIG_STORE_SECRET_ACCESS_KEY"

mode=plain
if [ -n "${XMTP_TLS_CERT:-}" ] || [ -n "${XMTP_TLS_KEY:-}" ]; then
	if [ -z "${XMTP_TLS_CERT:-}" ] || [ -z "${XMTP_TLS_KEY:-}" ]; then
		echo "start: XMTP_TLS_CERT and XMTP_TLS_KEY must both be set" >&2
		exit 1
	fi
	mode=manual
elif [ -n "${XMTP_ACME_R2_ACCESS_KEY_ID:-}" ] || [ -n "${XMTP_ACME_R2_SECRET_ACCESS_KEY:-}" ]; then
	for v in XMTP_ACME_R2_ACCESS_KEY_ID XMTP_ACME_R2_SECRET_ACCESS_KEY XMTP_ACME_BUCKET XMTP_R2_ENDPOINT; do
		eval "[ -n \"\${$v:-}\" ]" || {
			echo "start: acme mode needs $v" >&2
			exit 1
		}
	done
	mode=acme
fi

if [ "$mode" = plain ]; then
	exec xmtp-backend --config-file "$CONFIG"
fi

umask 077

if [ "$mode" = manual ]; then
	mkdir -p /run/xmtp-tls
	printf '%s\n' "$XMTP_TLS_CERT" >/run/xmtp-tls/cert.pem
	printf '%s\n' "$XMTP_TLS_KEY" >/run/xmtp-tls/key.pem
	CADDYFILE=/etc/caddy/Caddyfile
else
	# rclone reads its remote from the environment; nothing is written to disk.
	export RCLONE_CONFIG_STORE_TYPE=s3
	export RCLONE_CONFIG_STORE_PROVIDER=Cloudflare
	export RCLONE_CONFIG_STORE_ENDPOINT="$XMTP_R2_ENDPOINT"
	export RCLONE_CONFIG_STORE_ACCESS_KEY_ID="$XMTP_ACME_R2_ACCESS_KEY_ID"
	export RCLONE_CONFIG_STORE_SECRET_ACCESS_KEY="$XMTP_ACME_R2_SECRET_ACCESS_KEY"
	export RCLONE_CONFIG_STORE_NO_CHECK_BUCKET=true
	# Bounded, so a store outage costs seconds at start, never minutes.
	export RCLONE_RETRIES=2 RCLONE_LOW_LEVEL_RETRIES=2 RCLONE_CONTIMEOUT=5s RCLONE_TIMEOUT=20s
	REMOTE="store:$XMTP_ACME_BUCKET/caddy"
	case "${XMTP_ACME_CA:-staging}" in
	production) export XMTP_ACME_DIRECTORY=https://acme-v02.api.letsencrypt.org/directory ;;
	*) export XMTP_ACME_DIRECTORY=https://acme-staging-v02.api.letsencrypt.org/directory ;;
	esac
	export XMTP_TLS_DOMAIN="${XMTP_TLS_DOMAIN:-xmtp.cofferdam.xyz}"
	mkdir -p "$DATA"
	# A missing or empty store is a first start (rclone exits 3, directory not
	# found). Any other failed read is fatal on the production CA: Caddy would
	# issue again on every restart, and Let's Encrypt allows 5 a week per name,
	# so a store outage in a restart loop would leave the name with no
	# certificate for days. On staging it only warns.
	rc=0
	rclone copy --quiet "$REMOTE" "$DATA" || rc=$?
	if [ "$rc" -ne 0 ] && [ "$rc" -ne 3 ]; then
		echo "start: could not restore the certificate store (rclone exit $rc)" >&2
		[ "${XMTP_ACME_CA:-staging}" = production ] && exit 1
	fi
	CADDYFILE=/etc/caddy/Caddyfile.acme
fi

env $BACKEND_ENV_DROP xmtp-backend --config-file "$CONFIG" &
backend=$!
proxy=""
saver=""

stop() {
	[ -n "$saver" ] && kill "$saver" 2>/dev/null
	if [ "$mode" = acme ]; then rclone copy --quiet "$DATA" "$REMOTE" 2>/dev/null; fi
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

# Caddy needs the key and certificate files, never the R2 token.
env -u RCLONE_CONFIG_STORE_ACCESS_KEY_ID -u RCLONE_CONFIG_STORE_SECRET_ACCESS_KEY \
	-u XMTP_ACME_R2_ACCESS_KEY_ID -u XMTP_ACME_R2_SECRET_ACCESS_KEY -u XMTP_TLS_CERT -u XMTP_TLS_KEY \
	caddy run --config "$CADDYFILE" --adapter caddyfile &
proxy=$!

if [ "$mode" = acme ]; then
	# Copy changes back: a new or renewed certificate, the ACME account, the locks.
	# Every 30 s for the first 10 minutes, so a certificate issued at start is in
	# the store before a restart could ask for another; then every 5 minutes.
	(n=0; while sleep 30; do
		n=$((n + 1))
		if [ "$n" -le 20 ] || [ $((n % 10)) -eq 0 ]; then
			rclone copy --quiet "$DATA" "$REMOTE" || echo "start: could not save the certificate store" >&2
		fi
	done) &
	saver=$!
fi

while kill -0 "$backend" 2>/dev/null && kill -0 "$proxy" 2>/dev/null; do
	sleep 2
done
stop 1
