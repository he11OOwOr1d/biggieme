import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { providers, type ProviderId } from '../server/models.ts';
import { SearchService } from '../server/search.ts';

// Runs the production HTTP app with real providers and disposable storage.
// No mocks, existing conversations, credentials, or provider payloads enter the report.
const provider = (process.argv.find(a => a.startsWith('--provider='))?.split('=')[1] || 'openai') as ProviderId;
if (!['openai', 'anthropic', 'compatible'].includes(provider)) throw new Error('Use --provider=openai|anthropic|compatible');
const modelOverride = process.argv.find(a => a.startsWith('--model='))?.slice('--model='.length);
if (modelOverride) process.env[provider === 'openai' ? 'OPENAI_MODEL' : provider === 'anthropic' ? 'ANTHROPIC_MODEL' : 'COMPATIBLE_MODEL'] = modelOverride;
const config = providers().find(p => p.id === provider)!;
const directory = mkdtempSync(join(tmpdir(), 'minimi-live-'));
const results: { check: string; status: 'PASS' | 'FAIL' | 'BLOCKED'; detail: string; ms: number }[] = [];
const reportDir = resolve('test-results');
const reportName = `live-${provider}`;
let base = '';
let child: ReturnType<typeof spawn> | undefined;
let safeDiagnostics = '';
let diagnosticBuffer = '';

let session = '';
let baselineId = '';
let sourceMessageId = '';
const jars = { alice: new Map<string, string>(), bob: new Map<string, string>() };
async function call(path: string, method = 'GET', body?: unknown, user: keyof typeof jars = 'alice', headers: Record<string, string> = {}) {
  const r = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', Cookie: [...jars[user]].map(([k, v]) => `${k}=${v}`).join('; '), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(135_000) });
  for (const c of r.headers.getSetCookie()) { const pair = c.split(';')[0]; const n = pair.indexOf('='); jars[user].set(pair.slice(0, n), pair.slice(n + 1)); }
  return r;
}
async function check(name: string, action: () => Promise<string>) {
  const start = performance.now();
  try { const detail = await action(); results.push({ check: name, status: 'PASS', detail, ms: Math.round(performance.now() - start) }); console.log(`PASS ${name}: ${detail}`); return true; }
  catch (e) {
    // Only assertions/app-owned messages are safe to put in the report.
    const detail = e instanceof Error && e.name === 'AssertionError' ? e.message.split('\n')[0] : 'Request failed; inspect safe server diagnostics and retry.';
    results.push({ check: name, status: 'FAIL', detail, ms: Math.round(performance.now() - start) }); console.log(`FAIL ${name}: ${detail}`);
    if (safeDiagnostics) console.log(safeDiagnostics);
    return false;
  }
}
const groqFreePlan = provider === 'compatible' && !!process.env.COMPATIBLE_BASE_URL
  && new URL(process.env.COMPATIBLE_BASE_URL).hostname === 'api.groq.com';
