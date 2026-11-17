import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, PROFILE_CAP } from '../server/store.ts';
import { timeContext } from '../server/time.ts';
import { SearchService } from '../server/search.ts';
import { runChat, type ChatEvent } from '../server/agent.ts';
import { MockLanguageModelV4 } from 'ai/test';

const now = new Date('2026-11-15T10:00:00Z');
function fixture(t: any) {
  const directory = mkdtempSync(join(tmpdir(), 'minimi-test-'));
  const store = new Store(directory); store.user('alice', 'Asia/Kolkata'); store.user('bob', 'UTC');
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}
test('relative weekdays resolve against the supplied clock, not host date', () => {
  const c = timeContext('Last Tuesday I asked about Postgres', 'Asia/Kolkata', now);
  assert.equal(c.windows[0].start, '2026-11-09T18:30:00.000Z');
  assert.match(c.windows[0].label, /Tuesday, 10 November 2026/);
  assert.match(timeContext('on Monday', 'UTC', now).windows[0].label, /9 November/);
});
test('a local calendar day handles DST and midnight correctly', () => {
  const c = timeContext('What did I ask on 2026-11-01?', 'America/New_York', now);
  assert.equal(Date.parse(c.windows[0].end) - Date.parse(c.windows[0].start), 25 * 3600_000);
  const india = timeContext('yesterday', 'Asia/Kolkata', new Date('2026-11-15T20:00:00Z'));
  assert.match(india.windows[0].label, /15 November/);
});
test('missing years produce candidates; inconsistent weekdays are explicit', () => {
  assert.equal(timeContext('What did I ask on 3 November?', 'UTC', now).windows.length, 3);
  assert.match(timeContext('Monday November 3, 2026', 'UTC', now).warning!, /do not match/);
  assert.equal(timeContext('3 November 2025', 'UTC', now).windows.length, 1);
});
test('date-only recall returns original questions AND answers across chats', t => {
  const s = fixture(t); const chat = s.create('alice');
  s.add('alice', chat.id, 'user', 'Compare Neon and Supabase for Postgres.', 'complete', [], '2026-11-03T09:00:00.000Z');
  s.add('alice', chat.id, 'assistant', 'We discussed their free plans and compute limits.', 'complete', [], '2026-11-03T09:00:01.000Z');
  const window = timeContext('What did I ask on 3 November 2026?', 'UTC', now).windows;
  const result = s.retrieve('alice', 'What did I ask?', window);
  assert.equal(result.messages.length, 2); assert.match(result.messages[0].content, /Neon/); assert.match(result.messages[1].content, /compute/);
});
test('FTS is scoped before ranking and includes neighboring turns', t => {
  const s = fixture(t); const a = s.create('alice'); const b = s.create('bob');
  s.add('alice', a.id, 'user', 'We shortlisted five CRM tools for 20 people.');
  s.add('alice', a.id, 'assistant', 'HubSpot, Pipedrive, Salesforce, Zoho and Freshsales.');
  for (let i = 0; i < 12; i++) s.add('bob', b.id, 'user', 'CRM CRM CRM private secret shortlist');
  const r = s.retrieve('alice', 'CRM shortlist', []);
  assert.ok(r.messages.length); assert.ok(r.messages.every(m => m.session_id === a.id));
  assert.ok(r.messages.some(m => m.content.includes('Freshsales')));
});
test('mentioned event dates are searchable without confusing when a question was asked', t => {
  const s = fixture(t); const chat = s.create('alice');
  s.add('alice', chat.id, 'user', 'On Monday we shortlisted HubSpot and Pipedrive.', 'complete', [], '2026-11-11T09:00:00.000Z');
  const windows = timeContext('On Monday we shortlisted tools', 'Asia/Kolkata', now).windows;
  assert.equal(s.retrieve('alice', 'On Monday we shortlisted tools', windows).messages.length, 1);
  assert.equal(s.retrieve('alice', 'What did I ask on Monday?', windows).messages.length, 0);
});
test('missing memory stays missing; assistant failures are excluded', t => {
  const s = fixture(t); const a = s.create('alice'); s.add('alice', a.id, 'assistant', 'Fictional zebraproduct', 'failed');
  assert.equal(s.retrieve('alice', 'zebraproduct', []).messages.length, 0);
  assert.equal(s.retrieve('alice', 'unmentionedsubject', []).messages.length, 0);
  assert.throws(() => s.messages('bob', a.id), /not found/);
});
test('profiles require source quotes and are capped without losing transcripts', t => {
  const s = fixture(t); const a = s.create('alice');
  const id = s.add('alice', a.id, 'user', 'I prefer concise answers and TypeScript.');
  s.saveFacts('alice', [{ key: 'answer_style', value: 'Concise', quote: 'I prefer concise answers', source_id: id }, { key: 'invented', value: 'CEO', quote: 'I am a CEO', source_id: id }]);
  assert.equal(s.facts('alice').length, 1);
  for (let i = 0; i < 20; i++) s.saveFacts('alice', [{ key: `pref_${i}`, value: 'x'.repeat(200), quote: 'TypeScript', source_id: id }]);
  assert.ok(s.profile('alice').length <= PROFILE_CAP); assert.equal(s.messages('alice', a.id).length, 1);
  assert.equal(s.facts('bob').length, 0);
});
test('corrections replace a key and delayed jobs cannot reverse or resurrect it', t => {
  const s = fixture(t); const a = s.create('alice');
  const old = s.add('alice', a.id, 'user', 'I prefer long answers.', 'complete', [], '2026-11-01T10:00:00Z');
  const newer = s.add('alice', a.id, 'user', 'Actually, I prefer concise answers.', 'complete', [], '2026-11-02T10:00:00Z');
  const oldFact = { key: 'answer_style', value: 'Long', quote: 'long answers', source_id: old };
  s.saveFacts('alice', [oldFact]); s.saveFacts('alice', [{ ...oldFact, value: 'Concise', quote: 'concise answers', source_id: newer }]); s.saveFacts('alice', [oldFact]);
  assert.equal(s.facts('alice')[0].value, 'Concise'); s.forget('alice', 'answer_style');
  s.saveFacts('alice', [oldFact]); assert.equal(s.facts('alice').length, 0);
});
test('JSONL is valid and deletion removes derived facts and FTS hits', t => {
  const s = fixture(t); const a = s.create('alice'); const id = s.add('alice', a.id, 'user', 'I work on project Moonbeam.');
  s.saveFacts('alice', [{ key: 'project', value: 'Moonbeam', quote: 'project Moonbeam', source_id: id }]);
  assert.equal(JSON.parse(s.jsonl('alice', a.id).trim()).id, id);
  const path = join(s.directory, 'users/alice/chats', `${a.id}.jsonl`); assert.equal(readFileSync(path, 'utf8'), s.jsonl('alice', a.id));
  s.remove('alice', a.id); assert.equal(s.facts('alice').length, 0); assert.equal(s.retrieve('alice', 'Moonbeam', []).messages.length, 0);
});
test('startup repairs a damaged JSONL projection from committed database records', t => {
  const s = fixture(t); const a = s.create('alice'); s.add('alice', a.id, 'user', 'A committed question.');
  const path = join(s.directory, 'users/alice/chats', `${a.id}.jsonl`);
  writeFileSync(path, '{partial broken line');
  const restarted = new Store(s.directory);
  assert.equal(readFileSync(path, 'utf8'), restarted.jsonl('alice', a.id)); restarted.close();
});
test('search preserves observation dates, caches normal requests, bypasses freshness cache', async () => {
  let calls = 0;
  const service = new SearchService('test', async () => { calls++; return Response.json({ results: [{ url: 'https://example.com/pricing', title: 'Pricing', content: '$25 annually' }] }); });
  const first = await service.search('pricing', false); await service.search('pricing', false); assert.equal(calls, 1);
  await service.search('pricing', true); assert.equal(calls, 2); assert.ok(first[0].observedAt); assert.equal(first[0].publishedAt, undefined);
});
test('parallel search returns partial results with explicit errors', async () => {
  let concurrent = 0; let maximum = 0;
  const service = new SearchService('test', async (_url, init) => {
    concurrent++; maximum = Math.max(maximum, concurrent); const q = JSON.parse(String(init?.body)).query;
    await new Promise(resolve => setTimeout(resolve, 5)); concurrent--;
    return q === 'failure' ? new Response('', { status: 503 }) : Response.json({ results: [{ url: 'https://example.com', content: q }] });
  });
  const tool = service.makeTool([], () => {}, () => {});
  const r = await tool.execute!({ queries: ['working', 'failure'], fresh: true }, {} as any) as any;
  assert.equal(maximum, 2); assert.equal(r.sources.length, 1); assert.equal(r.errors.length, 1);
});
test('application freshness policy overrides a model forgetting the fresh flag', async () => {
  let calls = 0;
  const service = new SearchService('test', async () => { calls++; return Response.json({ results: [] }); });
  await service.search('current pricing', false);
  const tool = service.makeTool([], () => {}, () => {}, undefined, true);
  await tool.execute!({ queries: ['current pricing'], fresh: false }, {} as any);
  assert.equal(calls, 2);
});
const usage = { inputTokens: { total: 50, noCache: 50, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 10, text: 10, reasoning: undefined } };
function stream(chunks: any[]) { return { stream: new ReadableStream({ start(c) { chunks.forEach(chunk => c.enqueue(chunk)); c.close(); } }) }; }
test('SDK tool loop retrieves memory, executes the one tool, streams and persists evidence', async t => {
  const s = fixture(t); const old = s.create('alice'); const current = s.create('alice');
  s.add('alice', old.id, 'user', 'Tell me about Neon Postgres.', 'complete', [], '2026-11-10T10:00:00Z');
  s.add('alice', old.id, 'assistant', 'The plan was $19.', 'complete', [], '2026-11-10T10:00:01Z');
  let calls = 0;
  const model = new MockLanguageModelV4({ doStream: async params => {
    const payload = JSON.stringify(params.prompt); calls++;
    if (calls === 1) {
      assert.match(payload, /plan was \$19/); assert.equal(params.tools?.length, 1);
      return stream([{ type: 'tool-call', toolCallId: 'search-1', toolName: 'web_search', input: JSON.stringify({ queries: ['Neon pricing official'], fresh: true }) }, { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage }]);
    }
    assert.match(payload, /\$25/);
    return stream([{ type: 'text-start', id: 'answer' }, { type: 'text-delta', id: 'answer', delta: 'We said $19; the current page lists $25. [Pricing](https://example.com/pricing)' }, { type: 'text-end', id: 'answer' }, { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage }]);
  } });
  const search = new SearchService('test', async () => Response.json({ results: [{ title: 'Pricing', url: 'https://example.com/pricing', content: '$25' }] }));
  const events: ChatEvent[] = [];
  const result = await runChat({ store: s, search, user: 'alice', session: current.id, text: 'Last Tuesday I asked about Postgres. Has pricing changed?', timezone: 'UTC', provider: 'compatible', model, now, signal: new AbortController().signal, emit: e => events.push(e) });
  assert.equal(calls, 2); assert.match(result.text, /current page/); assert.ok(events.some(e => e.type === 'done'));
  const saved = s.messages('alice', current.id).at(-1)!; assert.equal(saved.status, 'complete'); assert.equal(saved.sources.length, 1);
});
test('a broken model stream is persisted as failed and never as a complete answer', async t => {
  const s = fixture(t); const chat = s.create('alice');
  const model = new MockLanguageModelV4({ doStream: async () => stream([{ type: 'error', error: new Error('upstream failed') }]) });
  await assert.rejects(runChat({ store: s, search: new SearchService(''), user: 'alice', session: chat.id, text: 'Hi', timezone: 'UTC', provider: 'compatible', model, signal: new AbortController().signal, emit: () => {} }));
  assert.equal(s.messages('alice', chat.id).at(-1)?.status, 'failed');
});

test('compact search evidence bounds model context while preserving full stored sources', async () => {
  const content = 'e'.repeat(1600);
  const service = new SearchService('test', async () => Response.json({ results: [{ url: 'https://example.com/pricing', content }] }));
  let stored: any[] = [];
  const tool = service.makeTool([], sources => { stored = sources; }, () => {}, undefined, true, true);
  const result = await tool.execute!({ queries: ['official pricing'], fresh: true }, {} as any) as any;
  assert.equal(stored[0].content, content);
  assert.equal(result.sources[0].content.length, 500);
  assert.equal(result.sources[0].truncated, true);
  assert.equal(result.sources[0].url, stored[0].url);
});
