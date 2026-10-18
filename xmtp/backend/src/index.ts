// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The XMTP backend as a Cloudflare Container (workspace decision 0042).
 *
 * One Durable Object, `XmtpBackend` named "primary", owns one container running
 * `ghcr.io/xmtp/backend` with ../backend.toml. A cron pokes it every minute so
 * the container is always on (the backend's tailer and push dispatcher must keep
 * running even with no client connected).
 *
 * Ingress is a slot: Cloudflare's inbound TCP for Workers is a private beta
 * (a Spectrum application whose target is this Worker). When the beta is on and
 * `INGRESS` is "tcp", Spectrum ends TLS (ALPN h2) and hands the plaintext stream
 * to `connect()` below, which splices it to the container's port 5050 as h2c.
 * Nothing adds a PROXY protocol header, so no client IP reaches the backend
 * (decision 0039). Until then `connect()` refuses every socket and the Worker
 * has no route, no workers.dev URL and no HTTP surface.
 */

import { DurableObject } from 'cloudflare:workers';

import { containerEnv, type BackendEnv } from './containerEnv.js';
import { openUpstream, splice } from './socket.js';

export interface Env extends BackendEnv {
  XMTP_BACKEND: DurableObjectNamespace<XmtpBackend>;
  /** "off" (default) refuses sockets; "tcp" splices them to the container. */
  INGRESS?: string;
}

/** The backend's plaintext listener (backend.toml `server.listen`). */
export const BACKEND_PORT = 5050;
const INSTANCE = 'primary';
const KEEPALIVE_MS = 60_000;

export class XmtpBackend extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ensureStarted();
      if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now() + KEEPALIVE_MS);
    });
  }

  /** Start the container if it is not running. Throws if a secret is missing. */
  private ensureStarted(): void {
    const container = this.ctx.container;
    if (!container) throw new Error('XmtpBackend has no container: check `containers` in wrangler.jsonc');
    if (container.running) return;
    container.start({ enableInternet: true, env: containerEnv(this.env) });
    // When the process exits, the next alarm or socket starts it again.
    container.monitor().catch(() => undefined);
  }

  async alarm(): Promise<void> {
    this.ensureStarted();
    await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_MS);
  }

  /** RPC for the cron and for `wrangler` checks: is the container up? */
  async status(): Promise<{ running: boolean }> {
    this.ensureStarted();
    return { running: this.ctx.container?.running ?? false };
  }

  /** A client stream from the Worker's `connect()`, spliced to port 5050. */
  async connect(socket: Socket): Promise<void> {
    this.ensureStarted();
    const upstream = await openUpstream(() =>
      this.ctx.container!.getTcpPort(BACKEND_PORT).connect(`10.0.0.1:${BACKEND_PORT}`),
    );
    await splice(socket, upstream);
  }
}

export default {
  async connect(socket: Socket, env: Env): Promise<void> {
    if (env.INGRESS !== 'tcp') {
      await socket.close();
      return;
    }
    const upstream = env.XMTP_BACKEND.getByName(INSTANCE).connect(`xmtp-backend:${BACKEND_PORT}`);
    await splice(socket, upstream);
  },

  // No HTTP surface: health is gRPC only, on the stream itself.
  async fetch(): Promise<Response> {
    return new Response(null, { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await env.XMTP_BACKEND.getByName(INSTANCE).status();
  },
} satisfies ExportedHandler<Env>;
