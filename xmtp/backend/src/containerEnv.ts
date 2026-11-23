// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The environment the XMTP backend process gets. Every `env:NAME` in
 * ../backend.toml must be here: the backend refuses to start on a missing
 * variable, so a missing Worker secret fails here first with its name, and
 * test/xmtp/config.test.ts keeps this list and the TOML in step.
 */
export interface BackendEnv {
  /** Secret. Direct Postgres 17+ URL (Neon without `-pooler`, or PlanetScale :5432). */
  XMTP_DATABASE_URL?: string;
  /** Secret. The app-level API key ([auth.api_keys] cofferdam-app), 32+ printable chars. */
  XMTP_APP_API_KEY?: string;
  /** Var. Base Sepolia JSON-RPC for ERC-1271 checks. */
  XMTP_RPC_BASE_SEPOLIA?: string;
  /** Var. Base mainnet JSON-RPC for ERC-1271 checks. */
  XMTP_RPC_BASE?: string;
  /** Secret. https://<account id>.r2.cloudflarestorage.com */
  XMTP_R2_ENDPOINT?: string;
  /** Secret. R2 API token, Object Write on the attachments bucket only. */
  XMTP_R2_ACCESS_KEY_ID?: string;
  XMTP_R2_SECRET_ACCESS_KEY?: string;
  // The two above are no longer passed: backend.toml has no [attachments] since 2026-11-23.
  /**
   * Secret, optional override. PEM chain for the Spectrum hostname (leaf
   * first), publicly trusted: Spectrum on a Pro zone passes TLS through, so the
   * container's Caddy serves it (../Caddyfile, ../start.sh; decision 0042,
   * amended 2026-11-19). When set with the key it wins over Caddy's own ACME;
   * scripts/xmtp/tls-renew.sh (workspace) is the emergency path that sets it.
   */
  XMTP_TLS_CERT?: string;
  /** Secret, optional override. The certificate's PEM private key. Only Caddy reads it. */
  XMTP_TLS_KEY?: string;
  /**
   * Secret. R2 token, Object Read & Write on the ACME store's bucket only:
   * Caddy obtains and renews the certificate itself (../Caddyfile.acme), and
   * rclone keeps its store in that bucket (decision 0042, amended 2026-11-20).
   */
  XMTP_ACME_R2_ACCESS_KEY_ID?: string;
  XMTP_ACME_R2_SECRET_ACCESS_KEY?: string;
  /** Var. The ACME store's bucket. */
  XMTP_ACME_BUCKET?: string;
  /** Var. "staging" (Let's Encrypt's test CA) or "production". */
  XMTP_ACME_CA?: string;
}

export const BACKEND_ENV_NAMES = [
  'XMTP_DATABASE_URL',
  'XMTP_APP_API_KEY',
  'XMTP_RPC_BASE_SEPOLIA',
  'XMTP_RPC_BASE',
] as const satisfies readonly (keyof BackendEnv)[];

/** The manual certificate pair, read by ../start.sh, never by backend.toml. */
export const TLS_ENV_NAMES = ['XMTP_TLS_CERT', 'XMTP_TLS_KEY'] as const satisfies readonly (keyof BackendEnv)[];

/** Caddy's own ACME, read by ../start.sh, never by backend.toml. */
export const ACME_ENV_NAMES = [
  'XMTP_R2_ENDPOINT', // the store's endpoint (../start.sh); the backend writes nothing to R2 since 2026-11-23
  'XMTP_ACME_R2_ACCESS_KEY_ID',
  'XMTP_ACME_R2_SECRET_ACCESS_KEY',
  'XMTP_ACME_BUCKET',
  'XMTP_ACME_CA',
] as const satisfies readonly (keyof BackendEnv)[];

const present = (env: BackendEnv, name: keyof BackendEnv) => {
  const value = env[name];
  return typeof value === 'string' && value.length > 0;
};

/** How the container gets its certificate: Caddy's own ACME, or a pair passed in (which wins). */
export function tlsMode(env: BackendEnv): 'manual' | 'acme' | null {
  if (TLS_ENV_NAMES.every((n) => present(env, n))) return 'manual';
  if (ACME_ENV_NAMES.every((n) => present(env, n))) return 'acme';
  return null;
}

export function containerEnv(env: BackendEnv): Record<string, string> {
  const out: Record<string, string> = {};
  const missing: string[] = BACKEND_ENV_NAMES.filter((n) => !present(env, n));
  if (missing.length > 0) throw new Error(`xmtp-backend: missing ${missing.join(', ')}`);
  for (const name of BACKEND_ENV_NAMES) out[name] = env[name]!;
  if (TLS_ENV_NAMES.some((n) => present(env, n)) && tlsMode(env) !== 'manual') {
    throw new Error('xmtp-backend: XMTP_TLS_CERT and XMTP_TLS_KEY go together');
  }
  const mode = tlsMode(env);
  if (mode === null) {
    const absent = ACME_ENV_NAMES.filter((n) => !present(env, n));
    throw new Error(`xmtp-backend: no certificate source: missing ${absent.join(', ')} (or the XMTP_TLS_CERT/XMTP_TLS_KEY override)`);
  }
  for (const name of mode === 'manual' ? TLS_ENV_NAMES : ACME_ENV_NAMES) out[name] = env[name]!;
  if (mode === 'acme' && !['staging', 'production'].includes(out.XMTP_ACME_CA!)) {
    throw new Error('xmtp-backend: XMTP_ACME_CA must be "staging" or "production"');
  }
  if (/-pooler\./.test(out.XMTP_DATABASE_URL!) || /:6432\b/.test(out.XMTP_DATABASE_URL!)) {
    throw new Error('xmtp-backend: XMTP_DATABASE_URL must be a direct endpoint, not a transaction pooler');
  }
  // libpq reads `sslrootcert=system` as "the OS trust store"; the backend's sqlx
  // reads it as a file path and dies with "No such file or directory" before it
  // ever dials (2026-10-23, PlanetScale's Node snippet carries it).
  if (/[?&]sslrootcert=system\b/.test(out.XMTP_DATABASE_URL!)) {
    throw new Error('xmtp-backend: drop sslrootcert=system from XMTP_DATABASE_URL (sqlx reads it as a file); keep sslmode=verify-full');
  }
  if (out.XMTP_APP_API_KEY!.length < 32) throw new Error('xmtp-backend: XMTP_APP_API_KEY must be 32+ characters');
  if (mode === 'manual' && !/^-----BEGIN CERTIFICATE-----/.test(out.XMTP_TLS_CERT!.trim())) {
    throw new Error('xmtp-backend: XMTP_TLS_CERT must be a PEM certificate chain');
  }
  if (mode === 'manual' && !/^-----BEGIN (EC |RSA )?PRIVATE KEY-----/.test(out.XMTP_TLS_KEY!.trim())) {
    throw new Error('xmtp-backend: XMTP_TLS_KEY must be a PEM private key');
  }
  return out;
}

/**
 * SHA-256 over the container environment, so a changed secret or variable is
 * noticed without storing any value. The secrets are long random strings, so
 * the digest reveals nothing about them.
 */
export async function envFingerprint(env: Record<string, string>): Promise<string> {
  const canonical = JSON.stringify(Object.keys(env).sort().map((k) => [k, env[k]]));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Whether the backend should run (wrangler.jsonc `RUN`); anything but "on" pauses it. */
export function running(env: { RUN?: string }): boolean {
  return env.RUN === 'on';
}
