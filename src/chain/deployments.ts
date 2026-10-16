// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Base Sepolia contract deployments.
 *
 * **Source of truth.** Vendored from
 * `base-contracts/deployments/baseSepolia.json` (this workspace),
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
   * Authority tier of an authority-module singleton. Mirrors the on-chain
   * `Tier` enum (`None, LowUntrusted, LowManaged, High, Partner`; decision
   * 0016 retired LowUntrusted from the module registry). Absent for
   * non-authority contracts.
   */
  readonly tier?: 'High' | 'Partner' | 'LowManaged';
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
  /**
   * Self.xyz Groth16 verifier for the `vc_and_disclose` circuit (21 public
   * signals, E_PASSPORT). Vendored byte-identical from
   * `self/contracts/contracts/verifiers/disclose/Verifier_vc_and_disclose.sol`.
   *
   * This is a REAL verifier: `NullifierRegistry.verifyAndBind` performs a
   * genuine Groth16 check, not a trusted attestation. It supersedes the earlier
   * `MockGroth16Verifier` (which accepted any proof) at
   * `0x442f9584BBBFC9987d7220659bA84B20Fab24136`.
   */
  Verifier_vc_and_disclose: {
    address: '0x26fBC868344AF4E99874edFd0E3756EcC2359bEb',
  },
  /**
   * Escrow factory — deploys one spot escrow per job via CREATE2
   * (`createSpotEscrow(policy, salt)`). This is the entry point; individual
   * escrows are not pre-deployed.
   */
  EscrowFactory: {
    address: '0x37553ab271a0078F95032B35F5494Fbf25206Fd2',
  },
  /**
   * A single spot-escrow instance. NOTE: the shipped architecture is
   * CREATE2-per-job via `EscrowFactory` above, so this is *not* a singleton
   * every job routes through — it is one deployed instance (demo/reference).
   * Resolve per-job addresses with `predictSpotEscrowAddress(policy, salt)`.
   */
  CofferdamSpotEscrow: {
    address: '0xe6dCFc3Af1cB944b0Aa03f27325E7E47e390d9b1',
  },
  /**
   * v2 — allow-list of trusted Self TEE attester ECDSA addresses.
   *
   * Owner: deployer (`0x2c8A01e971d7C51B3B78f9F08c57c45584D96AB2`).
   * Sole trusted attester: `0x2dFDdE621680A270cC01E8D9D729f25a46Bdae59`, whose
   * private key is the `ATTESTER_PRIVATE_KEY` Cloudflare secret on
   * `cofferdam-attester`. Deliberately NOT the deployer key — the deployer is
   * verified `isTrustedAttester == false` so a leaked deploy key cannot mint
   * bind attestations.
   *
   * Rotation is contract-free — use `base-contracts/scripts/rotate-self-attester.ts`,
   * which does `addAttester(new)` then `removeAttester(old)` idempotently. A
   * rotation must update three places or the Worker signs unusable proofs:
   * this registry, the Cloudflare secret, and `cofferdam-attester/.dev.vars`.
   * Retired: `0x9c93145AF6b37755844C572e7F73408f3fB95c75`,
   * `0x621e5fdA698E928af5bBF825d14B92f9A0229B4a`.
   */
  SelfAttesterRegistry: {
    address: '0x8F3fF40Aa7Eb46b9AB214229D8f7833bbC47ae08',
  },
  /**
   * v2 — one-shot Self.xyz nullifier ↔ account binding. Wired to
   * `Verifier_vc_and_disclose` and `SelfAttesterRegistry` above.
   *
   * Verified on-chain at deploy time:
   *   expectedScope   = 9385173979550103756914225592429331034074493553395666193753061396908251355773
   *                     (Poseidon of `cofferdam.xyz` × `cofferdam-bind-v1`;
   *                      must equal `SelfApp.scope` in cofferdam-app)
   *   selfDestChainId = 42220 (Self's `SelfApp.chainID`, NOT Base's 84532)
   *
   * Both are immutable, so changing either means redeploying and re-binding
   * every user. `cofferdam-attester`'s `NULLIFIER_REGISTRY_ADDRESS` must match
   * this exactly or `signBind` rejects with `REGISTRY_NOT_ALLOWED`.
   *
   * v2 (2026-10-14, decision 0022): `rebind` moves a bound nullifier to a new
   * account on a fresh proof, `rebindDelay` 0 on Sepolia. v3 (same day,
   * decision 0023) keeps that surface and adds `provenNullifier` and
   * `recoveryMessageHash`, which `CofferdamAccount4337.recoverHigh` checks a
   * fresh proof against. The v1 registry
   * `0x2843F55C9E1491a6d47F65f041E68F96E3aeB3d4` is retired; its bindings were
   * not migrated, those accounts bind fresh here. v2
   * `0xC4931d4492a9E7124735dd040890BC2cc427505F` was retired before it held a
   * binding.
   */
  NullifierRegistry: {
    address: '0xF025204964A355D3125CF15Bd606B8CFc92FbDB6',
  },
  /** ERC-4337 EntryPoint (canonical address on Base). */
  EntryPoint: {
    address: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
  },
  /** Mock USDC token for Base Sepolia testing. */
  MockUSDC: {
    address: '0x8c05Df95F91De2D70e0436B774fc9D1f86FF1f51',
  },

  // ── Account layer (decisions 0016 and 0023), deployed on Base Sepolia 2026-10-14 ──
  // deploy-auth.ts from CofferdamDev, which owns both registries and the
  // paymaster on testnet. The factory pins the NullifierRegistry above,
  // `RECOVERY_DELAY` 0 and `PROBATION_PERIOD` 600 seconds. Accounts created
  // through the pre-0016 factory (`0x35CeBf87…1F3D`) and the decision 0016
  // factory of the same day (`0xC0F4EEd3…bF3E`) are orphaned, not migrated.

  /** CREATE2 factory for per-user `CofferdamAccount4337` instances; pins the NullifierRegistry above and both registries below. */
  CofferdamAccountFactory4337: {
    address: '0xbfe7c71A3D423316bc8B7C40858eC6B9736847E2',
  },
  /** Authority modules an account may install (`MODULE_REGISTRY` of the factory). */
  CofferdamModuleRegistry: {
    address: '0x5b437804978116fECe00DC1c983C9aDa24d4A8Ad',
  },
  /**
   * Keys that co-sign first-High enrolment, Partner recovery and hard
   * recovery. The ceremony attester
   * `0xC912bFE0AD345035606182c23495b6883AA0934D` (cofferdam-attester
   * `signCeremony`) is listed from the constructor.
   */
  CofferdamCeremonyAttesterRegistry: {
    address: '0x44A2B59d5D39f773C2e65469e0Dd3217E53823Af',
  },
  /** Stub paymaster sponsoring every op; owner-only withdrawals (decision 0014). */
  CofferdamPaymaster: {
    address: '0x85657a56b23525047cF67d462c6Bf2B3C6d66B18',
  },
  /**
   * High-tier platform-passkey authority (WebAuthn assertion), pinned to the
   * `cofferdam.xyz` RP. The module the RN app registers (signature scheme
   * `webauthn`); the session-attestation verifier maps `alg === 'webauthn'`
   * to this address.
   */
  WebAuthnPasskeyAuthority: {
    address: '0xd62c4deDeD3E2fEF52c8733aa1c899C7714a87C5',
    tier: 'High',
    kind: 'passkey',
    requireUserVerification: true,
  },
  /**
   * High-tier RAW P-256 passkey authority (bare `r||s` over the digest, used
   * by the software DeterministicPasskeySigner). Testnet only: mainnet does
   * not list it. The verifier maps `alg === 'p256'` to this address.
   */
  PasskeyAuthority: {
    address: '0xcc5ef249E501127fBD43c26ee4ea943aC743Af33',
    tier: 'High',
    kind: 'passkey',
  },
  /** Partner tier: the user's passkey on a partner app's RP, scoped by a `Permission`. */
  PartnerPasskeyAuthority: {
    address: '0xf1a9E1c2411DeaBA6F45630754dB1824779eC129',
    tier: 'Partner',
    kind: 'partner_passkey',
  },
  /** Managed tier: employer bridge ECDSA key (enterprise SSO / Polis), scoped by a `Permission`. */
  SessionKeyAuthorityLowManaged: {
    address: '0x7c6801603C34FEc9D13c350388f35920FdD8bb6E',
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
