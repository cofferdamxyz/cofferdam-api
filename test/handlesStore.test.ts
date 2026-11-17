// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';

import { handleIdOf, isStoredHandle } from '../src/services/handles/grammar.js';
import { availabilityOf, D1HandleStore, HOLD_LOG_RETENTION_MS, QUARANTINE_MS, resolutionOf, type HandleRow } from '../src/services/handles/store.js';
import { handlesD1, insertHandle } from './fixtures/handles/d1.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

const row = (over: Partial<HandleRow> = {}): HandleRow => ({
  label: 'ana',
  handleId: handleIdOf('ana'),
  identity: 'id-1',
  state: 'active',
  serial: 1,
  owner: '0x' + 'ab'.repeat(20),
  metaAddress: '0x02' + 'aa'.repeat(32) + '03' + 'bb'.repeat(32),
  onchain: true,
  discoverable: false,
  inboxId: null,
  heldUntil: null,
  releasedAt: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe('migrations/handles on local D1 (node:sqlite)', () => {
  it('creates the tables and seeds a reserved list in the stored form', () => {
    const db = handlesD1();
    const tables = (db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(
      (t) => t.name,
    );
    expect(tables).toEqual(['announcement_cursor', 'announcements', 'handle_holds', 'handles', 'reserved_labels', 'share_links']);
    const reserved = (db.sqlite.prepare('SELECT label FROM reserved_labels').all() as { label: string }[]).map((r) => r.label);
    expect(reserved.length).toBeGreaterThan(50);
    expect(reserved.filter((l) => !isStoredHandle(l))).toEqual([]);
    for (const word of ['cofferdam', 'available', 'search', 'claim', 'inbox', 'self', 'pending', 'support', 'admin']) expect(reserved).toContain(word);
  });

  it('holds one label per identity, held or active, and lets a releasing one stand beside the new (a rename)', () => {
    const db = handlesD1();
    insertHandle(db, { label: 'ana', handle_id: handleIdOf('ana'), identity: 'id-1' });
    expect(() => insertHandle(db, { label: 'ana2', handle_id: handleIdOf('ana2'), identity: 'id-1' })).toThrow(/UNIQUE/);
    expect(() =>
      insertHandle(db, { label: 'ana3', handle_id: handleIdOf('ana3'), identity: 'id-1', state: 'held', serial: null, owner: null, meta_address: null, onchain: 0, held_until: NOW }),
    ).toThrow(/UNIQUE/);
    db.sqlite.prepare("UPDATE handles SET state = 'releasing' WHERE label = 'ana'").run();
    insertHandle(db, { label: 'ana-new', handle_id: handleIdOf('ana-new'), identity: 'id-1', serial: 1 });
    expect((db.sqlite.prepare('SELECT COUNT(*) AS n FROM handles').get() as { n: number }).n).toBe(2);
  });

  it('refuses rows the rules forbid', () => {
    const db = handlesD1();
    const base = { label: 'bob', handle_id: handleIdOf('bob') };
    // A held row carries its lapse and nothing on chain; any other state but reserved carries its keys.
    expect(() => insertHandle(db, { ...base, state: 'held' })).toThrow(/CHECK/);
    expect(() => insertHandle(db, { ...base, state: 'held', held_until: NOW, onchain: 1, serial: null, owner: null, meta_address: null })).toThrow(/CHECK/);
    expect(() => insertHandle(db, { ...base, held_until: NOW })).toThrow(/CHECK/);
    expect(() => insertHandle(db, { ...base, owner: null })).toThrow(/CHECK/);
    // The inbox id only while discoverable; a quarantined row has its release time.
    expect(() => insertHandle(db, { ...base, inbox_id: 'inbox' })).toThrow(/CHECK/);
    expect(() => insertHandle(db, { ...base, state: 'quarantined' })).toThrow(/CHECK/);
    // Shapes: lower-case hex, 66 bytes of meta-address, a known state, a label of 3 to 64.
    expect(() => insertHandle(db, { ...base, owner: '0x' + 'AB'.repeat(20) })).toThrow(/CHECK/);
    expect(() => insertHandle(db, { ...base, meta_address: '0x' + 'aa'.repeat(33) })).toThrow(/CHECK/);
    expect(() => insertHandle(db, { ...base, state: 'frozen' })).toThrow(/CHECK/);
    expect(() => insertHandle(db, { label: 'bo', handle_id: handleIdOf('bo') })).toThrow(/CHECK/);
    expect(() => insertHandle(db, { ...base, handle_id: 'ab'.repeat(33) })).toThrow(/CHECK/);
    insertHandle(db, base);
    expect(() => insertHandle(db, { label: 'bob2', handle_id: handleIdOf('bob') })).toThrow(/UNIQUE/);
    // A share link holds 1 to 2,048 bytes.
    expect(() => db.sqlite.prepare('INSERT INTO share_links VALUES (?, ?, ?)').run('a'.repeat(64), new Uint8Array(2049), NOW)).toThrow(/CHECK/);
    expect(() => db.sqlite.prepare('INSERT INTO share_links VALUES (?, ?, ?)').run('a'.repeat(64), new Uint8Array(0), NOW)).toThrow(/CHECK/);
  });
});

describe('what a payer may see (resolutionOf)', () => {
  it('answers an active row, and a queued claim with its pending owner marked unchecked (q22)', () => {
    expect(resolutionOf(row())).toEqual({
      label: 'ana',
      handleId: handleIdOf('ana'),
      serial: 1,
      owner: getAddress('0x' + 'ab'.repeat(20)),
      metaAddress: row().metaAddress,
      schemeId: 1,
      onChain: true,
    });
    expect(resolutionOf(row({ onchain: false }))!.onChain).toBe(false);
  });

  it('answers held, releasing (q13), quarantined and reserved labels exactly as an unknown one', () => {
    expect(resolutionOf(null)).toBeNull();
    for (const state of ['held', 'releasing', 'quarantined', 'reserved'] as const) expect(resolutionOf(row({ state }))).toBeNull();
    // Discovery off changes nothing for payment (rule 6).
    expect(resolutionOf(row({ discoverable: false }))).not.toBeNull();
  });
});

describe('whether a label may be taken (availabilityOf)', () => {
  it('reads the reserved list first, then the row', () => {
    expect(availabilityOf(null, false, NOW)).toEqual({ available: true });
    expect(availabilityOf(null, true, NOW)).toEqual({ available: false, reason: 'reserved' });
    expect(availabilityOf(row(), false, NOW)).toEqual({ available: false, reason: 'taken' });
    expect(availabilityOf(row({ state: 'releasing' }), false, NOW)).toEqual({ available: false, reason: 'taken' });
    expect(availabilityOf(row({ state: 'reserved' }), false, NOW)).toEqual({ available: false, reason: 'reserved' });
  });

  it('answers a held label as taken until its hold lapses (q20), and a released one until its 365 days pass', () => {
    expect(availabilityOf(row({ state: 'held', heldUntil: NOW + 1 }), false, NOW)).toEqual({ available: false, reason: 'taken' });
    expect(availabilityOf(row({ state: 'held', heldUntil: NOW }), false, NOW)).toEqual({ available: true });
    const released = NOW - QUARANTINE_MS;
    expect(availabilityOf(row({ state: 'quarantined', releasedAt: released + 1 }), false, NOW)).toEqual({ available: false, reason: 'taken' });
    expect(availabilityOf(row({ state: 'quarantined', releasedAt: released }), false, NOW)).toEqual({ available: true });
  });
});

describe('D1HandleStore', () => {
  it('reads a row and the reserved list', async () => {
    const db = handlesD1();
    insertHandle(db, { label: 'ana', handle_id: handleIdOf('ana'), onchain: 0, discoverable: 1, inbox_id: 'inbox-1' });
    const store = new D1HandleStore(db.d1);
    expect(await store.row('ana')).toMatchObject({ label: 'ana', state: 'active', onchain: false, discoverable: true, inboxId: 'inbox-1', serial: 1 });
    expect(await store.row('bob')).toBeNull();
    expect(await store.reserved('support')).toBe(true);
    expect(await store.reserved('ana')).toBe(false);
  });

  it('gives a share link once, nothing after expiry, and refuses a taken hash', async () => {
    const db = handlesD1();
    const store = new D1HandleStore(db.d1);
    const bytes = Uint8Array.from([1, 2, 3]);
    expect(await store.putShareLink('a'.repeat(64), bytes, NOW + 10)).toBe(true);
    expect(await store.putShareLink('a'.repeat(64), bytes, NOW + 10)).toBe(false);
    expect(await store.takeShareLink('a'.repeat(64), NOW)).toEqual(bytes);
    expect(await store.takeShareLink('a'.repeat(64), NOW)).toBeNull();
    await store.putShareLink('b'.repeat(64), bytes, NOW);
    expect(await store.takeShareLink('b'.repeat(64), NOW)).toBeNull();
    // The expired row went with the fetch.
    expect((db.sqlite.prepare('SELECT COUNT(*) AS n FROM share_links').get() as { n: number }).n).toBe(0);
  });

  it('sweeps expired links, lapsed holds (logging the lapse) and hold-log rows past 31 days, and nothing else', async () => {
    const db = handlesD1();
    const store = new D1HandleStore(db.d1);
    await store.putShareLink('a'.repeat(64), Uint8Array.of(1), NOW - 1);
    await store.putShareLink('b'.repeat(64), Uint8Array.of(1), NOW + DAY);
    const held = { state: 'held', serial: null, owner: null, meta_address: null, onchain: 0 };
    insertHandle(db, { label: 'gone', handle_id: handleIdOf('gone'), identity: 'id-1', ...held, held_until: NOW - 1 });
    insertHandle(db, { label: 'kept', handle_id: handleIdOf('kept'), identity: 'id-2', ...held, held_until: NOW + DAY });
    insertHandle(db, { label: 'live', handle_id: handleIdOf('live'), identity: 'id-3' });
    const hold = db.sqlite.prepare('INSERT INTO handle_holds (label, identity, install_tag, held_at, held_until, ended_at, outcome) VALUES (?, ?, ?, ?, ?, ?, ?)');
    hold.run('gone', 'id-1', 'install-1', NOW - 14 * DAY, NOW - 1, null, null);
    hold.run('kept', 'id-2', 'install-2', NOW - DAY, NOW + DAY, null, null);
    hold.run('old', 'id-4', 'install-4', NOW - 60 * DAY, NOW - 46 * DAY, NOW - HOLD_LOG_RETENTION_MS - 1, 'lapsed');
    hold.run('recent', 'id-5', 'install-5', NOW - 20 * DAY, NOW - 6 * DAY, NOW - 6 * DAY, 'lapsed');
    expect(await store.sweep(NOW)).toEqual({ links: 1, holds: 1, holdLog: 1 });
    expect((db.sqlite.prepare('SELECT label FROM handles ORDER BY label').all() as { label: string }[]).map((r) => r.label)).toEqual(['kept', 'live']);
    expect(db.sqlite.prepare('SELECT label, outcome, ended_at FROM handle_holds ORDER BY label').all()).toEqual([
      { label: 'gone', outcome: 'lapsed', ended_at: NOW },
      { label: 'kept', outcome: null, ended_at: null },
      { label: 'recent', outcome: 'lapsed', ended_at: NOW - 6 * DAY },
    ]);
    expect((db.sqlite.prepare('SELECT COUNT(*) AS n FROM share_links').get() as { n: number }).n).toBe(1);
  });
});
