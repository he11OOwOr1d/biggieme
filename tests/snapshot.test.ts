import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openSnapshot, type SnapshotIO } from '../server/snapshot.ts';
function memoryIO(): SnapshotIO {
  const data = new Map<string, { bytes: Uint8Array; etag: string }>();
  return {
    async read(key) { const row = data.get(key); return row ? { bytes: row.bytes.slice(), etag: row.etag } : null; },
    async write(key, bytes, etag) {
      const row = data.get(key);
      if (row ? row.etag !== etag : !!etag) throw new Error('Concurrent snapshot changed');
      const version = randomUUID(); data.set(key, { bytes: bytes.slice(), etag: version }); return version;
    },
  };
}
test('private snapshots survive request teardown and conversation deletion removes sourced memories', async () => {
  const io = memoryIO(); const user = randomUUID();
  const a = await openSnapshot(user, io); a.store.user(user, 'UTC');
  const chat = a.store.create(user); const message = a.store.add(user, chat.id, 'user', 'I prefer short practical answers.');
  a.store.saveFacts(user, [{ key: 'answer_style', value: 'Short practical answers', quote: 'short practical answers', source_id: message }]);
  a.store.saveTrace(user, message, { events: [{ stage: 'history' }] });
  await a.save(); a.dispose();
  const b = await openSnapshot(user, io);
  assert.equal(b.store.messageTrace(user, message).events[0].stage, 'history');
  assert.equal(b.store.messages(user, chat.id).length, 1); assert.equal(b.store.facts(user).length, 1);
  b.store.remove(user, chat.id); await b.save(); b.dispose();
  const c = await openSnapshot(user, io);
  assert.deepEqual(c.store.sessions(user), []); assert.deepEqual(c.store.facts(user), []); c.dispose();
  const other = await openSnapshot(randomUUID(), io);
  assert.equal(other.store.db.prepare('SELECT count(*) AS n FROM messages').get()!.n, 0); other.dispose();
});
test('stale and competing initial snapshots cannot overwrite a newer conversation', async () => {
  const io = memoryIO(); const user = randomUUID();
  const a = await openSnapshot(user, io); const b = await openSnapshot(user, io);
  a.store.user(user, 'UTC'); a.store.create(user); await a.save();
  b.store.user(user, 'UTC'); b.store.create(user); await assert.rejects(b.save(), /Concurrent/);
  a.dispose(); b.dispose();
  const c = await openSnapshot(user, io); const d = await openSnapshot(user, io);
  c.store.create(user); await c.save(); d.store.create(user); await assert.rejects(d.save(), /Concurrent/);
  c.dispose(); d.dispose();
  const last = await openSnapshot(user, io); assert.equal(last.store.sessions(user).length, 2); last.dispose();
});
