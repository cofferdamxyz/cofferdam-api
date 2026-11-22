import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, parseTransaction, type Address, type Hex } from 'viem';

import { anchorTransaction, HANDLE_ANCHOR_ABI, rpcAnchorChain } from '../src/services/handles/anchor.js';

// The relay's real send path, through viem against a stubbed node: on 2026-11-22 it signed a contract creation with
// no code for every claim (simulateContract's request, handed to prepareTransactionRequest, lost `to` and the call
// data), and the in-memory anchor of handlesWrite.test.ts never reaches this path.

const ANCHOR = '0x8b346614EBC7eE242eCB2Bb5F04D9CBF91ed1aA8' as Address;
// Hardhat's public test key #2, never a real key.
const REGISTRAR_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const HANDLE = `0x${'ab'.repeat(32)}` as Hex;
const OWNER = '0x000000000000000000000000000000000000dEaD' as Address;
const META = `0x02${'11'.repeat(32)}03${'22'.repeat(32)}` as Hex;
const SIG = `0x${'33'.repeat(65)}` as Hex;

function stubNode(): { raw: Hex[] } {
  const seen = { raw: [] as Hex[] };
  const answer = (method: string, params: unknown[]): unknown => {
    switch (method) {
      case 'eth_chainId':
        return '0x14a34';
      case 'eth_call':
        return '0x';
      case 'eth_getTransactionCount':
        return '0x2';
      case 'eth_estimateGas':
        return '0x30000';
      case 'eth_maxPriorityFeePerGas':
        return '0x3b9aca00';
      case 'eth_gasPrice':
        return '0x3b9aca00';
      case 'eth_getBlockByNumber':
        return { number: '0x1', baseFeePerGas: '0x3b9aca00', timestamp: '0x1', transactions: [] };
      case 'eth_sendRawTransaction':
        seen.raw.push(params[0] as Hex);
        return `0x${'cd'.repeat(32)}`;
      default:
        throw new Error(`unexpected ${method}`);
    }
  };
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] } | { id: number; method: string; params: unknown[] }[];
    const one = (r: { id: number; method: string; params: unknown[] }) => ({ jsonrpc: '2.0', id: r.id, result: answer(r.method, r.params) });
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { headers: { 'content-type': 'application/json' } });
  });
  return seen;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the anchor send', () => {
  it('encodes the call into a transaction to the anchor', () => {
    const tx = anchorTransaction(ANCHOR, { functionName: 'applyChange', args: [HANDLE] });
    expect(tx.to).toBe(ANCHOR);
    expect(decodeFunctionData({ abi: HANDLE_ANCHOR_ABI, data: tx.data })).toMatchObject({ functionName: 'applyChange', args: [HANDLE] });
  });

  it('signs the claim to the anchor with its call data, never a contract creation', async () => {
    const node = stubNode();
    const chain = rpcAnchorChain({ HANDLE_REGISTRAR_KEY: REGISTRAR_KEY, BASE_SEPOLIA_RPC_URL: 'https://node.test' } as never, ANCHOR);
    expect(chain).not.toBeNull();
    await chain!.send({ functionName: 'claim', args: [HANDLE, OWNER, META, 1_800_000_000n, SIG, SIG] });

    expect(node.raw).toHaveLength(1);
    const tx = parseTransaction(node.raw[0]!);
    expect(tx.to?.toLowerCase()).toBe(ANCHOR.toLowerCase());
    expect(tx.chainId).toBe(84532);
    const call = decodeFunctionData({ abi: HANDLE_ANCHOR_ABI, data: tx.data! });
    expect(call.functionName).toBe('claim');
    expect(call.args?.[0]).toBe(HANDLE);
  });
});
