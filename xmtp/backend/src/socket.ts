// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/** Socket plumbing for the ingress slot, kept apart from the runtime imports so it is testable. */

/**
 * Options for both hops of the ingress (Worker to object, object to container),
 * as Cloudflare's inbound-TCP example sets them: the bytes are the client's TLS,
 * so neither hop adds its own, and each direction may end on its own (half-open).
 */
export const PASSTHROUGH: SocketOptions = { allowHalfOpen: true, secureTransport: 'off' };

/** Migrations run before the listener binds; give a cold start this long. */
export const UPSTREAM_DEADLINE_MS = 45_000;

/** Retry the container's port while it boots (migrations, then listen). */
export async function openUpstream(
  open: () => Socket,
  deadlineMs = UPSTREAM_DEADLINE_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<Socket> {
  const started = Date.now();
  let wait = 250;
  for (;;) {
    const socket = open();
    try {
      await socket.opened;
      return socket;
    } catch (err) {
      if (Date.now() - started + wait > deadlineMs) throw err;
      await sleep(wait);
      wait = Math.min(wait * 2, 4_000);
    }
  }
}

/** Pipe both directions; close both when either side ends. */
export async function splice(a: Socket, b: Socket): Promise<void> {
  await Promise.allSettled([a.readable.pipeTo(b.writable), b.readable.pipeTo(a.writable)]);
  await Promise.allSettled([a.close(), b.close()]);
}
