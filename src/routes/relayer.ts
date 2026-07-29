// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * /v1/relayer routes — EIP-7702 sponsored transaction relayer.
 *
 *   POST /v1/relayer/setup-investments
 *     Submits a type-4 EIP-7702 transaction on behalf of a user's new EOA,
 *     atomically delegating to EIP7702Proxy and calling setImplementation
 *     to initialize a CoinbaseSmartWallet with the Cofferdam passkey as owner.
 *
 * The client signs everything off-chain (delegation authorization +
 * setImplementation EIP712 hash) and sends the signatures to this endpoint.
 * The relayer constructs and submits the type-4 tx, paying gas from its own
 * account. The user's EOA needs zero ETH.
 *
 * The relayer key is the same account used for the CDP Paymaster on Sepolia.
 * Set via `wrangler secret put RELAYER_PRIVATE_KEY`.
 *
 * Migration path: replace with CDP Server-Side Wallets for production.
 */

import { Hono } from 'hono';
import {
  createWalletClient,
  encodeFunctionData,
  http,
  type SignedAuthorization,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

import type { Env } from '../env.js';

export const relayerRoutes = new Hono<{ Bindings: Env }>();

// EIP7702Proxy setImplementation ABI
const SET_IMPLEMENTATION_ABI = [
  {
    name: 'setImplementation',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'newImplementation', type: 'address' },
      { name: 'callData', type: 'bytes' },
      { name: 'validator', type: 'address' },
      { name: 'expiry', type: 'uint256' },
      { name: 'signature', type: 'bytes' },
      { name: 'allowCrossChainReplay', type: 'bool' },
    ],
    outputs: [],
  },
] as const;

// Contract addresses (Base Sepolia — same as EIP7702Proxy deployments)
const EIP7702_PROXY = '0x7702cb554e6bFb442cb743A7dF23154544a7176C';
const CSW_IMPLEMENTATION = '0x000100abaad02f1cfC8Bbe32bD5a564817339E72';
const CSW_VALIDATOR = '0x79A33f950b90C7d07E66950daedf868BD0cDcF96';

interface SetupRequest {
  eoaAddress: string;
  authorization: {
    contractAddress: string;
    nonce: string;
    chainId: string;
    r: string;
    s: string;
    yParity: number;
  };
  callData: string;
  setImplSignature: string;
  expiry: string;
  allowCrossChainReplay?: boolean;
}

relayerRoutes.post('/setup-investments', async (c) => {
  const env = c.env as Env;

  if (!env.RELAYER_PRIVATE_KEY) {
    return c.json(
      { ok: false, error: 'relayer_not_configured', message: 'RELAYER_PRIVATE_KEY not set' },
      503,
    );
  }

  let body: SetupRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'bad_request', message: 'Invalid JSON body' }, 400);
  }

  const { eoaAddress, authorization, callData, setImplSignature, expiry } = body;
  if (!eoaAddress || !authorization || !callData || !setImplSignature || !expiry) {
    return c.json(
      { ok: false, error: 'missing_fields', message: 'eoaAddress, authorization, callData, setImplSignature, expiry are required' },
      400,
    );
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(eoaAddress)) {
    return c.json({ ok: false, error: 'bad_address', message: 'Invalid EOA address' }, 400);
  }

  // Verify the authorization is for the correct proxy contract
  if (authorization.contractAddress.toLowerCase() !== EIP7702_PROXY.toLowerCase()) {
    return c.json(
      { ok: false, error: 'bad_proxy', message: `Authorization must delegate to ${EIP7702_PROXY}` },
      400,
    );
  }

  const rpcUrl = env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org';
  const relayerAccount = privateKeyToAccount(env.RELAYER_PRIVATE_KEY as `0x${string}`);

  const walletClient = createWalletClient({
    account: relayerAccount,
    chain: baseSepolia,
    transport: http(rpcUrl),
  });

  // Construct the signed authorization from the client's off-chain signature
  const signedAuth: SignedAuthorization = {
    address: authorization.contractAddress as `0x${string}`,
    nonce: Number(authorization.nonce),
    chainId: Number(authorization.chainId),
    r: authorization.r as `0x${string}`,
    s: authorization.s as `0x${string}`,
    yParity: authorization.yParity,
  };

  // Encode setImplementation calldata
  const allowCrossChainReplay = body.allowCrossChainReplay ?? true;
  const data = encodeFunctionData({
    abi: SET_IMPLEMENTATION_ABI,
    functionName: 'setImplementation',
    args: [
      CSW_IMPLEMENTATION as `0x${string}`,
      callData as `0x${string}`,
      CSW_VALIDATOR as `0x${string}`,
      BigInt(expiry),
      setImplSignature as `0x${string}`,
      allowCrossChainReplay,
    ],
  });

  try {
    // Submit the type-4 sponsored transaction:
    // - from: relayer (pays gas)
    // - to: EOA address (call target — EOA runs EIP7702Proxy code after delegation)
    // - authorizationList: [EOA's pre-signed delegation auth]
    // - data: setImplementation(...)
    //
    // We set an explicit gas limit because viem's default gas estimation
    // simulates the call, which fails for type-4 txs — the EOA has no code
    // until the authorization list is processed during execution, so the
    // pre-flight simulation reverts with "missing revert data".
    const txHash = await walletClient.sendTransaction({
      to: eoaAddress as `0x${string}`,
      data,
      authorizationList: [signedAuth],
      chain: baseSepolia,
      gas: 1_000_000n,
    });

    return c.json({
      ok: true,
      txHash,
      eoaAddress,
      relayer: relayerAccount.address,
      chainId: baseSepolia.id,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[relayer] setup-investments failed', { eoaAddress, message });
    return c.json(
      { ok: false, error: 'tx_failed', message },
      502,
    );
  }
});
