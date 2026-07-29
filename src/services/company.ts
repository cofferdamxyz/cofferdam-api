// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Company-plane service — the shared, domain-anchored company identity
 * primitives for the Cofferdam enterprise module (ENTERPRISE_MODULE_PLAN.md
 * rev-7.4, §3 "thin shared company plane" + §4.1 + §6.C).
 *
 * The keystone is `deriveCompanyAnchor`: a company's GLOBAL, immutable
 * `companyAnchor` is a PURE FUNCTION of its verified canonical domain. No
 * storage, no network — every consumer/vertical that resolves the same
 * domain computes the same `companyAnchor`, which is the cross-consumer join
 * key used on-chain in `CofferdamCorporateRegistry` and in the
 * `CompanyConsumerLink` grant (§4.11).
 *
 * CANONICAL PREIMAGE (must stay byte-for-byte identical across this Worker,
 * the future `CofferdamCorporateRegistry.registerCompany` Solidity, and the
 * SDK):
 *
 *   companyAnchor = keccak256( utf8("cofferdam-company-v1") || utf8(canonicalDomain) )
 *              = keccak256( abi.encodePacked("cofferdam-company-v1", canonicalDomain) )   // Solidity mirror
 *
 * The version tag is a fixed prefix, so concatenation is unambiguous (no
 * domain can forge a different (tag, domain) split). Bump the tag only with
 * a coordinated registry migration.
 */

import { keccak256, toBytes, type Address, type Hex } from 'viem';
import type { BaseSepoliaClient } from '../chain/client.js';

// ─────────────────────────────────────────────────────────────────────
// companyAnchor derivation
// ─────────────────────────────────────────────────────────────────────

/** Domain-separation tag baked into every `companyAnchor`. NEVER change without a registry migration. */
export const COMPANY_ANCHOR_TAG = 'cofferdam-company-v1';

/** A 32-byte `companyAnchor`, lowercase 0x-hex. */
export type CompanyAnchor = Hex;

/**
 * Derive the global, immutable `companyAnchor` from an ALREADY-CANONICAL
 * domain (run `canonicalizeDomain` first). Pure + deterministic.
 */
export function deriveCompanyAnchor(canonicalDomain: string): CompanyAnchor {
  // `toBytes` is UTF-8; string concat then encode == encode(tag) || encode(domain).
  return keccak256(toBytes(COMPANY_ANCHOR_TAG + canonicalDomain));
}

/** True iff `x` is a syntactically valid 32-byte 0x-hex `companyAnchor`. */
export function isCompanyAnchor(x: unknown): x is CompanyAnchor {
  return typeof x === 'string' && /^0x[0-9a-fA-F]{64}$/.test(x);
}

// ─────────────────────────────────────────────────────────────────────
// Domain canonicalization
// ─────────────────────────────────────────────────────────────────────

/**
 * Reduce arbitrary user input to the canonical apex/host form used for the
 * `companyAnchor` preimage, or `null` if it isn't a plausible domain.
 *
 * Rules: lowercase, trim, strip scheme/path/query/fragment/port and a
 * trailing root dot, require ≥ 2 labels, validate label charset + lengths,
 * require an alphabetic TLD.
 *
 * Out of scope (handled by higher layers): `www`/alias unification, M&A
 * domain aliases (§12.4), and IDN/punycode normalization — a unicode domain
 * is rejected here for now (TODO: ToASCII before hashing).
 */
