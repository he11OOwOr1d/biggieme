import { get, put } from '@vercel/blob';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.ts';

export type SnapshotIO = {
  read: (key: string) => Promise<{ bytes: Uint8Array; etag: string } | null>;
  write: (key: string, bytes: Uint8Array, etag?: string) => Promise<string>;
};
const blobIO: SnapshotIO = {
  async read(key) {
    const result = await get(key, { access: 'private', useCache: false });
    if (!result) return null;
    if (result.statusCode !== 200 || !result.stream) throw new Error('Snapshot unavailable');
    return { bytes: new Uint8Array(await new Response(result.stream).arrayBuffer()), etag: result.blob.etag };
  },
  async write(key, bytes, etag) {
    const result = await put(key, Buffer.from(bytes), { access: 'private', addRandomSuffix: false,
      contentType: 'application/vnd.sqlite3', ...(etag ? { ifMatch: etag } : { allowOverwrite: false }) });
    return result.etag;
  },
};
// Small-demo persistence: one private SQLite snapshot per signed browser identity.
// Every request reads fresh; conditional writes reject concurrent lost updates.
export async function openSnapshot(user: string, io: SnapshotIO = blobIO) {
  if (!/^[a-f0-9-]{36}$/i.test(user)) throw new Error('Invalid snapshot identity');
  const key = `minimi/users/${user}.sqlite`;
  const directory = mkdtempSync(join(tmpdir(), 'minimi-request-'));
  let store: Store | undefined; let closed = false;
  try {
    const existing = await io.read(key);
    if (existing) writeFileSync(join(directory, 'minimi.sqlite'), existing.bytes);
    let etag = existing?.etag;
    store = new Store(directory);
    const current = store;
    return {
      store: current,
      async save() {
        current.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        etag = await io.write(key, readFileSync(join(directory, 'minimi.sqlite')), etag);
      },
      dispose() { if (!closed) { closed = true; current.close(); rmSync(directory, { recursive: true, force: true }); } },
    };
  } catch (error) { store?.close(); rmSync(directory, { recursive: true, force: true }); throw error; }
}
