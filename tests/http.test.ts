import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('HTTP app: signed sessions, access gate, real compatible adapter, streaming, export and isolation', { timeout: 20_000 }, async t => {
  let modelRequest: any;
  const upstream = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part; modelRequest = JSON.parse(body);
    assert.equal(req.url, '/v1/chat/completions');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ id: 'test-response', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello from the compatible provider.' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: 'test-response', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const providerPort = (upstream.address() as any).port;
  const directory = mkdtempSync(join(tmpdir(), 'minimi-http-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts', '--production'], {
    cwd: process.cwd(), env: { ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: directory, OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', TAVILY_API_KEY: '', COMPATIBLE_API_KEY: 'fixture-only', COMPATIBLE_BASE_URL: `http://127.0.0.1:${providerPort}/v1`, COMPATIBLE_MODEL: 'fixture-model', DEFAULT_PROVIDER: 'compatible', MEMORY_EXTRACTION: 'false', APP_ACCESS_TOKEN: 'fixture-access' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); });
  const base = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Test server did not become ready')), 10_000);
    child.stdout.on('data', chunk => { const match = String(chunk).match(/ready at (http:\/\/[^\s]+)/); if (match) { clearTimeout(timeout); resolve(match[1]); } });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Test server exited with ${code}`)); });
  });
  const jars = { alice: new Map<string, string>(), bob: new Map<string, string>() };
  async function call(user: 'alice' | 'bob', path: string, init: RequestInit = {}) {
    const response = await fetch(`${base}/api${path}`, { ...init, headers: { 'Content-Type': 'application/json', Cookie: [...jars[user]].map(([key, value]) => `${key}=${value}`).join('; '), ...init.headers } });
    for (const cookie of response.headers.getSetCookie()) { const pair = cookie.split(';')[0]; const equals = pair.indexOf('='); jars[user].set(pair.slice(0, equals), pair.slice(equals + 1)); }
    return response;
  }
  assert.equal((await call('alice', '/sessions')).status, 401);
  assert.equal((await call('alice', '/unlock', { method: 'POST', body: JSON.stringify({ token: 'wrong' }) })).status, 401);
  for (const user of ['alice', 'bob'] as const) {
    assert.equal((await call(user, '/unlock', { method: 'POST', body: JSON.stringify({ token: 'fixture-access' }) })).status, 200);
    const config = await (await call(user, '/config')).json(); assert.ok(config.providers.find((p: any) => p.id === 'compatible').available);
    assert.ok(!JSON.stringify(config).includes('fixture-only'));
  }
  const session = await (await call('alice', '/sessions', { method: 'POST', body: '{}' })).json();
  assert.equal((await call('bob', `/sessions/${session.id}/messages`)).status, 404);
  const blocked = await call('alice', '/sessions', { method: 'POST', headers: { Origin: 'https://attacker.example' }, body: '{}' }); assert.equal(blocked.status, 403);
  const response = await call('alice', '/chat', { method: 'POST', body: JSON.stringify({ session: session.id, text: 'Hello', provider: 'compatible', timezone: 'Asia/Kolkata' }) });
  assert.equal(response.status, 200);
  const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(events.some(e => e.type === 'text' && e.text.includes('compatible provider'))); assert.ok(events.some(e => e.type === 'done'));
  assert.equal(modelRequest.tools.length, 1); assert.equal(modelRequest.tools[0].function.name, 'web_search');
  const messages = await (await call('alice', `/sessions/${session.id}/messages`)).json();
  assert.equal(messages.length, 2); assert.equal(messages[1].status, 'complete');
  assert.equal((await call('bob', `/messages/${messages[0].id}`)).status, 404);
  assert.equal((await (await call('alice', `/messages/${messages[0].id}`)).json()).content, 'Hello');
  const exported = await (await call('alice', `/sessions/${session.id}/export`)).text(); assert.equal(exported.trim().split('\n').length, 2);
  assert.equal((await call('alice', `/sessions/${session.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await call('alice', `/sessions/${session.id}/messages`)).status, 404);
});
