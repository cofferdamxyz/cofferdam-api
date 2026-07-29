// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Base Sepolia contract deployments.
 *
 * **Source of truth.** Vendored from
 * `/Users/hoff/OffshoreSync/base-contracts/deployments/baseSepolia.json`,
 * which is updated by the deploy scripts in `base-contracts/scripts/`.
 *
 * Re-vendor (manually for now) when a new contract deploys. A later
 * session will auto-generate this file from the canonical JSON; for
 * Session 1 we accept the small duplication so the Worker stays
 * dependency-free with respect to the contracts package.
 */

import type { Address } from 'viem';

export interface ContractDeployment {
  /** EIP-55 checksum address. */
  readonly address: Address;
  /** Tx hash of the deploy. */
  readonly txHash?: `0x${string}`;
  /** ISO-8601 timestamp when the deploy mined. */
  readonly deployedAt?: string;
  /** Deployer EOA. */
  readonly deployer?: Address;
  /**
   * Authority tier, for the v2 authority-module singletons
   * (`PasskeyAuthority` / `WebAuthnPasskeyAuthority` / `SessionKeyAuthority`).
   * Mirrors the on-chain `Tier` enum. Absent for non-authority contracts.
   */
  readonly tier?: 'High' | 'LowManaged' | 'LowUntrusted';
  /** Authority `kind()` discriminator (e.g. `passkey`, `session`, `polis_sso`). */
  readonly kind?: string;
  /** WebAuthn authority only: whether assertions must carry the UV bit (always true). */
  readonly requireUserVerification?: boolean;
}

/** Base Sepolia chain id. */
export const BASE_SEPOLIA_CHAIN_ID = 84532 as const;

/**
 * All Cofferdam-relevant contracts deployed on Base Sepolia.
 *
 * Includes the v2 identity rail (SelfAttesterRegistry + NullifierRegistry)
 * and the v2 native account-abstraction (passkey-authority) stack
 * (CofferdamAccountFactory4337 + CofferdamPaymaster + the
 * PasskeyAuthority / WebAuthnPasskeyAuthority / SessionKeyAuthority
 * singletons), against which
 * `POST /v1/session/verify-attestation?checkOnChain` resolves a session
 * attestation's passkey to an active on-chain authority.
 */
export const SEPOLIA_DEPLOYMENTS = {
  /** Self.xyz Groth16 verifier (mock on Base Sepolia). */
  MockGroth16Verifier: {
    address: '0x442f9584BBBFC9987d7220659bA84B20Fab24136',
  },
  /** Escrow factory — paid maritime contracts. */
  EscrowFactory: {
    address: '0x6a1C08bf3c17DDbd021C2e4131c9dA85d976A737',
  },
  /** Escrow contract — paid maritime contracts. */
  CofferdamSpotEscrow: {
    address: '0xc46241fa872EFD91884E29244901cF3B266bE262',
  },
  /**
   * v2 — allow-list of trusted Self TEE attester ECDSA addresses.
   * Owner: deployer. Initial attester is the secp256k1 address whose
   * privkey lives (from Session 3) as a Cloudflare-managed secret on
   * `cofferdam-attester`.
   */
  SelfAttesterRegistry: {
    address: '0x782ea54C148AdDe5679E464E16b370297039267E',
  },
  /**
   * v2 — one-shot Self.xyz nullifier ↔ account binding. Wired to the
   * Groth16 verifier and the SelfAttesterRegistry.
   * Locked to scope `cofferdam-sepolia` (uint256
   * `4110595171224311359414942497373057058713959593849800517221207032372881193556`,
   * Poseidon of endpoint=`cofferdam.xyz` × scope=`cofferdam-sepolia`).
   */
  NullifierRegistry: {
    address: '0x8C05411C6ED0d113a200382a590CcFeC546A5cAe',
  },
  /** ERC-4337 EntryPoint (canonical address on Base). */
  EntryPoint: {
    address: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
  },
  /** Mock USDC token for Base Sepolia testing. */
  MockUSDC: {
    address: '0x8c05Df95F91De2D70e0436B774fc9D1f86FF1f51',
  },

  // ── v2 native account-abstraction (passkey-authority) stack ────────────

  /** create2 factory for per-user CofferdamSmartAccount instances. */
  CofferdamAccountFactory4337: {
    address: '0x35CeBf87f5DAE7be7cf755067d30fC65Fa541F3D',
  },
  /** Open paymaster sponsoring account ops (gasless UX). */
  CofferdamPaymaster: {
    address: '0x5ffb8bA851DCf7A592B85fc2567e72449214204e',
  },
  /**
   * High-tier REAL platform-passkey authority (WebAuthn assertion). This is
   * the module the RN app registers (signature scheme `webauthn`); the
   * session-attestation verifier maps `alg === 'webauthn'` to this address.
   */
  WebAuthnPasskeyAuthority: {
    address: '0x279Cf7DF840a76EE9EcC1C177698E6EaB490Eea8',
    tier: 'High',
    kind: 'passkey',
    requireUserVerification: true,
  },
  /**
   * High-tier RAW P-256 passkey authority (bare `r||s` over the digest, used
   * by the software DeterministicPasskeySigner / PoC). The verifier maps
   * `alg === 'p256'` to this address.
   */
  PasskeyAuthority: {
    address: '0x25338619e03e92511feB63cc66Dfd9CAFB5654E6',
    tier: 'High',
    kind: 'passkey',
  },
  /** Low-tier untrusted session-key authority (cannot manage authorities). */
  SessionKeyAuthorityLowUntrusted: {
    address: '0xc76337F62D298831deEeE8f4063567884680A14b',
    tier: 'LowUntrusted',
    kind: 'session',
  },
  /** Low-tier managed (enterprise SSO / Polis) session-key authority. */
  SessionKeyAuthorityLowManaged: {
    address: '0x4780DEc3E132E835C36895BFBbb71Bb63C638e54',
    tier: 'LowManaged',
    kind: 'polis_sso',
  },
} as const satisfies Record<string, ContractDeployment>;

export type ContractName = keyof typeof SEPOLIA_DEPLOYMENTS;

/**
 * The authority-module address a session attestation's signature scheme must
 * resolve to on-chain. `webauthn` assertions are verified by
 * `WebAuthnPasskeyAuthority`; raw `p256` signatures by `PasskeyAuthority`.
 */
export const PASSKEY_AUTHORITY_MODULE_BY_SCHEME = {
  webauthn: SEPOLIA_DEPLOYMENTS.WebAuthnPasskeyAuthority.address,
  p256: SEPOLIA_DEPLOYMENTS.PasskeyAuthority.address,
} as const satisfies Record<'webauthn' | 'p256', Address>;
