// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The plane's CDP Server Wallet client over CDP's REST API (workspace decision
 * 0090; runbook `docs/runbooks/cdp-setup.md`, E1). Wired nowhere yet: E4 puts
 * the handle registrar and the relayer behind a switch that picks this or the
 * raw key, and Base Sepolia keeps the raw keys for everyday use.
 *
 * Three calls, the ones the plane's roles use:
 * - `getAccountByName`: an account's address by its name in the project.
 * - `signTypedData`: an EIP-712 signature (the registrar, the statement key).
 *   The answer must recover to the account, or the call fails.
 * - `sendTransaction`: CDP signs and sends an EIP-1559 transaction on a named
 *   network, filling the nonce, the fees and the gas limit left out. Every
 *   send carries the caller's `X-Idempotency-Key` (a UUID v4 from
 *   `newIdempotencyKey`, CDP's 24-hour window). The caller draws it before
 *   the first try and resends a timeout or a 5xx under the same key, so CDP
 *   never makes a second transaction (decision 0090, item 13).
 *
 * Policies are not this client's: no call here creates, edits or reads one,
 * and the plane's key never holds the Manage restriction (decision 0090, item
 * 10; question B of the runbook). An error carries CDP's status, `errorType`
 * and `correlationId`; its message names those only, since CDP's
 * `errorMessage` can quote the request (kept apart, for a caller that may log
 * it). A secret never reaches an error or a log.
 */

import {
  getAddress,
  getTypesForEIP712Domain,
  isAddress,
  parseTransaction,
  recoverTypedDataAddress,
  serializeTransaction,
  validateTypedData,
  type Address,
  type Hex,
  type TransactionSerializableEIP1559,
  type TypedData,
  type TypedDataDefinition,
} from 'viem';
import type { Env } from '../../env';
import { bearerJwt, importApiKeySecret, importWalletSecret, requiresWalletAuth, sortKeys, walletJwt } from './auth';

export const CDP_API_BASE = 'https://api.cdp.coinbase.com/platform';

/** Per call; a send that times out is resent under the same idempotency key. */
export const CDP_TIMEOUT_MS = 10_000;

/** The networks the plane signs on, by chain id. CDP ignores a transaction's own chain id and sends on `network`. */
const NETWORK_BY_CHAIN: Record<number, CdpNetwork> = { 8453: 'base', 84532: 'base-sepolia' };
const CHAIN_BY_NETWORK: Record<CdpNetwork, number> = { base: 8453, 'base-sepolia': 84532 };

export type CdpNetwork = 'base' | 'base-sepolia';

export function cdpNetworkOf(chainId: number): CdpNetwork | null {
  return NETWORK_BY_CHAIN[chainId] ?? null;
}

export interface CdpCredentials {
  apiKeyId: string;
  apiKeySecret: string;
  walletSecret: string;
}

/** The plane's CDP credentials, or null while any is unset. Their shapes are checked when the client first signs. */
export function cdpCredentialsOf(env: Pick<Env, 'CDP_API_KEY_ID' | 'CDP_API_KEY_SECRET' | 'CDP_WALLET_SECRET'>): CdpCredentials | null {
  const apiKeyId = env.CDP_API_KEY_ID?.trim();
  const apiKeySecret = env.CDP_API_KEY_SECRET?.trim();
  const walletSecret = env.CDP_WALLET_SECRET?.trim();
  if (!apiKeyId || !apiKeySecret || !walletSecret) return null;
  return { apiKeyId, apiKeySecret, walletSecret };
}

/** A CDP answer other than success, or no answer (`status` 0). */
export class CdpApiError extends Error {
  constructor(
    readonly status: number,
    readonly errorType: string,
    readonly correlationId: string | undefined,
    errorMessage: string,
  ) {
    super(`cdp ${status || 'no answer'} ${errorType}${correlationId ? ` (${correlationId})` : ''}`);
    this.name = 'CdpApiError';
    // Not enumerable, so a log of the whole error (`console.error(err)`, `JSON.stringify`) never prints it.
    Object.defineProperty(this, 'errorMessage', { value: errorMessage, enumerable: false });
  }