export function canonicalizeDomain(input: string): string | null {
  if (typeof input !== 'string') return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;

  s = s.replace(/^https?:\/\//, ''); // strip scheme if a URL was pasted
  s = s.replace(/[/?#:].*$/, ''); // strip path / query / fragment / port in one pass
  s = s.replace(/\.$/, ''); // strip FQDN root dot

  if (s.length < 1 || s.length > 253) return null;

  const labels = s.split('.');
  if (labels.length < 2) return null; // must be a real domain, not a bare label

  for (const label of labels) {
    if (label.length < 1 || label.length > 63) return null;
    if (label.startsWith('-') || label.endsWith('-')) return null;
    if (!/^[a-z0-9-]+$/.test(label)) return null;
  }

  const tld = labels[labels.length - 1];
  if (tld === undefined || !/^[a-z]{2,}$/.test(tld)) return null; // no all-numeric/short TLDs

  return s;
}

// ─────────────────────────────────────────────────────────────────────
// DNS challenge surface (ENTERPRISE_MODULE_PLAN.md §4.4 / §12.1)
//
// The proof is to the SHARED Cofferdam plane, so the record is
// Cofferdam-branded regardless of which consumer's UI initiates it.
// ─────────────────────────────────────────────────────────────────────

export const DNS_CHALLENGE_RECORD_PREFIX = '_cofferdam-verify';
export const DNS_CHALLENGE_VALUE_PREFIX = 'cofferdam-site-verification=';

/** The TXT record NAME the company must publish: `_cofferdam-verify.<domain>`. */
export function dnsChallengeRecordName(canonicalDomain: string): string {
  return `${DNS_CHALLENGE_RECORD_PREFIX}.${canonicalDomain}`;
}

/** Mint a 32-hex-char challenge token (crypto-random). */
export function mintChallengeToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Format the full TXT record VALUE the company publishes for a token. */
export function formatChallengeValue(token: string): string {
  return `${DNS_CHALLENGE_VALUE_PREFIX}${token}`;
}

// ─────────────────────────────────────────────────────────────────────
// On-chain registration lookup (CofferdamCorporateRegistry, §6.C)
//
// NOTE: `CofferdamCorporateRegistry` is a rev-7.4 testnet redeploy that has
// NOT landed yet (see the rev-7.4 change log + §14 migration note). Until
// its address is vendored into `chain/deployments.ts`, this stays `null`
// and registration lookups degrade gracefully (`readCompanyRegistration`
// returns `null` → routes report `registry_not_deployed`).
// ─────────────────────────────────────────────────────────────────────

export const CORPORATE_REGISTRY_ADDRESS: Address | null = null;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Minimal read-only ABI for the registry getters we need. */
export const CORPORATE_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'companyWallet',
    stateMutability: 'view',
    inputs: [{ name: 'companyAnchor', type: 'bytes32' }],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'orgRoots',
    stateMutability: 'view',
    inputs: [{ name: 'companyAnchor', type: 'bytes32' }],
    outputs: [
      { name: 'root', type: 'bytes32' },
      { name: 'generation', type: 'uint64' },
      { name: 'rootUpdater', type: 'address' },
      { name: 'updatedAt', type: 'uint64' },
      { name: 'batchSummaryHash', type: 'bytes32' },
    ],
  },
] as const;

export interface CompanyRegistration {
  /** True iff a main Safe (companyWallet) is registered for this companyAnchor. */
  registered: boolean;
  /** The company's main Safe address, or `null` if unregistered. */
  companyWallet: Address | null;
  /** Current `OrgRoot.generation`, or `null` if unregistered / no root yet. */
  orgGeneration: number | null;
}

/**
 * Read whether a `companyAnchor` is registered on-chain and its current org
 * generation. Returns `null` when the registry isn't deployed yet (caller
 * should surface `registry_not_deployed`).
 */
export async function readCompanyRegistration(
  client: BaseSepoliaClient,
  companyAnchor: CompanyAnchor,
): Promise<CompanyRegistration | null> {
  if (!CORPORATE_REGISTRY_ADDRESS) return null;

  const wallet = (await client.readContract({
    address: CORPORATE_REGISTRY_ADDRESS,
    abi: CORPORATE_REGISTRY_ABI,
    functionName: 'companyWallet',
    args: [companyAnchor],
  })) as Address;

  const registered = wallet.toLowerCase() !== ZERO_ADDRESS;
  if (!registered) {
    return { registered: false, companyWallet: null, orgGeneration: null };
  }

  const org = (await client.readContract({
    address: CORPORATE_REGISTRY_ADDRESS,
    abi: CORPORATE_REGISTRY_ABI,
    functionName: 'orgRoots',
    args: [companyAnchor],
  })) as readonly [Hex, bigint, Address, bigint, Hex];

  return {
    registered: true,
    companyWallet: wallet,
    orgGeneration: Number(org[1]),
  };
}
