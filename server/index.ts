import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { Store } from './store.ts';
import { providers, type ProviderId } from './models.ts';
import { SearchService } from './search.ts';
import { runChat, extractMemory } from './agent.ts';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dataDir = resolve(process.env.DATA_DIR || join(root, 'data'));
mkdirSync(dataDir, { recursive: true });
const secretFile = join(dataDir, '.session-secret');
if (!existsSync(secretFile)) writeFileSync(secretFile, randomBytes(32).toString('hex'), { mode: 0o600 });
const app = express();
const store = new Store(dataDir);
const search = new SearchService(process.env.TAVILY_API_KEY || '');
const active = new Set<string>();
const jobs: { user: string; id: string; text: string; provider: ProviderId }[] = [];
let extracting = false;
async function drain() {
  if (extracting) return; extracting = true;
  while (jobs.length) {
    const job = jobs.shift()!;
    try { await extractMemory(store, job.user, job.id, job.text, job.provider); }
    catch (error) {
      const e = error as { name?: string; statusCode?: number; lastError?: { statusCode?: number } } | null;
      console.error('[memory extraction failed]', { provider: job.provider, errorType: e?.name, statusCode: e?.statusCode ?? e?.lastError?.statusCode });
    }
  }
  extracting = false;
}
app.disable('x-powered-by');
app.use(express.json({ limit: '40kb' }));
app.use(cookieParser(readFileSync(secretFile, 'utf8')));
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  // Reject cross-origin mutations, including requests against a localhost install.
  if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== `${req.protocol}://${req.headers.host}`) return res.status(403).json({ error: 'Cross-origin request rejected' });
  next();
});
app.post('/api/unlock', (req, res) => {
  const expected = process.env.APP_ACCESS_TOKEN || '';
  const supplied = typeof req.body.token === 'string' ? req.body.token : '';
  const a = Buffer.from(expected); const b = Buffer.from(supplied);
  if (expected && (a.length !== b.length || !timingSafeEqual(a, b))) return res.status(401).json({ error: 'Access code did not match.' });
  res.cookie('minimi_access', 'allowed', { signed: true, httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: 86_400_000 });
  res.json({ ok: true });
});
app.use('/api', (req, res, next) => {
  if (process.env.APP_ACCESS_TOKEN && req.signedCookies.minimi_access !== 'allowed') return res.status(401).json({ error: 'Enter the demo access code.' });
  let user = req.signedCookies.minimi_user;
  if (typeof user !== 'string' || !z.uuid().safeParse(user).success) {
    user = randomUUID();
    res.cookie('minimi_user', user, { signed: true, httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: 365 * 86_400_000 });
  }
  res.locals.user = user;
  store.user(user, process.env.DEFAULT_TIMEZONE || 'UTC'); next();
});
app.get('/api/config', (_req, res) => res.json({ providers: providers(), defaultProvider: process.env.DEFAULT_PROVIDER || 'openai', searchAvailable: !!process.env.TAVILY_API_KEY, timezone: process.env.DEFAULT_TIMEZONE || 'UTC' }));
app.get('/api/sessions', (_req, res) => res.json(store.sessions(res.locals.user)));
app.get('/api/messages/:id', (req, res) => {
  const row = store.db.prepare('SELECT m.* FROM messages m JOIN sessions s ON m.session_id=s.id WHERE m.id=? AND s.user_id=?').get(req.params.id, res.locals.user) as any;
  if (!row) return res.status(404).json({ error: 'Earlier message not found' });
  res.json({ ...row, sources: JSON.parse(row.sources) });
});
app.post('/api/sessions', (_req, res) => res.json(store.create(res.locals.user)));
app.get('/api/sessions/:id/messages', (req, res) => {
  if (!store.owns(res.locals.user, req.params.id)) return res.status(404).json({ error: 'Conversation not found' });
  res.json(store.messages(res.locals.user, req.params.id));
});
app.delete('/api/sessions/:id', (req, res) => {
  if (!store.owns(res.locals.user, req.params.id)) return res.status(404).json({ error: 'Conversation not found' });
  if (active.has(`${res.locals.user}:${req.params.id}`)) return res.status(409).json({ error: 'Stop the response before deleting this conversation.' });
  store.remove(res.locals.user, req.params.id); res.json({ ok: true });
});
app.get('/api/sessions/:id/export', (req, res) => {
  if (!store.owns(res.locals.user, req.params.id)) return res.status(404).json({ error: 'Conversation not found' });
  res.type('application/x-ndjson').attachment(`minimi-${req.params.id}.jsonl`).send(store.jsonl(res.locals.user, req.params.id));
});
app.get('/api/memory', (_req, res) => res.json({ facts: store.facts(res.locals.user), characters: store.profile(res.locals.user).length, limit: 1600 }));
app.delete('/api/memory/:key', (req, res) => { store.forget(res.locals.user, req.params.key); res.json({ ok: true }); });
const chatInput = z.object({ session: z.uuid(), text: z.string().trim().min(1).max(10000), provider: z.enum(['openai', 'anthropic', 'compatible']), timezone: z.string().max(80) });
app.post('/api/chat', async (req, res) => {
  const parsed = chatInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Check the message, model, and timezone.' });
  const input = parsed.data; const user = res.locals.user as string;
  if (!DateTime.now().setZone(input.timezone).isValid) return res.status(400).json({ error: 'Invalid timezone.' });
  if (!store.owns(user, input.session)) return res.status(404).json({ error: 'Conversation not found' });
  if (!providers().some(p => p.id === input.provider && p.available)) return res.status(400).json({ error: `Set a ${input.provider} API key and model in .env, then restart.` });
  const lock = `${user}:${input.session}`;
  if (active.has(lock)) return res.status(409).json({ error: 'A response is already running in this conversation.' });
  if (active.size >= 12) return res.status(429).json({ error: 'The server is busy. Try again shortly.' });
  active.add(lock);
  res.setHeader('Content-Type', 'application/x-ndjson'); res.setHeader('X-Accel-Buffering', 'no'); res.flushHeaders();
  const controller = new AbortController();
  const configuredTimeout = Number(process.env.CHAT_TIMEOUT_MS || 120_000);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout >= 1000
    ? Math.min(configuredTimeout, 300_000) : 120_000;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  const emit = (event: object) => { if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(event)}\n`); };
  const progress = setInterval(() => emit({ type: 'status', text: 'Still researching and preparing your answer…' }), 15_000);
  try {
    const result = await runChat({ store, search, user, session: input.session, text: input.text, timezone: input.timezone, provider: input.provider, signal: controller.signal, emit });
    if (jobs.length < 30) { jobs.push({ user, id: result.userId, text: input.text, provider: input.provider }); void drain(); }
  } catch (error) {
    // Log only diagnostic metadata, never provider payloads or credentials.
    const e = error as { name?: string; statusCode?: number; cause?: { name?: string; statusCode?: number }; message?: string; finishReason?: string; lastError?: { name?: string; statusCode?: number; message?: string } } | null;
    const status = e?.statusCode ?? e?.lastError?.statusCode ?? e?.cause?.statusCode;
    const toolValidationFailed = /tool call validation failed/i.test(e?.lastError?.message ?? e?.message ?? '');
    console.error('[chat failed]', { provider: input.provider, errorType: e?.name, statusCode: status, causeType: e?.cause?.name, finishReason: e?.finishReason, toolValidationFailed, aborted: controller.signal.aborted });
    emit({ type: 'error', text: timedOut ? `Research exceeded the ${Math.round(timeoutMs / 1000)}-second time limit. Your conversation is saved. Try comparing one vendor at a time.` : controller.signal.aborted ? 'Response stopped. Your conversation is saved.' : toolValidationFailed ? 'The model generated invalid search arguments. Please retry, or select another tool-capable model.' : status === 429 ? 'The provider rate limit was reached. Wait a minute and try again.' : status === 413 ? 'The provider rejected this request as too large for its token allowance. Try a shorter conversation or a provider plan with higher limits.' : 'The provider could not complete the response. Check the API key, model access, quota, and tool-calling support.' });
  } finally { clearTimeout(timeout); clearInterval(progress); active.delete(lock); res.end(); }
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint not found' }));
const production = process.argv.includes('--production');
if (production) {
  app.use(express.static(join(root, 'dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(join(root, 'dist/index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' }); app.use(vite.middlewares);
}
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (!res.headersSent) res.status(400).json({ error: 'The request could not be processed.' });
});
const host = process.env.HOST || '127.0.0.1';
if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !process.env.APP_ACCESS_TOKEN) throw new Error('Set APP_ACCESS_TOKEN before binding to a public interface.');
const port = Number(process.env.PORT || 4317);
const httpServer = app.listen(port, host);
httpServer.on('listening', () => {
  const address = httpServer.address(); const listeningPort = typeof address === 'object' && address ? address.port : port;
  console.log(`minimi is ready at http://${host}:${listeningPort}`);
}).on('error', error => { console.error(`Could not start minimi: ${error.message}`); process.exit(1); });
