/** The in-memory `VaultStore` for the Vault routes' tests: R2's checksum check and its error shape, with cursor paging. */
import {
  R2_BAD_DIGEST,
  VAULT_PAGE,
  type VaultListPage,
  type VaultObjectBody,
  type VaultObjectInfo,
  type VaultPutOptions,
  type VaultStore,
} from '../src/services/vault/store.js';

/** The error workerd throws for a failed R2 call: `name`, `code`, `action`, and the message it formats. */
export class R2ShapedError extends Error {
  readonly code: number;
  readonly action: string;
  constructor(action: string, code: number, detail: string) {
    super(`${action}: ${detail} (${code})`);
    this.name = 'R2Error';
    this.code = code;
    this.action = action;
  }
}

async function readAll(body: ReadableStream<Uint8Array> | Uint8Array): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body.slice();
  return new Uint8Array(await new Response(body).arrayBuffer());
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

interface Stored {
  bytes: Uint8Array;
  etag: string;
  uploaded: Date;
}

/** A map behind the `VaultStore` seam, with R2's checksum refusal and paging. */
export class MemoryVaultStore implements VaultStore {
  readonly objects = new Map<string, Stored>();
  /** Every call's method, in order (never its key). */
  readonly calls: string[] = [];
  /** Set to make every call throw it (a store outage). */
  failWith: Error | null = null;

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly page = VAULT_PAGE,
  ) {}

  private call(method: string) {
    this.calls.push(method);
    if (this.failWith) throw this.failWith;
  }

  private infoOf(key: string, s: Stored): VaultObjectInfo {
    return { key, size: s.bytes.byteLength, etag: s.etag, uploaded: s.uploaded };
  }

  async put(key: string, body: ReadableStream<Uint8Array> | Uint8Array, opts?: VaultPutOptions): Promise<VaultObjectInfo> {
    this.call('put');
    const bytes = await readAll(body);
    const actual = await sha256Hex(bytes);
    if (opts?.sha256 && opts.sha256.toLowerCase() !== actual) {
      throw new R2ShapedError(
        'put',
        R2_BAD_DIGEST,
        [
          'The SHA-256 checksum you specified did not match what we received.',
          `You provided a SHA-256 checksum with value: ${opts.sha256.toLowerCase()}`,
          `Actual SHA-256 was: ${actual}`,
        ].join('\n'),
      );
    }
    const stored = { bytes, etag: `"${actual.slice(0, 32)}"`, uploaded: this.now() };
    this.objects.set(key, stored);
    return this.infoOf(key, stored);
  }

  async get(key: string): Promise<VaultObjectBody | null> {
    this.call('get');
    const s = this.objects.get(key);
    if (!s) return null;
    const bytes = s.bytes.slice();
    return {
      ...this.infoOf(key, s),
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
    };
  }

  async head(key: string): Promise<VaultObjectInfo | null> {
    this.call('head');
    const s = this.objects.get(key);
    return s ? this.infoOf(key, s) : null;
  }

  async delete(keys: string[]): Promise<void> {
    this.call('delete');
    if (keys.length > VAULT_PAGE) throw new R2ShapedError('delete', 10029, 'Too many keys');
    for (const k of keys) this.objects.delete(k);
  }

  async list({ prefix, cursor }: { prefix: string; cursor?: string }): Promise<VaultListPage> {
    this.call('list');
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    // The cursor is the last key answered, so a page survives deletions in between.
    const from = cursor === undefined ? 0 : keys.findIndex((k) => k > cursor);
    const slice = from < 0 ? [] : keys.slice(from, from + this.page);
    const more = from >= 0 && from + this.page < keys.length;
    return {
      objects: slice.map((k) => this.infoOf(k, this.objects.get(k)!)),
      ...(more ? { cursor: slice[slice.length - 1] } : {}),
    };
  }
}
