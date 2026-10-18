# Cofferdam's XMTP backend for Cloudflare Containers (decision 0042).
#
# The published image's entry point is the backend binary, so CMD holds only its
# arguments. Pin by digest before production: replace the tag with
# `ghcr.io/xmtp/backend:sha-<full commit>` or `@sha256:<digest>` (the rc tag can
# move), and re-check ../cleanup/src/sql.ts against the new schema on every bump.
FROM ghcr.io/xmtp/backend:8.0.0-rc2

COPY backend.toml /etc/xmtp/backend.toml

EXPOSE 5050
CMD ["--config-file", "/etc/xmtp/backend.toml"]
