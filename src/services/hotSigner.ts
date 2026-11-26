// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The plane's hot signers behind a switch (workspace decision 0090; runbook
 * `docs/runbooks/cdp-setup.md`, E4): the relayer and the handle registrar
 * each sign either with a raw key held as a Worker secret (`key`, the default
 * and Base Sepolia's everyday lane) or through a CDP Server Wallet account
 * (`cdp`, E1's REST client, by the account's address).
 *
 *   RELAYER_SIGNER            `key` (default): `RELAYER_PRIVATE_KEY`
 *                             `cdp`: `RELAYER_CDP_ADDRESS` + the CDP secrets
 *   HANDLE_REGISTRAR_SIGNER   `key` (default): `HANDLE_REGISTRAR_KEY`
 *                             `cdp`: `HANDLE_REGISTRAR_CDP_ADDRESS` + the CDP secrets
 *
 * Any other value, or a `cdp` switch without its address or the CDP secrets,
 * is "not configured": the caller answers 503 and nothing falls back to a raw
 * key (decision 0090 item 12: no fallback key on the plane).
 *
 * The two kinds send differently:
 * - `key` prepares and signs once, and resends the same signed bytes on a
 *   transient node error, re-signing with a fresh nonce only after a nonce or
 *   fee clash (`relaySend.ts`).
 * - `cdp` never signs locally. CDP fills the nonce, fees and gas limit left
 *   out. One idempotency key is drawn before the first try and every resend
 *   carries it, so a timeout or a 5xx resent returns CDP's first answer and
 *   never makes a second transaction (decision 0090 item 13). A refusal
 *   (a policy, a bad request) is final.
 *
 * A log line about a CDP failure names CDP's status, `errorType` and
 * `correlationId` only (`CdpApiError.message`), never CDP's own message.
 */

import { createWalletClient, getAddress, http, isAddress, type Address, type Chain, type Hex, type TypedDataDefinition } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { CdpApiError, cdpCredentialsOf, cdpNetworkOf, createCdpClient, newIdempotencyKey, type CdpClient, type CdpCredentials } from './cdp/client.js';
import { RETRY_DELAYS_MS, SendRefusedError, sendWithRetry, type SendErrorClass } from './relaySend.js';

export type SignerKind = 'key' | 'cdp';

/** Where a role's signer comes from, read from the env; never the CDP client itself. */
export type SignerSpec =
  | { readonly kind: 'key'; readonly privateKey: Hex; readonly address: Address }
  | { readonly kind: 'cdp'; readonly address: Address; readonly credentials: CdpCredentials };

/** One transaction a hot signer sends: always a call, never value. */
export interface HotTransaction {
  to: Address;
  data: Hex;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

export interface SendOptions {
  /** One report per failed attempt; a report that throws never changes the outcome. */
  onAttemptError?: (attempt: number, cls: SendErrorClass, message: string) => void;
  /** Total attempts (default 3). */
  attempts?: number;
  /** Injected by the tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** What the relay and the registrar need of a signer. */
export interface HotSigner {
  readonly kind: SignerKind;
  readonly address: Address;
  /** An EIP-712 signature by this signer. */
  signTypedData(typedData: TypedDataDefinition): Promise<Hex>;
  /** Send one transaction from this signer, with the kind's retries; resolves with its hash. */
  sendTransaction(tx: HotTransaction, options?: SendOptions): Promise<Hex>;
}

/** The env a signer role reads. */
export interface SignerEnv {
  RELAYER_SIGNER?: string;
  RELAYER_PRIVATE_KEY?: string;
  RELAYER_CDP_ADDRESS?: string;
  HANDLE_REGISTRAR_SIGNER?: string;
  HANDLE_REGISTRAR_KEY?: string;
  HANDLE_REGISTRAR_CDP_ADDRESS?: string;
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
  CDP_WALLET_SECRET?: string;
}

export type SignerRole = 'relayer' | 'registrar';

const ROLE_VARS = {
  relayer: { kind: 'RELAYER_SIGNER', key: 'RELAYER_PRIVATE_KEY', address: 'RELAYER_CDP_ADDRESS' },
  registrar: { kind: 'HANDLE_REGISTRAR_SIGNER', key: 'HANDLE_REGISTRAR_KEY', address: 'HANDLE_REGISTRAR_CDP_ADDRESS' },
} as const satisfies Record<SignerRole, { kind: keyof SignerEnv; key: keyof SignerEnv; address: keyof SignerEnv }>;

const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

/** A raw key's spec, or null when it is unset or malformed. */
export function keySpec(raw: string | undefined): SignerSpec | null {
  const key = raw?.trim();
  if (!key || !PRIVATE_KEY.test(key)) return null;
  try {
    return { kind: 'key', privateKey: key as Hex, address: privateKeyToAccount(key as Hex).address };
  } catch {
    return null;
  }
}

/**
 * The signer a role is switched to, or null while it is not configured: the
 * switch names neither `key` nor `cdp`, or the switched-to kind lacks its key,
 * its account address or the CDP secrets. Never falls back to the other kind.
 */
export function signerSpecOf(env: SignerEnv, role: SignerRole): SignerSpec | null {
  const vars = ROLE_VARS[role];
  const kind = (env[vars.kind]?.trim() || 'key').toLowerCase();
  if (kind === 'key') return keySpec(env[vars.key]);
  if (kind !== 'cdp') return null;
  const address = env[vars.address]?.trim();
  const credentials = cdpCredentialsOf(env);
  if (!address || !isAddress(address, { strict: false }) || !credentials || !credentialShapesHold(credentials)) return null;
  return { kind: 'cdp', address: getAddress(address), credentials };
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * The secrets' shapes, checked before any request: the API key's secret is
 * base64 of 64 bytes (Ed25519 seed and public key), the Wallet Secret base64.
 * A malformed one is "not configured" (503), never a send that fails after the
 * relay has said it may have gone out. The key's curve is still checked at
 * first use.
 */
function credentialShapesHold(c: CdpCredentials): boolean {
  if (!BASE64.test(c.apiKeySecret) || !BASE64.test(c.walletSecret)) return false;
  try {
    return atob(c.apiKeySecret).length === 64 && atob(c.walletSecret).length > 0;
  } catch {
    return false;
  }
}

/** What a role's switch needs and lacks, for a 503's message (names only, never a value). */
export function signerMissing(env: SignerEnv, role: SignerRole): string {
  const vars = ROLE_VARS[role];
  const kind = (env[vars.kind]?.trim() || 'key').toLowerCase();
  if (kind === 'key') return `${vars.key} not set`;
  if (kind !== 'cdp') return `${vars.kind} must be "key" or "cdp"`;
  return `${vars.kind}=cdp needs ${vars.address}, CDP_API_KEY_ID, CDP_API_KEY_SECRET and CDP_WALLET_SECRET`;
}

export interface SignerContext {
  chain: Chain;
  rpcUrl: string;
  /** `eth_sendRawTransaction` for the `key` kind (the caller's public client). */
  sendRaw: (raw: Hex) => Promise<Hex>;
  /** Injected by the tests; built from the spec's credentials otherwise. */
  cdp?: CdpClient;
}

/** The signer a spec describes, on one chain. */
export function hotSigner(spec: SignerSpec, ctx: SignerContext): HotSigner {
  return spec.kind === 'key' ? keySigner(spec, ctx) : cdpSigner(spec, ctx);
}

function keySigner(spec: Extract<SignerSpec, { kind: 'key' }>, ctx: SignerContext): HotSigner {
  const account = privateKeyToAccount(spec.privateKey);
  const wallet = createWalletClient({ account, chain: ctx.chain, transport: http(ctx.rpcUrl) });
  return {
    kind: 'key',
    address: account.address,
    signTypedData: (typedData) => account.signTypedData(typedData as Parameters<typeof account.signTypedData>[0]),
    sendTransaction: (tx, options = {}) =>
      sendWithRetry({
        sign: async () => {
          const prepared = await wallet.prepareTransactionRequest({
            to: tx.to,
            data: tx.data,
            account,
            chain: ctx.chain,
            ...(tx.maxFeePerGas !== undefined ? { maxFeePerGas: tx.maxFeePerGas } : {}),
            ...(tx.maxPriorityFeePerGas !== undefined ? { maxPriorityFeePerGas: tx.maxPriorityFeePerGas } : {}),
          });
          return wallet.signTransaction(prepared as Parameters<typeof wallet.signTransaction>[0]);
        },
        send: ctx.sendRaw,
        onAttemptError: options.onAttemptError,
        attempts: options.attempts,
        sleep: options.sleep,
      }),
  };
}

function cdpSigner(spec: Extract<SignerSpec, { kind: 'cdp' }>, ctx: SignerContext): HotSigner {
  const network = cdpNetworkOf(ctx.chain.id);
  let client: CdpClient | null = ctx.cdp ?? null;
  const clientOnce = () => (client ??= createCdpClient(spec.credentials));
  return {
    kind: 'cdp',
    address: spec.address,
    signTypedData: (typedData) => clientOnce().signTypedData(spec.address, typedData),
    async sendTransaction(tx, options = {}) {
      if (!network) throw new SendRefusedError(`cdp has no network for chain ${ctx.chain.id}`, false);
      return sendThroughCdp(clientOnce(), spec.address, network, tx, options);
    },
  };
}

/**
 * Send through CDP under one idempotency key: a retryable answer (no answer,
 * 429, 5xx) is resent under the same key after the relay's back-off; anything
 * else is final. Throws `SendRefusedError`, whose `rateLimited` says every
 * attempt was a 429 (CDP took nothing).
 */
export async function sendThroughCdp(
  client: CdpClient,
  address: Address,
  network: NonNullable<ReturnType<typeof cdpNetworkOf>>,
  tx: HotTransaction,
  options: SendOptions = {},
): Promise<Hex> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const idempotencyKey = newIdempotencyKey();
  const transaction = {
    to: tx.to,
    data: tx.data,
    ...(tx.maxFeePerGas !== undefined ? { maxFeePerGas: tx.maxFeePerGas } : {}),
    ...(tx.maxPriorityFeePerGas !== undefined ? { maxPriorityFeePerGas: tx.maxPriorityFeePerGas } : {}),
  };
  let allRateLimited = true;
  for (let attempt = 1; ; attempt++) {
    try {
      const sent = await client.sendTransaction(address, { network, transaction, idempotencyKey });
      return sent.transactionHash;
    } catch (err) {
      const retryable = err instanceof CdpApiError && err.retryable;
      // Only CdpApiError's own message (status, errorType, correlationId); anything else by its name.
      const message = err instanceof CdpApiError ? err.message : err instanceof Error ? `cdp ${err.name}` : 'cdp error';
      try {
        options.onAttemptError?.(attempt, retryable ? 'transient' : 'fatal', message);
      } catch {
        // The report is only a log.
      }
      allRateLimited &&= err instanceof CdpApiError && err.status === 429;
      if (!retryable || attempt >= attempts) throw new SendRefusedError(message, allRateLimited, { cause: err });
      await sleep(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length) - 1]!);
    }
  }
}
