import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, appendFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DateWindow } from './time.ts';
import { timeContext } from './time.ts';

export type Source = { id: string; url: string; title: string; content: string; observedAt: string; publishedAt?: string; query: string; kind: 'search' | 'page' };
export type Message = { id: string; session_id: string; role: 'user' | 'assistant'; content: string; created_at: string; status: string; sources: Source[] };
export type Fact = { key: string; value: string; quote: string; source_id: string; updated_at?: string };
export const PROFILE_CAP = 1600;
const stop = new Set('a an the i me my you your we our on in at to of for and or is are was were has have had what when which how did do does can could would should ask asked tell told say said about since last today yesterday still any them it this that with from please remember'.split(' '));
export function keywords(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [];
  const terms = words.filter(w => !stop.has(w));
  if (terms.includes('postgresql')) terms.push('postgres');
  if (terms.includes('postgres')) terms.push('postgresql');
  if (terms.some(w => /^(price|prices|pricing|cost|costs)$/.test(w))) terms.push('price', 'pricing', 'cost');
  return [...new Set(terms)].slice(0, 18);
}

const referenceWords = new Set('anything something changed change changes update updates chat chats conversation conversations discussion discussions previous earlier prior happened new talk talked talking spoke spoken discuss discussed recap summary check time latest hi hello thanks'.split(' '));
export function historyReference(query: string) {
  return /\b(last|previous|earlier|prior)\s+(chat|conversation|discussion|time)\b|\b(?:we|i|you)\s+(?:last\s+(?:talked|spoke|chatted|discussed)|(?:talked|spoke|chatted)\s+last)\b/i.test(query);
}
function isPreferenceOrGreeting(text: string) {
  return /^(?:hi|hello|hey|thanks|thank you)[!.\s]*$/i.test(text.trim())
    || (/\b(?:remember|prefer|like)\b/i.test(text) && /\b(?:answers?|responses?|concise|precise|short|practical|tone|style)\b/i.test(text) && !/\b(?:compare|shortlist|pricing|cost|tools|vendors)\b/i.test(text));
}
function isBroadReference(text: string) {
  return historyReference(text) && keywords(text).every(term => referenceWords.has(term));
}