  /** CDP's own message: it may quote the request (an op's call data), so no caller logs it. */
  declare readonly errorMessage: string;

  /** Worth a retry: rate limited, a server error or no answer. A send is retried only under its idempotency key. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

/** An answer that is a success but not of the expected shape, or a signature that is not the account's. */
export class CdpResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CdpResponseError';
  }
}

export interface CdpAccount {
  address: Address;
  name?: string;
  policies: string[];
}

export interface SendTransactionInput {
  network: CdpNetwork;
  /** An unsigned EIP-1559 transaction, as fields or already RLP-encoded (`0x02…`). `to` is required. */
  transaction: Omit<TransactionSerializableEIP1559, 'type' | 'chainId'> | Hex;
  /** A UUID v4 from `newIdempotencyKey`, drawn before the first try and reused on every resend of this transaction. */
  idempotencyKey: string;
}

export interface SentTransaction {
  transactionHash: Hex;
  idempotencyKey: string;
}

export interface CdpClient {
  getAccountByName(name: string): Promise<CdpAccount>;
  signTypedData<const T extends TypedData | Record<string, unknown>, P extends keyof T | 'EIP712Domain'>(
    address: Address,
    typedData: TypedDataDefinition<T, P>,
  ): Promise<Hex>;
  sendTransaction(address: Address, input: SendTransactionInput): Promise<SentTransaction>;
}

/** A fresh idempotency key for one transaction: draw it once, before the first try. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export interface CdpClientOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  /** Seconds since the epoch; the tests pin it. */
  now?: () => number;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const ACCOUNT_NAME = /^[A-Za-z0-9-]{2,36}$/;

/** Every bigint as its decimal string, recursively, as CDP's SDK sends JSON. */
function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = jsonSafe(v);
    return out;
  }
  return value;
}

/** The fallback `errorType` for an answer without CDP's error body, as the SDK maps it. */
function fallbackErrorType(status: number): string {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limit_exceeded';
  if (status === 502) return 'bad_gateway';
  if (status === 503) return 'service_unavailable';
  return 'unexpected_error';
}

function stringField(obj: unknown, key: string): string | undefined {
  const v = obj && typeof obj === 'object' ? (obj as Record<string, unknown>)[key] : undefined;
  return typeof v === 'string' ? v : undefined;
}

