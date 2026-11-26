// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * pBRL for testing on Base Sepolia, through Pods Finance's staging sandbox
 * (workspace decision 0100, question 7; runbook `pods-pix-ramp.md`, "Minting
 * pBRL for the app"). Base Sepolia has no BRS; its stand-in is Pods' test token
 * pBRL (18 decimals), which only Pods' staging sandbox mints: an approved
 * sandbox KYC profile holding the address, an onramp quote to it, and the
 * sandbox's "Pix paid" confirmation, which mints the quote's pBRL on chain.
 *
 * Each account gets one synthetic sandbox profile, derived from its address
 * (`sandboxIdentity`): a CPF with valid check digits and no person behind it,
 * an `example.com` email, and the account as the profile's wallet. Pods
 * answers a resubmission of the same identity with the same approved profile
 * (measured on staging, 2026-11-26), so the plane stores nothing. A sandbox
 * profile mints at most R$10,000 in all, R$1,000 per quote.
 *
 * Staging only: `podsSandboxBase` refuses any host but
 * `staging-api.pods.finance`, requests follow no redirect, and the key
 * (`PODS_SANDBOX_API_KEY`) goes only in the `x-api-key` header to that host.
 * Nothing here ever reads a production key.
 */

export const PODS_STAGING_URL = 'https://staging-api.pods.finance';
const STAGING_HOSTS = new Set(['staging-api.pods.finance']);

/** Pods' pBRL on Base Sepolia ("pods BRL Testnet", 18 decimals), BRS's stand-in. */
export const PBRL_BASE_SEPOLIA = '0x9762f60740142cF11C0F32C6e24cd3e86016C0f2';

/** Pods caps one onramp quote at R$1,000 on this corridor. */
export const MAX_CENTS_PER_QUOTE = 100_000;
/** What one request may mint: five quotes. A sandbox profile holds R$10,000 in all. */
export const MAX_CENTS_PER_REQUEST = 500_000;

/** The base URL, or null when it names any host but Pods' staging API over https. */
export function podsSandboxBase(override?: string): string | null {
  const raw = (override || PODS_STAGING_URL).replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  return url.protocol === 'https:' && STAGING_HOSTS.has(url.hostname) && url.pathname === '/' ? url.origin : null;
}

/**
 * Centavos from an amount in reais written with at most two decimals ("200",
 * "250.5", "250,50"), or null for anything else, zero or above the request cap.
 */
export function parseReaisCents(amount: unknown): number | null {
  if (typeof amount !== 'string' && typeof amount !== 'number') return null;
  const text = String(amount).trim().replace(',', '.');
  const m = /^(\d{1,6})(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return cents >= 1 && cents <= MAX_CENTS_PER_REQUEST ? cents : null;
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** A CPF's two check digits over its first nine. */
function cpfFrom(nine: number[]): string {
  const dv = (digits: number[], weight: number) => {
    const r = (digits.reduce((sum, d, i) => sum + d * (weight - i), 0) * 10) % 11;
    return r === 10 ? 0 : r;
  };
  const d = [...nine];
  d.push(dv(d, 10));
  d.push(dv(d, 11));
  return d.join('');
}

export interface SandboxIdentity {
  cpf: string;
  email: string;
  walletAddress: string;
  sumsubApplicantId: string;
}

/** The account's synthetic sandbox identity: the same address always gives the same one. */
export async function sandboxIdentity(account: string): Promise<SandboxIdentity> {
  const seed = await sha256(`cofferdam-pods-sandbox-v1:${account.toLowerCase()}`);
  const nine = Array.from(seed.slice(0, 9), (b) => b % 10);
  // Nine repeated digits make an invalid CPF.
  if (nine.every((d) => d === nine[0])) nine[8] = (nine[8]! + 1) % 10;
  const tag = hex(seed.slice(9, 15));
  return {
    cpf: cpfFrom(nine),
    email: `cofferdam-sandbox-${tag}@example.com`,
    walletAddress: account.toLowerCase(),
    sumsubApplicantId: `cofferdam-sandbox-${tag}`,
  };
}

export type MintResult =
  | { ok: true; mintedCents: number; txHashes: string[] }
  | { ok: false; error: 'wallet_linked_elsewhere' | 'pods_refused' | 'pods_unreachable'; code?: string; mintedCents: number; txHashes: string[] };

export interface MintInput {
  apiKey: string;
  base: string;
  account: string;
  cents: number;
  fetch?: typeof fetch;
}

class PodsError extends Error {
  constructor(readonly status: number, readonly code: string | undefined) {
    super(`pods ${status}${code ? ` ${code}` : ''}`);
  }
}

/** Mint `cents` of pBRL (1 centavo = 1e16 units) to `account` on Base Sepolia through the sandbox. */
export async function mintPbrl(input: MintInput): Promise<MintResult> {
  const f = input.fetch ?? fetch;
  async function pods(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await f(`${input.base}${path}`, {
        method,
        headers: { 'x-api-key': input.apiKey, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new PodsError(0, undefined);
    }
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      // a non-JSON answer carries no code
    }
    if (!res.ok) {
      const error = json.error as { code?: unknown } | undefined;
      throw new PodsError(res.status, typeof error?.code === 'string' ? error.code : undefined);
    }
    return json;
  }

  const txHashes: string[] = [];
  let minted = 0;
  try {
    const who = await sandboxIdentity(input.account);
    const submitted = await pods('/api/v1/kyc/sumsub-share-token', 'POST', { ...who, shareToken: `${who.sumsubApplicantId}-${Date.now()}` });
    const kycUserId = submitted.kycUserId;
    if (typeof kycUserId !== 'string' || !kycUserId) throw new PodsError(502, 'NO_KYC_USER_ID');
    const status = await pods(`/api/v1/kyc/status?kycUserId=${encodeURIComponent(kycUserId)}`);
    if (status.status !== 'approved') {
      await pods('/api/v1/kyc/status/sandbox/approved', 'POST', { kycUserId });
    }

    let left = input.cents;
    while (left > 0) {
      const chunk = Math.min(left, MAX_CENTS_PER_QUOTE);
      const q = new URLSearchParams({
        originChain: 'fiat',
        destinationChain: 'base-sepolia',
        tokenIn: 'BRL',
        tokenOut: PBRL_BASE_SEPOLIA,
        amountIn: String(chunk),
        destinationAddress: input.account,
      });
      const quote = await pods(`/v2/swap/quote?${q.toString()}`);
      const quoteId = (quote.quote as { id?: unknown } | undefined)?.id;
      if (typeof quoteId !== 'string') throw new PodsError(502, 'NO_QUOTE_ID');
      const paid = await pods('/v2/swap/status/sandbox/confirmed', 'POST', { quoteId, kycUserId });
      if (typeof paid.destinationTxHash === 'string') txHashes.push(paid.destinationTxHash);
      left -= chunk;
      minted += chunk;
    }
    return { ok: true, mintedCents: minted, txHashes };
  } catch (err) {
    if (!(err instanceof PodsError)) throw err;
    if (err.status === 0) return { ok: false, error: 'pods_unreachable', mintedCents: minted, txHashes };
    if (err.code === 'KYC_WALLET_ALREADY_LINKED') {
      return { ok: false, error: 'wallet_linked_elsewhere', code: err.code, mintedCents: minted, txHashes };
    }
    return { ok: false, error: 'pods_refused', code: err.code ?? `HTTP_${err.status}`, mintedCents: minted, txHashes };
  }
}
