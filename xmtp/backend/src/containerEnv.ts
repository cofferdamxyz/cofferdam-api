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
}

export const BACKEND_ENV_NAMES = [
  'XMTP_DATABASE_URL',
  'XMTP_APP_API_KEY',
  'XMTP_RPC_BASE_SEPOLIA',
  'XMTP_RPC_BASE',
  'XMTP_R2_ENDPOINT',
  'XMTP_R2_ACCESS_KEY_ID',
  'XMTP_R2_SECRET_ACCESS_KEY',
] as const satisfies readonly (keyof BackendEnv)[];

export function containerEnv(env: BackendEnv): Record<string, string> {
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of BACKEND_ENV_NAMES) {
    const value = env[name];
    if (typeof value === 'string' && value.length > 0) out[name] = value;
    else missing.push(name);
  }
  if (missing.length > 0) throw new Error(`xmtp-backend: missing ${missing.join(', ')}`);
  if (/-pooler\./.test(out.XMTP_DATABASE_URL!) || /:6432\b/.test(out.XMTP_DATABASE_URL!)) {
    throw new Error('xmtp-backend: XMTP_DATABASE_URL must be a direct endpoint, not a transaction pooler');
  }
  if (out.XMTP_APP_API_KEY!.length < 32) throw new Error('xmtp-backend: XMTP_APP_API_KEY must be 32+ characters');
  return out;
}