export function createCdpClient(credentials: CdpCredentials, options: CdpClientOptions = {}): CdpClient {
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const base = (options.baseUrl ?? CDP_API_BASE).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? CDP_TIMEOUT_MS;
  // Imported once, on first use, never extractable.
  let keys: Promise<{ api: CryptoKey; wallet: CryptoKey }> | null = null;
  const keysOnce = () =>
    (keys ??= Promise.all([importApiKeySecret(credentials.apiKeySecret), importWalletSecret(credentials.walletSecret)]).then(
      ([api, wallet]) => ({ api, wallet }),
      (err: unknown) => {
        keys = null;
        throw err;
      },
    ));

  async function request(method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}): Promise<unknown> {
    const url = new URL(`${base}${path}`);
    const { api, wallet } = await keysOnce();
    const now = options.now?.();
    const sent = body === undefined ? undefined : sortKeys(jsonSafe(body));
    const auth: Record<string, string> = {
      authorization: `Bearer ${await bearerJwt({ keyId: credentials.apiKeyId, key: api, method, url, now })}`,
    };
    if (requiresWalletAuth(method, url)) auth['x-wallet-auth'] = await walletJwt({ key: wallet, method, url, body: sent, now });
    let res: Response;
    let text: string;
    try {
      res = await doFetch(url.toString(), {
        method,
        headers: { ...auth, ...headers, ...(sent === undefined ? {} : { 'content-type': 'application/json' }) },
        body: sent === undefined ? undefined : JSON.stringify(sent),
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Inside the same timeout and mapping: a body cut off mid-read is no answer too.
      text = await res.text();
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new CdpApiError(0, timedOut ? 'timeout' : 'network_error', undefined, '');
    }
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      // Not JSON: an error answer then takes its type from the status alone.
    }
    if (!res.ok) {
      const errorType = stringField(parsed, 'errorType') ?? fallbackErrorType(res.status);
      throw new CdpApiError(res.status, errorType, stringField(parsed, 'correlationId'), stringField(parsed, 'errorMessage') ?? '');
    }
    return parsed;
  }

  return {
    async getAccountByName(name) {
      if (!ACCOUNT_NAME.test(name)) throw new CdpResponseError('a CDP account name is 2 to 36 letters, digits or hyphens');
      const answer = await request('GET', `/v2/evm/accounts/by-name/${encodeURIComponent(name)}`);
      const address = stringField(answer, 'address');
      if (!address || !isAddress(address, { strict: false })) throw new CdpResponseError('CDP answered an account without an address');
      const policies = answer && typeof answer === 'object' ? (answer as { policies?: unknown }).policies : undefined;
      return {
        address: getAddress(address),
        name: stringField(answer, 'name'),
        policies: Array.isArray(policies) ? policies.filter((p): p is string => typeof p === 'string') : [],
      };
    },

    async signTypedData(address, typedData) {
      // Refused here before CDP sees it: a malformed definition, or a value out of its type.
      validateTypedData(typedData as TypedDataDefinition);
      const def = typedData as unknown as { domain?: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message?: unknown };
      const domain = { ...(def.domain ?? {}) };
      if (domain.chainId !== undefined) domain.chainId = Number(domain.chainId);
      const types = { EIP712Domain: getTypesForEIP712Domain({ domain }), ...def.types };
      const answer = await request('POST', `/v2/evm/accounts/${getAddress(address)}/sign/typed-data`, {
        domain,
        types,
        primaryType: def.primaryType,
        message: def.message ?? {},
      });
      const signature = stringField(answer, 'signature');
      if (!signature || !SIGNATURE.test(signature)) throw new CdpResponseError('CDP answered a typed-data signature of the wrong shape');
      const signer = await recoverTypedDataAddress({ ...(typedData as TypedDataDefinition), signature: signature as Hex });
      if (signer.toLowerCase() !== address.toLowerCase()) throw new CdpResponseError('CDP signed with another key than the account named');
      return signature as Hex;
    },

    async sendTransaction(address, input) {
      const { idempotencyKey } = input;
      if (!UUID_V4.test(idempotencyKey)) throw new CdpResponseError('the idempotency key must be a UUID v4');
      let transaction: Hex;
      if (typeof input.transaction === 'string') {
        let type: string | undefined;
        try {
          type = parseTransaction(input.transaction).type;
        } catch {
          type = undefined;
        }
        if (type !== 'eip1559') throw new CdpResponseError('the transaction must be an RLP-encoded EIP-1559 transaction');
        transaction = input.transaction;
      } else {
        if (!input.transaction.to) throw new CdpResponseError('the transaction must name `to`');
        transaction = serializeTransaction({ ...input.transaction, type: 'eip1559', chainId: CHAIN_BY_NETWORK[input.network] });
      }
      const answer = await request(
        'POST',
        `/v2/evm/accounts/${getAddress(address)}/send/transaction`,
        { network: input.network, transaction },
        { 'x-idempotency-key': idempotencyKey },
      );
      const transactionHash = stringField(answer, 'transactionHash');
      if (!transactionHash || !TX_HASH.test(transactionHash)) throw new CdpResponseError('CDP answered a send without a transaction hash');
      return { transactionHash: transactionHash as Hex, idempotencyKey };
    },
  };
}
