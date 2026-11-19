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
 * Ingress is Cloudflare's inbound TCP for Workers (public beta since
 * 2026-11-19): a Spectrum application on `xmtp.cofferdam.xyz:443` whose origin
 * is this Worker. On a Pro zone Spectrum passes TLS through, so when `INGRESS`
 * is "tcp" `connect()` below splices the client's still-encrypted stream to the
 * container's port 8443, where Caddy ends TLS (ALPN h2) and forwards h2c to the
 * backend on 127.0.0.1:5050 (../Caddyfile, ../start.sh; decision 0042, amended
 * 2026-11-19). Nothing adds a PROXY protocol header, so no client IP reaches the
 * backend (decision 0039); the Worker reads none either. Otherwise `connect()`
 * refuses every socket, and the Worker has no route, no workers.dev URL and no
 * HTTP surface.
 *
 * `RUN` is the on/off switch (paused 2026-11-04: with ingress off no phone can
 * reach the backend, yet the cron kept the object and its container up around
 * the clock). "on" keeps it running as above. Anything else pauses it: the cron
 * returns without waking the object, the object's next alarm destroys the
 * container and sets no new alarm, and a wake by anything else starts nothing.
 * The database, R2 and the secrets stay; "on" and a deploy bring it back.
 */

import { DurableObject } from 'cloudflare:workers';

import { containerEnv, envFingerprint, running, type BackendEnv } from './containerEnv.js';
import { PASSTHROUGH, openUpstream, splice } from './socket.js';

export interface Env extends BackendEnv {
  XMTP_BACKEND: DurableObjectNamespace<XmtpBackend>;
  /** "off" (default) refuses sockets; "tcp" splices them to the container. */
  INGRESS?: string;
  /** "on" keeps the container running; anything else pauses it. */
  RUN?: string;
}

/** Caddy's TLS listener in front of the backend (../Caddyfile); the backend itself is on 5050. */
const INGRESS_PORT = 8443;
const INSTANCE = 'primary';
const KEEPALIVE_MS = 60_000;
/** Storage key: a fingerprint of the environment the running container was started with. */
const STARTED_WITH = 'startedWith';


export class XmtpBackend extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      if (!running(env)) return;
      await this.ensureStarted();
      if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now() + KEEPALIVE_MS);
    });
  }

  /**
   * Start the container if it is not running, and restart it when the
   * environment changed since it started (a rotated secret or a new variable):
   * the backend retries a failing database connection instead of exiting, so
   * without this a corrected `XMTP_DATABASE_URL` never reached it. Throws if a
   * secret is missing.
   */
  private async ensureStarted(): Promise<void> {
    const container = this.ctx.container;
    if (!container) throw new Error('XmtpBackend has no container: check `containers` in wrangler.jsonc');
    const env = containerEnv(this.env);
    const fingerprint = await envFingerprint(env);
    if (container.running) {
      if ((await this.ctx.storage.get<string>(STARTED_WITH)) === fingerprint) return;
      await container.destroy();
    }
    container.start({ enableInternet: true, env });
    await this.ctx.storage.put(STARTED_WITH, fingerprint);
    // When the process exits, the next alarm or socket starts it again.
    container.monitor().catch(() => undefined);
  }

  /** Paused: stop the container and leave no alarm, so the object can sleep. */
  private async stop(): Promise<void> {
    const container = this.ctx.container;
    if (container?.running) await container.destroy();
    await this.ctx.storage.delete(STARTED_WITH);
    await this.ctx.storage.deleteAlarm();
  }

  override async alarm(): Promise<void> {
    if (!running(this.env)) {
      await this.stop();
      return;
    }
    await this.ensureStarted();
    await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_MS);
  }

  /** RPC for the cron and for `wrangler` checks: is the container up? */
  async status(): Promise<{ running: boolean }> {
    if (!running(this.env)) {
      await this.stop();
      return { running: false };
    }
    await this.ensureStarted();
    return { running: this.ctx.container?.running ?? false };
  }

  /** A client stream from the Worker's `connect()`, spliced to Caddy's port 8443. */
  override async connect(socket: Socket): Promise<void> {
    if (!running(this.env)) {
      await socket.close();
      return;
    }
    await this.ensureStarted();
    const upstream = await openUpstream(() =>
      this.ctx.container!.getTcpPort(INGRESS_PORT).connect(`10.0.0.1:${INGRESS_PORT}`, PASSTHROUGH),
    );
    await splice(socket, upstream);
  }
}

export default {
  async connect(socket: Socket, env: Env): Promise<void> {
    if (env.INGRESS !== 'tcp' || !running(env)) {
      await socket.close();
      return;
    }
    const upstream = env.XMTP_BACKEND.getByName(INSTANCE).connect(`xmtp-backend:${INGRESS_PORT}`, PASSTHROUGH);
    await splice(socket, upstream);
  },

  // No HTTP surface: health is gRPC only, on the stream itself.
  async fetch(): Promise<Response> {
    return new Response(null, { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    // Paused: leave the object asleep; its own last alarm stops the container.
    if (!running(env)) return;
    await env.XMTP_BACKEND.getByName(INSTANCE).status();
  },
} satisfies ExportedHandler<Env>;
