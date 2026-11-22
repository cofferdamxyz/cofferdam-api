// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * An in-memory `CofferdamHandleAnchor` for the plane's tests: the record, the
 * per-handle nonce, the serial, one pending change with its delay, the freeze,
 * the release and the quarantine, as `contracts/handles/CofferdamHandleAnchor.sol`
 * keeps them, with every signature checked through the plane's own typed data
 * (so a wrong field fails here as the contract would). Sends land at once; the
 * receipt is `success` unless a test says otherwise.
 */

import { getAddress, keccak256, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { AnchorRevert, CHANGE_KIND, ZERO_ADDRESS, type AnchorCall, type AnchorChain, type AnchorRecord, type ReceiptStatus } from '../../../src/services/handles/anchor.js';
import { anchorSigner, type AnchorPrimaryType } from '../../../src/services/handles/typedData.js';
import fixture from './handleAnchorTypes.json';

export const TEST_ANCHOR = '0x3A0D2850C6b47797b58eD067ceC117660D93DA70' as Address;

export interface MemoryAnchor extends AnchorChain {
  records: Map<string, AnchorRecord>;
  sent: AnchorCall[];
  /** The chain's clock, in unix seconds. */
  clock: { now: number };
  receipts: Map<string, ReceiptStatus>;
  delays: { change: number; freeze: number; quarantine: number };
  /** When each account was deployed (unix seconds, by lower-case address); an account absent was deployed long ago. `null` stands for a node that cannot say. */
  deployedAt: Map<string, number | null>;
  /** A send mines with a successful receipt and changes nothing, as the empty transactions of 2026-11-22 did. */
  mineNothing: boolean;
}

const blank = (): AnchorRecord => ({
  owner: ZERO_ADDRESS,
  serial: 0,
  nonce: 0n,
  frozenUntil: 0,
  releasedAt: 0,
  pendingReadyAt: 0,
  pendingKind: CHANGE_KIND.None,
  pendingNonce: 0n,
  pendingOwner: ZERO_ADDRESS,
  metaAddress: '0x',
});

export function memoryAnchor(clock: { now: number }, registrarKey: Hex = fixture.keys.registrar.privateKey as Hex): MemoryAnchor {
  const registrar = privateKeyToAccount(registrarKey);
  const records = new Map<string, AnchorRecord>();
  const sent: AnchorCall[] = [];
  const receipts = new Map<string, ReceiptStatus>();
  const deployedAt = new Map<string, number | null>();
  const delays = { change: 600, freeze: 1800, quarantine: 86_400 };
  const rec = (id: string) => records.get(id.toLowerCase()) ?? blank();
  const put = (id: string, r: AnchorRecord) => records.set(id.toLowerCase(), r);
  let n = 0;
  const flags = { mineNothing: false };

  const expect = async (who: Address, type: AnchorPrimaryType, message: Record<string, unknown>, sig: Hex) => {
    const got = await anchorSigner(84532, TEST_ANCHOR, type, message, sig);
    if (!got || got.toLowerCase() !== who.toLowerCase()) throw new AnchorRevert('BadSignature');
  };
  const isRegistrar = async (type: AnchorPrimaryType, message: Record<string, unknown>, sig: Hex) => expect(registrar.address, type, message, sig);
  const deadlineOk = (d: bigint) => {
    if (Number(d) < clock.now) throw new AnchorRevert('Expired');
  };
  const frozen = (r: AnchorRecord) => r.frozenUntil > clock.now;

  return {
    chainId: 84532,
    anchor: TEST_ANCHOR,
    registrar,
    records,
    sent,
    clock,
    receipts,
    delays,
    deployedAt,
    get mineNothing() {
      return flags.mineNothing;
    },
    set mineNothing(v: boolean) {
      flags.mineNothing = v;
    },
    async deployedBefore(account, seconds) {
      const at = deployedAt.get(account.toLowerCase());
      if (at === undefined) return true;
      if (at === null) return false;
      return at <= clock.now - seconds;
    },
    async record(id) {
      return { ...rec(id) };
    },
    async receipt(hash) {
      return receipts.get(hash) ?? 'success';
    },
    async waitReceipt(hash) {
      return receipts.get(hash) ?? 'success';
    },
    async send(call) {
      if (flags.mineNothing) {
        sent.push(call);
        return keccak256(`0x${(++n).toString(16).padStart(4, '0')}`);
      }
      const r = { ...rec(call.args[0]) };
      const id = call.args[0];
      switch (call.functionName) {
        case 'claim': {
          const [, owner, meta, deadline, regSig, ownerSig] = call.args;
          deadlineOk(deadline);
          if (r.owner !== ZERO_ADDRESS) throw new AnchorRevert('AlreadyOwned');
          if (r.releasedAt && clock.now < r.releasedAt + delays.quarantine) throw new AnchorRevert('InQuarantine');
          const serial = BigInt(r.serial + 1);
          await isRegistrar('RegistrarClaim', { handleId: id, owner, serial, nonce: r.nonce, deadline }, regSig);
          await expect(owner, 'OwnerClaim', { handleId: id, metaAddress: meta, serial }, ownerSig);
          Object.assign(r, { nonce: r.nonce + 1n, owner: getAddress(owner), serial: r.serial + 1, metaAddress: meta, releasedAt: 0 });
          break;
        }
        case 'release': {
          const [, deadline, ownerSig] = call.args;
          deadlineOk(deadline);
          if (r.owner === ZERO_ADDRESS) throw new AnchorRevert('NotOwned');
          if (frozen(r)) throw new AnchorRevert('Frozen');
          if (r.pendingKind !== CHANGE_KIND.None) throw new AnchorRevert('ChangePending');
          await expect(r.owner, 'Release', { handleId: id, nonce: r.nonce, deadline }, ownerSig);
          Object.assign(r, { pendingKind: CHANGE_KIND.Release, pendingNonce: r.nonce, pendingReadyAt: clock.now + delays.change, nonce: r.nonce + 1n });
          break;
        }
        case 'applyChange': {
          if (r.pendingKind === CHANGE_KIND.None) throw new AnchorRevert('NoPendingChange');
          if (clock.now < r.pendingReadyAt) throw new AnchorRevert('ChangeNotReady');
          if (frozen(r)) throw new AnchorRevert('Frozen');
          if (r.pendingKind === CHANGE_KIND.Release) Object.assign(r, { owner: ZERO_ADDRESS, metaAddress: '0x', releasedAt: clock.now });
          Object.assign(r, { pendingKind: CHANGE_KIND.None, pendingReadyAt: 0, pendingNonce: 0n });
          break;
        }
        case 'advance': {
          const [, newOwner, meta, deadline, ownerSig, newOwnerSig, regSig] = call.args;
          deadlineOk(deadline);
          const m = { handleId: id, newMetaAddress: meta, nonce: r.nonce, deadline };
          await expect(r.owner, 'Advance', { ...m, newOwner }, ownerSig);
          await expect(newOwner, 'AdvanceAccept', { ...m, previousOwner: r.owner }, newOwnerSig);
          await isRegistrar('RegistrarAdvance', { ...m, previousOwner: r.owner, newOwner }, regSig);
          Object.assign(r, { nonce: r.nonce + 1n, owner: getAddress(newOwner), metaAddress: meta, pendingKind: CHANGE_KIND.None });
          break;
        }
        case 'hold': {
          const [, deadline, sig] = call.args;
          deadlineOk(deadline);
          if (frozen(r)) throw new AnchorRevert('Frozen');
          if (r.pendingKind !== CHANGE_KIND.None) throw new AnchorRevert('ChangePending');
          await isRegistrar('Hold', { handleId: id, nonce: r.nonce, deadline }, sig);
          Object.assign(r, { nonce: r.nonce + 1n, frozenUntil: clock.now + delays.freeze });
          break;
        }
        case 'renewHold': {
          const [, frozenUntil, deadline, sig] = call.args;
          deadlineOk(deadline);
          if (Number(frozenUntil) !== r.frozenUntil || !frozen(r)) throw new AnchorRevert('FreezeMismatch');
          await isRegistrar('RenewHold', { handleId: id, frozenUntil, nonce: r.nonce, deadline }, sig);
          Object.assign(r, { nonce: r.nonce + 1n, frozenUntil: clock.now + delays.freeze });
          break;
        }
        case 'veto': {
          const [, pendingNonce, deadline, sig] = call.args;
          deadlineOk(deadline);
          if (r.pendingKind === CHANGE_KIND.None || r.pendingNonce !== pendingNonce) throw new AnchorRevert('NoPendingChange');
          await isRegistrar('Veto', { handleId: id, pendingNonce, nonce: r.nonce, deadline }, sig);
          Object.assign(r, { nonce: r.nonce + 1n, pendingKind: CHANGE_KIND.None, pendingNonce: 0n, frozenUntil: clock.now + delays.freeze });
          break;
        }
        case 'unfreeze': {
          const [, frozenUntil, deadline, ownerSig, regSig] = call.args;
          deadlineOk(deadline);
          if (Number(frozenUntil) !== r.frozenUntil || !frozen(r)) throw new AnchorRevert('FreezeMismatch');
          const m = { handleId: id, frozenUntil, nonce: r.nonce, deadline };
          await expect(r.owner, 'Unfreeze', m, ownerSig);
          await isRegistrar('RegistrarUnfreeze', m, regSig);
          Object.assign(r, { nonce: r.nonce + 1n, frozenUntil: 0 });
          break;
        }
      }
      put(id, r);
      sent.push(call);
      return keccak256(`0x${(++n).toString(16).padStart(4, '0')}`);
    },
  };
}

/** Queue a pending change on a record directly, as a `transferOwner` would (since the review of 2026-11-19 it needs a registrar's signature too, so a stolen one). */
export function queueChange(a: MemoryAnchor, handleId: string, newOwner: Address): void {
  const r = a.records.get(handleId.toLowerCase())!;
  a.records.set(handleId.toLowerCase(), {
    ...r,
    pendingKind: CHANGE_KIND.TransferOwner,
    pendingNonce: r.nonce,
    pendingOwner: newOwner,
    pendingReadyAt: a.clock.now + a.delays.change,
    nonce: r.nonce + 1n,
  });
}