export class Store {
  db: DatabaseSync;
  constructor(public directory: string) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, 'minimi.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, timezone TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL, sources TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE IF NOT EXISTS message_traces(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_session_date ON messages(session_id, created_at);
      CREATE INDEX IF NOT EXISTS messages_date ON messages(created_at);
      CREATE TABLE IF NOT EXISTS facts(user_id TEXT NOT NULL REFERENCES users(id), key TEXT NOT NULL, value TEXT NOT NULL, quote TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, updated_at TEXT NOT NULL, PRIMARY KEY(user_id,key));
      CREATE TABLE IF NOT EXISTS forgotten(user_id TEXT NOT NULL, key TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(user_id,key));
      CREATE TABLE IF NOT EXISTS mentioned_dates(message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, start TEXT NOT NULL, end TEXT NOT NULL, PRIMARY KEY(message_id,start));
      CREATE INDEX IF NOT EXISTS mentioned_date_range ON mentioned_dates(start,end);
      CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(content, content='messages', content_rowid='rowid', tokenize='unicode61');
      CREATE TRIGGER IF NOT EXISTS message_insert AFTER INSERT ON messages BEGIN INSERT INTO message_fts(rowid,content) VALUES(new.rowid,new.content); END;
      CREATE TRIGGER IF NOT EXISTS message_delete AFTER DELETE ON messages BEGIN INSERT INTO message_fts(message_fts,rowid,content) VALUES('delete',old.rowid,old.content); END;
      CREATE TRIGGER IF NOT EXISTS message_update AFTER UPDATE OF content ON messages BEGIN INSERT INTO message_fts(message_fts,rowid,content) VALUES('delete',old.rowid,old.content); INSERT INTO message_fts(rowid,content) VALUES(new.rowid,new.content); END;`);
    // SQLite is authoritative: repair projections after a crash or interrupted write.
    for (const row of this.db.prepare('SELECT id,user_id FROM sessions').all() as { id: string; user_id: string }[]) this.project(row.user_id, row.id);
  }
  user(id: string, timezone: string) { this.db.prepare('INSERT OR IGNORE INTO users VALUES(?,?)').run(id, timezone); }
  owns(user: string, session: string) { return !!this.db.prepare('SELECT 1 FROM sessions WHERE id=? AND user_id=?').get(session, user); }
  sessions(user: string) { return this.db.prepare('SELECT id,title,created_at FROM sessions WHERE user_id=? ORDER BY created_at DESC').all(user); }
  create(user: string) {
    const session = { id: randomUUID(), title: 'New conversation', created_at: new Date().toISOString() };
    this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(session.id, user, session.title, session.created_at);
    this.project(user, session.id); return session;
  }
  messages(user: string, session: string): Message[] {
    if (!this.owns(user, session)) throw new Error('Conversation not found');
    return (this.db.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY created_at,rowid').all(session) as any[]).map(row => ({ ...row, sources: JSON.parse(row.sources) }));
  }
  recent(user: string, session: string): Message[] {
    if (!this.owns(user, session)) throw new Error('Conversation not found');
    return (this.db.prepare("SELECT * FROM messages WHERE session_id=? AND status='complete' ORDER BY created_at DESC,rowid DESC LIMIT 7").all(session) as any[]).reverse().map(m => ({ ...m, sources: JSON.parse(m.sources) }));
  }
  add(user: string, session: string, role: Message['role'], content: string, status = 'complete', sources: Source[] = [], createdAt = new Date().toISOString()) {
    if (!this.owns(user, session)) throw new Error('Conversation not found');
    const id = randomUUID();
    this.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)').run(id, session, role, content, createdAt, status, JSON.stringify(sources));
    if (role === 'user') {
      const settings = this.db.prepare('SELECT timezone FROM users WHERE id=?').get(user) as any;
      const mentioned = timeContext(content, settings.timezone, new Date(createdAt)).windows[0];
      if (mentioned) this.db.prepare('INSERT OR IGNORE INTO mentioned_dates VALUES(?,?,?)').run(id, mentioned.start, mentioned.end);
    }
    if (role === 'user') this.db.prepare("UPDATE sessions SET title=? WHERE id=? AND title='New conversation'").run(content.slice(0, 65), session);
    // Append one committed record; avoid rewriting an entire long chat on every turn.
    appendFileSync(join(this.directory, 'users', user, 'chats', `${session}.jsonl`), `${JSON.stringify({ version: 1, type: 'message', id, session_id: session, role, content, created_at: createdAt, status, sources })}\n`);
    return id;
  }
  remove(user: string, session: string) {
    if (!this.owns(user, session)) throw new Error('Conversation not found');
    this.db.prepare('DELETE FROM sessions WHERE id=? AND user_id=?').run(session, user);
    rmSync(join(this.directory, 'users', user, 'chats', `${session}.jsonl`), { force: true });
    this.projectProfile(user);
  }
  facts(user: string): Fact[] { return this.db.prepare('SELECT key,value,quote,source_id,updated_at FROM facts WHERE user_id=? ORDER BY updated_at DESC,key').all(user) as Fact[]; }
  profile(user: string) { return this.facts(user).map(f => `${f.key}: ${f.value}`).join('\n'); }
  saveFacts(user: string, facts: Fact[]) {
    const current = new Map(this.facts(user).map(f => [f.key, f]));
    for (const fact of facts) {
      if (!/^[a-z][a-z0-9_]{1,47}$/.test(fact.key) || !fact.value.trim() || fact.value.length > 220 || fact.quote.length < 3) continue;
      const source = this.db.prepare("SELECT m.* FROM messages m JOIN sessions s ON s.id=m.session_id WHERE m.id=? AND s.user_id=? AND m.role='user'").get(fact.source_id, user) as any;
      if (!source || !source.content.includes(fact.quote)) continue;
      const forgotten = this.db.prepare('SELECT at FROM forgotten WHERE user_id=? AND key=?').get(user, fact.key) as any;
      if (forgotten && forgotten.at >= source.created_at) continue;
      // Avoid old async extraction overwriting an explicit newer correction.
      const previous = current.get(fact.key);
      if (previous) {
        const priorSource = this.db.prepare('SELECT created_at FROM messages WHERE id=?').get(previous.source_id) as any;
        if (priorSource?.created_at > source.created_at) continue;
      }
      const next = new Map(current); next.set(fact.key, fact);
      if ([...next.values()].map(f => `${f.key}: ${f.value}`).join('\n').length > PROFILE_CAP) continue;
      this.db.prepare('INSERT INTO facts VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value,quote=excluded.quote,source_id=excluded.source_id,updated_at=excluded.updated_at').run(user, fact.key, fact.value, fact.quote, fact.source_id, new Date().toISOString());
      current.set(fact.key, fact);
    }
    this.projectProfile(user);
  }
  forget(user: string, key: string) {
    this.db.prepare('INSERT INTO forgotten VALUES(?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET at=excluded.at').run(user, key, new Date().toISOString());
    this.db.prepare('DELETE FROM facts WHERE user_id=? AND key=?').run(user, key); this.projectProfile(user);
  }
  saveTrace(user: string, messageId: string, trace: object) {
    const owned = this.db.prepare('SELECT m.id FROM messages m JOIN sessions s ON s.id=m.session_id WHERE m.id=? AND s.user_id=?').get(messageId, user);
    if (!owned) throw new Error('Message not found');
    this.db.prepare('INSERT OR REPLACE INTO message_traces VALUES(?,?)').run(messageId, JSON.stringify(trace));
  }
  messageTrace(user: string, messageId: string) {
    const row = this.db.prepare('SELECT t.data FROM message_traces t JOIN messages m ON m.id=t.message_id JOIN sessions s ON s.id=m.session_id WHERE m.id=? AND s.user_id=?').get(messageId, user) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  retrieve(user: string, query: string, windows: DateWindow[], excludeId?: string) {
    const reference = historyReference(query);
    const terms = keywords(query).filter(term => !reference || !referenceWords.has(term));
    let ids: string[] = [];
    const matchedDates: string[] = [];
    // Calendar lookup is independent of lexical match: "what did I ask" has no useful keyword.
    for (const w of windows) {
      const eventLookup = !/\b(ask|asked|discuss\w*|chat\w*|said|tell|told)\b/i.test(query);
      const rows = this.db.prepare(`SELECT m.id FROM messages m JOIN sessions s ON s.id=m.session_id WHERE s.user_id=? AND (m.created_at>=? AND m.created_at<? ${eventLookup ? 'OR EXISTS(SELECT 1 FROM mentioned_dates d WHERE d.message_id=m.id AND d.start<? AND d.end>?)' : ''}) AND m.status='complete' AND m.id!=? ORDER BY m.created_at LIMIT 40`).all(user, w.start, w.end, ...(eventLookup ? [w.end, w.start] : []), excludeId || '') as { id: string }[];
      if (rows.length) matchedDates.push(w.label);
      ids.push(...rows.map(r => r.id));
    }
    if (terms.length && !windows.length) {
      // Scope before LIMIT, not after a global top-k. FTS syntax is generated, not user SQL.
      ids = (this.db.prepare(`SELECT m.id FROM message_fts JOIN messages m ON m.rowid=message_fts.rowid JOIN sessions s ON s.id=m.session_id WHERE message_fts MATCH ? AND s.user_id=? AND m.status='complete' AND m.id!=? ORDER BY bm25(message_fts) LIMIT 8`).all(terms.map(t => `"${t}"`).join(' OR '), user, excludeId || '') as { id: string }[]).map(r => r.id);
    }
    const hasStoredHistory = !!this.db.prepare("SELECT m.id FROM messages m JOIN sessions s ON s.id=m.session_id WHERE s.user_id=? AND m.role='assistant' AND m.status='complete' AND m.id!=? LIMIT 1").get(user, excludeId || '');
    const broadReference = reference && terms.length === 0;
    let baselineSession: string | undefined;
    let baselineQuestionId: string | undefined;
    let baselineAnswerId: string | undefined;
    let baselineAt: string | undefined;
    let strategy = windows.length ? 'calendar' : 'lexical';
    if (!windows.length && broadReference) {
      const current = excludeId ? this.db.prepare('SELECT rowid,session_id FROM messages WHERE id=?').get(excludeId) as { rowid: number; session_id: string } | undefined : undefined;
      const candidates = this.db.prepare(`SELECT u.id,u.content,u.session_id,a.id AS answer_id,a.created_at AS answered_at,a.content AS answer,a.sources
        FROM messages u JOIN sessions s ON s.id=u.session_id
        JOIN messages a ON a.rowid=(SELECT min(n.rowid) FROM messages n WHERE n.session_id=u.session_id AND n.rowid>u.rowid)
        LEFT JOIN message_traces t ON t.message_id=a.id
        WHERE COALESCE(json_extract(t.data,'$.outcome'),'answered')!='unverified' AND s.user_id=? AND u.role='user' AND u.status='complete' AND a.role='assistant' AND a.status='complete' AND u.id!=? AND u.rowid<?
        ORDER BY (u.session_id=?) DESC,u.created_at DESC,u.rowid DESC LIMIT 100`).all(user, excludeId || '', current?.rowid || Number.MAX_SAFE_INTEGER, current?.session_id || '') as { id: string; content: string; session_id: string; answer_id: string; answered_at: string; answer: string; sources: string }[];
      const baseline = candidates.find(c => !isPreferenceOrGreeting(c.content)
        && (!isBroadReference(c.content) || JSON.parse(c.sources).length > 0)
        && !/^(?:I(?:['’]m| am)? (?:not able|cannot|can['’]t)|I don['’]t have).{0,100}(?:earlier|previous|history|conversation)/i.test(c.answer));
      strategy = baseline ? 'latest_answered_topic' : 'no_answered_topic';
      if (baseline) {
        baselineSession = baseline.session_id;
        baselineQuestionId = baseline.id; baselineAnswerId = baseline.answer_id; baselineAt = baseline.answered_at;
        // Retrieve the actual answered turn, not whichever messages happen to
        // be at the end of its conversation after preference updates or retries.
        ids = [baseline.id, baseline.answer_id];
      } else ids = [];
    }
    const selected = new Map<string, Message>();
    for (const id of ids) {
      const hit = this.db.prepare('SELECT rowid,session_id FROM messages WHERE id=?').get(id) as any;
      if (!hit) continue;
      if (baselineQuestionId && baselineAnswerId) {
        const row = this.db.prepare('SELECT * FROM messages WHERE id=?').get(id) as any;
        if (row) selected.set(row.id, { ...row, sources: JSON.parse(row.sources) });
        continue;
      }
      const before = this.db.prepare("SELECT * FROM messages WHERE session_id=? AND rowid<=? AND status='complete' AND id!=? ORDER BY rowid DESC LIMIT 2").all(hit.session_id, hit.rowid, excludeId || '') as any[];
      const after = this.db.prepare("SELECT * FROM messages WHERE session_id=? AND rowid>? AND status='complete' AND id!=? ORDER BY rowid LIMIT 2").all(hit.session_id, hit.rowid, excludeId || '') as any[];
      for (const row of [...before.reverse(), ...after]) selected.set(row.id, { ...row, sources: JSON.parse(row.sources) });
    }
    const all = [...selected.values()];
    let budget = 16000;
    const messages: Message[] = [];
    for (const m of all) {
      if (budget < 500) break;
      const content = m.content.slice(0, Math.min(12000, budget));
      messages.push({ ...m, content }); budget -= content.length;
    }
    return { messages, matchedDates, hasStoredHistory, baselineSession, baselineQuestionId, baselineAnswerId, baselineAt, strategy, originalCharacters: Object.fromEntries(all.map(m => [m.id, m.content.length])), truncated: all.length > messages.length || messages.some(m => m.content.length < (all.find(a => a.id === m.id)?.content.length || 0)) || ids.length >= 40, ambiguous: matchedDates.length > 1 };
  }
  jsonl(user: string, session: string) {
    const rows = this.messages(user, session);
    return rows.map(m => JSON.stringify({ version: 1, type: 'message', ...m })).join('\n') + (rows.length ? '\n' : '');
  }
  project(user: string, session: string) {
    const folder = join(this.directory, 'users', user, 'chats'); mkdirSync(folder, { recursive: true });
    const path = join(folder, `${session}.jsonl`); writeFileSync(`${path}.tmp`, this.jsonl(user, session)); renameSync(`${path}.tmp`, path);
  }
  projectProfile(user: string) {
    const folder = join(this.directory, 'users', user); mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'USER.md'), this.profile(user));
  }
  close() { this.db.close(); }
}