let lastChatFinished = Date.now();
async function chat(text: string) {
  // Free Groq allows only 8k tokens/minute. Keep test scenarios from competing
  // with their background memory extraction and with the previous scenario.
  if (groqFreePlan) {
    const remaining = 65_000 - (Date.now() - lastChatFinished);
    if (remaining > 0) {
      console.log(`Waiting ${Math.ceil(remaining / 1000)}s for Groq free-plan token recovery…`);
      const until = Date.now() + remaining;
      while (Date.now() < until) await delay(Math.min(1000, until - Date.now()));
    }
  }
  const r = await call('/api/chat', 'POST', { session, text, provider, timezone: 'Asia/Kolkata' });
  assert.equal(r.status, 200, 'Chat endpoint must accept the configured provider');
  assert.match(r.headers.get('content-type') || '', /application\/x-ndjson/);
  const events: any[] = [];
  const reader = r.body!.getReader(); const decoder = new TextDecoder(); let buffer = '';
  while (true) {
    const { value, done } = await reader.read(); buffer += decoder.decode(value, { stream: !done });
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (line.trim()) events.push(JSON.parse(line)); }
    if (done) break;
  }
  if (buffer.trim()) events.push(JSON.parse(buffer));
  const error = events.find(e => e.type === 'error');
  assert.ok(!error, error?.text || 'No streamed error');
  const completed = events.find(e => e.type === 'done');
  assert.ok(completed, 'Stream must contain a terminal done event');
  const answer = events.filter(e => e.type === 'text').map(e => e.text).join('');
  assert.ok(answer.trim(), 'Stream must contain answer text');
  lastChatFinished = Date.now();
  const messages = await (await call(`/api/sessions/${session}/messages`)).json();
  const saved = messages.find((m: any) => m.id === completed.id);
  assert.equal(saved?.status, 'complete', 'Answer must be persisted as complete');
  assert.equal(saved.content, answer, 'Persisted answer must equal streamed text');
  return { answer, events, completed, saved };
}
function blocked(name: string, detail: string) { results.push({ check: name, status: 'BLOCKED', detail, ms: 0 }); console.log(`BLOCKED ${name}: ${detail}`); }
try {
  child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts', '--production'], {
    cwd: process.cwd(), env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATA_DIR: directory, APP_ACCESS_TOKEN: 'live-test-only', DEFAULT_PROVIDER: provider, MEMORY_EXTRACTION: 'true', CHAT_TIMEOUT_MS: '120000' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Deliberately do not print subprocess output: it may contain third-party diagnostics.
  child.stderr!.on('data', chunk => {
    diagnosticBuffer = (diagnosticBuffer + String(chunk)).slice(-12000);
    const match = diagnosticBuffer.match(/\[chat failed\] \{[^}]+\}/g)?.at(-1);
    if (match) safeDiagnostics = match;
  });
  base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Startup timeout')), 15_000);
    child!.stdout!.on('data', chunk => { const match = String(chunk).match(/ready at (http:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    child!.once('error', () => { clearTimeout(timer); reject(new Error('Server launch failed')); });
    child!.once('exit', () => { clearTimeout(timer); reject(new Error('Server exited')); });
  });
  await check('Frontend HTTP and assets', async () => {
    const r = await call('/'); assert.equal(r.status, 200); const html = await r.text();
    const asset = html.match(/src="([^"]+\.js)"/); assert.ok(asset, 'Built frontend script must be served');
    assert.equal((await call(asset[1])).status, 200); return 'HTML and built JavaScript return 200 (browser rendering not tested)';
  });
  await check('Access gate and signed sessions', async () => {
    assert.equal((await call('/api/sessions')).status, 401);
    assert.equal((await call('/api/unlock', 'POST', { token: 'incorrect' })).status, 401);
    for (const user of ['alice', 'bob'] as const) assert.equal((await call('/api/unlock', 'POST', { token: 'live-test-only' }, user)).status, 200);
    const r = await call('/api/config'); assert.equal(r.status, 200); const c = await r.json();
    assert.equal(c.providers.find((p: any) => p.id === provider).model, config.model);
    for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'COMPATIBLE_API_KEY', 'TAVILY_API_KEY']) if (process.env[key]) assert.ok(!JSON.stringify(c).includes(process.env[key]!));
    return `Configuration returned; selected model ${config.model || '(unset)'}; secrets absent`;
  });
  await check('Conversation endpoints and ownership', async () => {
    const r = await call('/api/sessions', 'POST', {}); assert.equal(r.status, 200); session = (await r.json()).id;
    assert.ok((await (await call('/api/sessions')).json()).some((s: any) => s.id === session));
    assert.deepEqual(await (await call(`/api/sessions/${session}/messages`)).json(), []);
    assert.equal((await call(`/api/sessions/${session}/messages`, 'GET', undefined, 'bob')).status, 404);
    assert.equal((await call('/api/sessions', 'POST', {}, 'alice', { Origin: 'https://untrusted.example' })).status, 403);
    assert.equal((await call('/api/chat', 'POST', {})).status, 400);
    return 'Create/list/read work; other-user access and cross-origin mutation rejected';
  });
  if (process.env.TAVILY_API_KEY) await check('Direct Tavily endpoint', async () => {
    const sources = await new SearchService(process.env.TAVILY_API_KEY!).search('SQLite latest version official release notes', false, AbortSignal.timeout(10_000));
    assert.ok(sources.length > 0, 'Tavily must return sources');
    return `${sources.length} live results received; verifies search credentials independently of the model`;
  });
  else blocked('Direct Tavily endpoint', 'TAVILY_API_KEY missing');
  if (!config.available) {
    await check('Unconfigured provider response', async () => {
      assert.equal((await call('/api/chat', 'POST', { session, text: 'Hello', provider, timezone: 'UTC' })).status, 400);
      return 'Missing credentials are rejected before streaming';
    });
    for (const name of ['Live model chat and persistence', 'Memory extraction and cross-chat recall', 'Search and source persistence', 'Follow-up with fresh search', 'Forget memory endpoint']) blocked(name, `Configure credentials for ${provider} (${config.model || 'model unset'}); no live model request was attempted`);
  } else {
    const live = await check('Live model chat and persistence', async () => {
      const r = await chat('Remember that I prefer short practical answers. My test project is called Copperleaf.');
      sourceMessageId = r.completed.userId; baselineId = session;
      return `Completed and persisted; ${r.completed.metrics.totalMs} ms`;
    });
    if (live) {
      await check('Memory extraction and cross-chat recall', async () => {
        let facts: any[] = [];
        const until = Date.now() + 25_000;
        while (Date.now() < until) { facts = (await (await call('/api/memory')).json()).facts; if (facts.some(f => f.source_id === sourceMessageId && /short|practical/i.test(f.value))) break; await delay(500); }
        assert.ok(facts.some(f => f.source_id === sourceMessageId && /short|practical/i.test(f.value)), 'Preference must be extracted with source provenance within 25 seconds');
        session = (await (await call('/api/sessions', 'POST', {})).json()).id;
        const r = await chat('What is my test project called, and what answer style do I prefer?');
        assert.match(r.answer, /Copperleaf/i, 'Cross-chat recall must recover the project name');
        assert.match(r.answer, /short|practical/i, 'Cross-chat recall must recover answer preference');
        return 'Preference saved; new conversation recalls project and answer style';
      });
      if (process.env.TAVILY_API_KEY) {
        const search = await check('Search and source persistence', async () => {
          const r = await chat('Search the web for the current official SQLite release version. Cite the official SQLite release page.');
          assert.ok(r.saved.sources.length > 0, 'A real search must return persisted sources');
          assert.ok(r.saved.sources.some((s: any) => /(^|\.)sqlite\.org$/.test(new URL(s.url).hostname)), 'Search should include an official SQLite source');
          return `${r.saved.sources.length} sources persisted; ${r.completed.metrics.totalMs} ms; factual accuracy not graded`;
        });
        if (search) await check('Follow-up with fresh search', async () => {
          const r = await chat('Has the SQLite version changed since that comparison? Recheck the official site now and compare with the version you just gave.');
          assert.ok(r.saved.sources.length > 0, 'Follow-up must obtain fresh sources');
          return `Follow-up completed with ${r.saved.sources.length} sources; ${r.completed.metrics.totalMs} ms; correctness not graded`;
        });
        else blocked('Follow-up with fresh search', 'Initial search failed; no valid baseline');
      } else { blocked('Search and source persistence', 'TAVILY_API_KEY missing'); blocked('Follow-up with fresh search', 'TAVILY_API_KEY missing'); }
      await check('Forget memory endpoint', async () => {
        const facts = (await (await call('/api/memory')).json()).facts;
        const fact = facts.find((f: any) => f.source_id === sourceMessageId);
        assert.ok(fact, 'Live extraction must provide a fact to forget');
        assert.equal((await call(`/api/memory/${encodeURIComponent(fact.key)}`, 'DELETE')).status, 200);
        assert.ok(!(await (await call('/api/memory')).json()).facts.some((f: any) => f.key === fact.key));
        return 'Fact removed through API';
      });
    } else for (const name of ['Memory extraction and cross-chat recall', 'Search and source persistence', 'Follow-up with fresh search', 'Forget memory endpoint']) blocked(name, 'Initial live model response failed');
  }
  await check('Export and individual message endpoints', async () => {
    const id = baselineId || session;
    const r = await call(`/api/sessions/${id}/export`); assert.equal(r.status, 200);
    const body = await r.text(); const rows = body.trim() ? body.trim().split('\n').map(line => JSON.parse(line)) : [];
    if (sourceMessageId) { assert.ok(rows.length >= 2); assert.equal((await call(`/api/messages/${sourceMessageId}`)).status, 200); assert.equal((await call(`/api/messages/${sourceMessageId}`, 'GET', undefined, 'bob')).status, 404); }
    return `${rows.length} exported records; ${sourceMessageId ? 'message lookup and isolation verified' : 'empty export only; message lookup requires live chat'}`;
  });
  await check('Conversation deletion and memory cleanup', async () => {
    const sessions = await (await call('/api/sessions')).json();
    for (const s of sessions) { assert.equal((await call(`/api/sessions/${s.id}`, 'DELETE')).status, 200); assert.equal((await call(`/api/sessions/${s.id}/messages`)).status, 404); }
    assert.deepEqual(await (await call('/api/sessions')).json(), []);
    assert.deepEqual((await (await call('/api/memory')).json()).facts, []);
    return config.available ? 'Test conversations deleted; memory endpoint empty' : 'Empty conversation deleted; sourced-memory cascade covered by npm test';
  });
} catch {
  results.push({ check: 'Test runner', status: 'FAIL', detail: 'Could not start or complete isolated server checks. Run npm run build first.', ms: 0 });
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child!.once('exit', resolve)); child.kill('SIGTERM');
    const kill = setTimeout(() => child!.kill('SIGKILL'), 3000); await exited; clearTimeout(kill);
  }
  rmSync(directory, { recursive: true, force: true });
  const report = { ranAt: new Date().toISOString(), provider, model: config.model, mode: 'live HTTP, isolated database, no mocks', scope: 'Endpoint and integration checks; no browser automation or answer-quality grading', overall: results.some(r => r.status === 'FAIL') ? 'FAIL' : results.some(r => r.status === 'BLOCKED') ? 'BLOCKED' : 'PASS', results };
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(join(reportDir, `${reportName}.json`), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(join(reportDir, `${reportName}.md`), `# Live verification: ${config.model || provider}\n\nRun: ${report.ranAt}\n\nOverall: **${report.overall}**\n\n${report.scope}.\n\n| Check | Result | Detail |\n| --- | --- | --- |\n${results.map(r => `| ${r.check} | ${r.status} | ${r.detail.replaceAll('|', '/')} |`).join('\n')}\n`);
  console.log(`\n${report.overall}: report saved to test-results/${reportName}.md`);
  process.exitCode = report.overall === 'PASS' ? 0 : report.overall === 'BLOCKED' ? 2 : 1;
}
