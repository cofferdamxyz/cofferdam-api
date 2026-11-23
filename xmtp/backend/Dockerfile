# Cofferdam's XMTP backend for Cloudflare Containers (decision 0042, amended
# 2026-11-19 for inbound TCP through Spectrum and 2026-11-20 for Caddy's own
# certificate renewal).
#
# The published backend image has no shell, so this one is Caddy on Alpine with
# the backend's static (musl) binary copied in: ./start.sh runs the backend and,
# on Cloudflare, Caddy in front of it to end TLS (./Caddyfile.acme, renewing its
# own certificate, or ./Caddyfile with a certificate passed in). rclone keeps
# Caddy's certificate store in R2 across restarts. The binary's store path
# differs per architecture, hence the glob.
#
# Pin by digest before production: replace the tag with
# `ghcr.io/xmtp/backend:sha-<full commit>` or `@sha256:<digest>` (the rc tag can
# move), and re-check ../cleanup/src/sql.ts against the new schema on every bump.
FROM ghcr.io/xmtp/backend:8.0.0-rc2 AS xmtp

FROM caddy:2.11.8-alpine

RUN apk add --no-cache rclone

COPY --from=xmtp /nix/store /nix/store
RUN ln -s "$(ls -d /nix/store/*-xmtp-backend-*-unknown-linux-musl-*)/bin/xmtp-backend" /usr/local/bin/xmtp-backend \
	&& test -x /usr/local/bin/xmtp-backend

COPY backend.toml /etc/xmtp/backend.toml
COPY Caddyfile /etc/caddy/Caddyfile
COPY Caddyfile.acme /etc/caddy/Caddyfile.acme
COPY --chmod=755 start.sh /usr/local/bin/xmtp-start

# 8443: TLS (Cloudflare, through Spectrum and the Worker). 5050: plaintext h2c,
# reached directly only in a local run of this image.
EXPOSE 8443 5050
ENTRYPOINT ["/usr/local/bin/xmtp-start"]
