import { displayMessageText } from './message-text.ts';
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Plus, ArrowUp, Square, PanelLeft, SlidersHorizontal, Brain, X, Download, Trash2, Search, ArrowUpRight, MessageCircle, Check, Copy, ChevronDown, LockKeyhole } from 'lucide-react';
import './style.css';

type Source = { url: string; title: string; content: string; observedAt: string; kind: string };
type Message = { id: string; role: 'user' | 'assistant'; content: string; status: string; created_at: string; session_id: string; sources: Source[] };
type Session = { id: string; title: string; created_at: string };
type Config = { providers: { id: string; label: string; model: string; available: boolean }[]; defaultProvider: string; searchAvailable: boolean; timezone: string };
type Fact = { key: string; value: string; quote: string; source_id: string };
async function api(path: string, options?: RequestInit) {
  const response = await fetch(`/api${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } });
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.error || 'Request failed'), { status: response.status });
  return body;
}
function Logo() { return <span className="logo" aria-hidden="true"><i/><i/></span>; }
function App() {
  const [config, setConfig] = useState<Config>(); const [sessions, setSessions] = useState<Session[]>([]);
  const [session, setSession] = useState<string>(); const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState(''); const [provider, setProvider] = useState('openai');
  const [busy, setBusy] = useState(false); const [status, setStatus] = useState(''); const [error, setError] = useState('');
  const [panel, setPanel] = useState<'memory' | 'settings' | null>(null); const [facts, setFacts] = useState<Fact[]>([]);
  const [memorySize, setMemorySize] = useState(0); const [reference, setReference] = useState<Message>();
  const [sidebar, setSidebar] = useState(false); const [locked, setLocked] = useState(false); const [access, setAccess] = useState('');
  const [copied, setCopied] = useState<string>();
  const controller = useRef<AbortController | null>(null); const bottom = useRef<HTMLDivElement>(null); const input = useRef<HTMLTextAreaElement>(null);
  const selected = config?.providers.find(p => p.id === provider);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || config?.timezone || 'UTC';
  async function load() {
    try {
      const c: Config = await api('/config'); setConfig(c); setProvider(c.providers.find(p => p.id === c.defaultProvider && p.available)?.id || c.providers.find(p => p.available)?.id || 'openai');
      setSessions(await api('/sessions')); setLocked(false);
    } catch (e: any) { if (e.status === 401) setLocked(true); else setError(e.message); }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: busy ? 'instant' : 'smooth', block: 'end' }); }, [messages, status]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key === 'k') { event.preventDefault(); if (!controller.current) newChat(); } if (event.key === 'Escape') { setPanel(null); setReference(undefined); setSidebar(false); } };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, []);
  async function openSession(id: string) {
    if (busy) return;
    try { setMessages(await api(`/sessions/${id}/messages`)); setSession(id); setError(''); setSidebar(false); } catch (e: any) { setError(e.message); }
  }
  function newChat() { if (controller.current) return; setSession(undefined); setMessages([]); setText(''); setError(''); setSidebar(false); input.current?.focus(); }
  async function memoryPanel() {
    try { const m = await api('/memory'); setFacts(m.facts); setMemorySize(m.characters); setPanel('memory'); } catch (e: any) { setError(e.message); }
  }
  async function send(value = text) {
    if (controller.current || !value.trim()) return;
    if (!selected?.available) { setPanel('settings'); return; }
    const abort = new AbortController(); controller.current = abort; setBusy(true); setError(''); setStatus('Finding context'); setText('');
    let current = session;
    try {
      if (!current) { const s = await api('/sessions', { method: 'POST', body: '{}' }); current = s.id; setSession(current); }
      const tempId = `pending-${Date.now()}`;
      const userMessage: Message = { id: `${tempId}-user`, session_id: current!, role: 'user', content: value.trim(), created_at: new Date().toISOString(), status: 'complete', sources: [] };
      const assistantMessage: Message = { ...userMessage, id: tempId, role: 'assistant', content: '', status: 'streaming' };
      setMessages(previous => [...previous, userMessage, assistantMessage]);
      const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: current, text: value.trim(), provider, timezone }), signal: abort.signal });
      if (!response.ok) { const result = await response.json(); throw new Error(result.error); }
      const reader = response.body!.getReader(); const decoder = new TextDecoder(); let buffer = ''; let completed = false;
      const event = (row: any) => {
        if (row.type === 'text') { setStatus(''); setMessages(previous => previous.map(m => m.id === tempId ? { ...m, content: m.content + row.text } : m)); }
        if (row.type === 'sources') setMessages(previous => previous.map(m => m.id === tempId ? { ...m, sources: row.sources } : m));
        if (row.type === 'status') setStatus(row.text);
        if (row.type === 'memory') setStatus(row.count ? 'Reading our earlier conversation' : 'Thinking');
        if (row.type === 'error') throw new Error(row.text);
        if (row.type === 'done') completed = true;
      };
      while (true) {
        const { done, value: chunk } = await reader.read(); buffer += decoder.decode(chunk, { stream: !done });
        let newline: number; while ((newline = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (line) event(JSON.parse(line)); }
        if (done) break;
      }
      if (buffer.trim()) event(JSON.parse(buffer));
      if (!completed) throw new Error('The connection ended before the response completed.');
    } catch (e: any) { setError(e.name === 'AbortError' ? 'Response stopped.' : e.message); }
    finally {
      controller.current = null; setBusy(false); setStatus('');
      if (current) { try { setMessages(await api(`/sessions/${current}/messages`)); setSessions(await api('/sessions')); } catch { /* Keep the visible text on connection failure. */ } }
      input.current?.focus();
    }
  }
  async function showReference(id: string) {
    try { setReference(await api(`/messages/${id}`)); } catch (e: any) { setError(e.message); }
  }
  async function removeConversation(id = session) {
    if (!id || busy) return;
    if (!window.confirm('Delete this conversation and memories sourced from it?')) return;
    try {
      await api(`/sessions/${id}`, { method: 'DELETE' });
      if (id === session) newChat();
      const [updatedSessions, memory] = await Promise.all([api('/sessions'), api('/memory')]);
      setSessions(updatedSessions); setFacts(memory.facts); setMemorySize(memory.characters);
      setReference(undefined);
    } catch (e: any) { setError(e.message); }
  }
  const renderMessage = (m: Message) => <Markdown remarkPlugins={[remarkGfm]} components={{
    a: ({ href, children }) => {
      if (href?.startsWith('#message-')) return <button className="inline-link" onClick={() => void showReference(href.slice(9))}>{children}</button>;
      const allowed = m.role === 'user' || m.sources.some(s => s.url === href);
      return allowed ? <a href={href} target="_blank" rel="noreferrer">{children}</a> : <span title="This link was not returned by web search">{children}</span>;
    },
  }}>{displayMessageText(m.content, m.role)}</Markdown>;

  if (locked) return <main className="unlock"><Logo/><h1>Welcome to minimi</h1><p>Enter the access code for this demo.</p><form onSubmit={async e => { e.preventDefault(); try { await api('/unlock', { method: 'POST', body: JSON.stringify({ token: access }) }); setError(''); await load(); } catch (e: any) { setError(e.message); } }}><label htmlFor="access">Access code</label><input id="access" type="password" value={access} onChange={e => setAccess(e.target.value)} autoFocus/><button type="submit"><LockKeyhole size={16}/> Continue</button></form>{error && <p role="alert">{error}</p>}</main>;
  return <div className="app">
    {sidebar && <div className="sidebar-shade" onClick={() => setSidebar(false)}/>}
    <aside className={sidebar ? 'sidebar open' : 'sidebar'}>
      <a className="brand" href="/" onClick={e => { e.preventDefault(); newChat(); }}><Logo/><span>minimi</span></a>
      <button className="new-chat" onClick={newChat} disabled={busy}><Plus size={17}/> New conversation <kbd>⌘ K</kbd></button>
      <div className="history-heading">Your conversations</div>
      <nav aria-label="Conversations">{sessions.length ? sessions.map(s => <div key={s.id} className={`session-row ${session === s.id ? 'selected' : ''}`}><button className={`session ${session === s.id ? 'selected' : ''}`} onClick={() => void openSession(s.id)} disabled={busy}><MessageCircle size={15}/><span>{s.title}</span></button><button className="icon session-delete" title="Delete conversation and its saved memories" aria-label={`Delete conversation: ${s.title}`} disabled={busy} onClick={() => void removeConversation(s.id)}><Trash2 size={14}/></button></div>) : <p className="no-history">A fresh start.<br/>Your conversations will live here.</p>}</nav>
      <div className="sidebar-bottom"><button onClick={() => void memoryPanel()}><Brain size={17}/> Your memory</button><button onClick={() => setPanel('settings')}><SlidersHorizontal size={17}/> Settings</button><div className="profile"><span>N</span><div>Your space<small>Private to this browser</small></div></div></div>
    </aside>
    <main className="main">
      <header><div className="header-left"><button className="icon mobile-toggle" aria-label="Open sidebar" onClick={() => setSidebar(true)}><PanelLeft size={19}/></button><span>{session ? sessions.find(s => s.id === session)?.title || 'New conversation' : 'New conversation'}</span></div><div className="header-right"><span className="web-indicator"><i className={config?.searchAvailable ? 'available' : ''}/>{config?.searchAvailable ? 'Web connected' : 'Web not connected'}</span>{session && <><a className="icon" href={`/api/sessions/${session}/export`} title="Export conversation" aria-label="Export conversation"><Download size={17}/></a><button className="icon" title="Delete conversation and its saved memories" aria-label="Delete conversation and its saved memories" disabled={busy} onClick={() => void removeConversation()}><Trash2 size={16}/></button></>}</div></header>
      <div className={`conversation ${messages.length ? 'has-messages' : ''}`}>
        {!messages.length ? <div className="welcome"><div className="welcome-mark"><Logo/></div><h1>Pick up where you left off.</h1><p>A place for your questions, your next idea,<br/>and everything we’ve already figured out.</p><div className="suggestions">{['What did we discuss last Tuesday?', 'Has anything changed since our last chat?', 'Remember that I prefer short, practical answers.'].map((prompt, i) => <button key={prompt} onClick={() => { setText(prompt); input.current?.focus(); }}><span>{i === 0 ? <MessageCircle size={17}/> : i === 1 ? <Search size={17}/> : <Brain size={17}/>}</span>{prompt}<ArrowUpRight size={15}/></button>)}</div></div> : <div className="message-list">{messages.map(m => <article key={m.id} className={`message ${m.role}`}><div className="message-avatar">{m.role === 'assistant' ? <Logo/> : 'You'}</div><div className="message-content">{m.content ? renderMessage(m) : busy && <span className="thinking-dots" aria-label="Thinking"><i/><i/><i/></span>}{m.status !== 'complete' && m.status !== 'streaming' && <p className="incomplete">{m.status === 'interrupted' ? 'Stopped' : 'Incomplete response'}</p>}{m.sources.length > 0 && <details className="sources"><summary>{new Set(m.sources.map(s => s.url)).size} sources <ChevronDown size={12}/></summary><div>{[...new Map(m.sources.map(s => [s.url, s])).values()].map(s => <a key={s.url} href={s.url} target="_blank" rel="noreferrer"><span>{s.title}<small>{new URL(s.url).hostname} · Checked {new Date(s.observedAt).toLocaleDateString()}</small></span><ArrowUpRight size={14}/></a>)}</div></details>}{m.role === 'assistant' && m.content && <button className="copy icon" aria-label="Copy response" onClick={async () => { try { await navigator.clipboard.writeText(displayMessageText(m.content, m.role)); setCopied(m.id); setTimeout(() => setCopied(undefined), 1500); } catch { setError('Clipboard access is unavailable. Select the text to copy it.'); } }}>{copied === m.id ? <Check size={14}/> : <Copy size={14}/>}</button>}</div></article>)}{busy && status && <div className="progress" role="status"><span/>{status}</div>}<div ref={bottom}/></div>}
      </div>
      <div className="composer-area">{error && <div className="error" role="alert">{error}<button className="icon" aria-label="Dismiss error" onClick={() => setError('')}><X size={14}/></button></div>}{config && !selected?.available && <div className="setup-hint">Connect a model to start chatting. <button onClick={() => setPanel('settings')}>View setup</button></div>}<form className="composer" onSubmit={e => { e.preventDefault(); void send(); }}><textarea ref={input} rows={2} aria-label="Message minimi" placeholder="Ask anything, or pick up an earlier thought…" value={text} maxLength={10000} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}/><div className="composer-toolbar"><div className="model-picker"><select aria-label="Model provider" value={provider} disabled={busy} onChange={e => setProvider(e.target.value)}>{config?.providers.map(p => <option key={p.id} value={p.id} disabled={!p.available}>{p.model || p.label}{!p.available ? ' · not connected' : ''}</option>)}</select><ChevronDown size={13}/></div><span className="composer-note">Shift + Enter for a new line</span>{busy ? <button className="send stop" type="button" aria-label="Stop response" onClick={() => controller.current?.abort()}><Square size={14} fill="currentColor"/></button> : <button className="send" type="submit" aria-label="Send message" disabled={!text.trim()}><ArrowUp size={20}/></button>}</div></form><p className="composer-footnote">A little memory. A fresh perspective.</p></div>
    </main>
    {(panel || reference) && <div className="modal-backdrop" onClick={() => { setPanel(null); setReference(undefined); }}><section className="modal" role="dialog" aria-modal="true" aria-label={reference ? 'Earlier message' : panel === 'memory' ? 'Your memory' : 'Settings'} onClick={e => e.stopPropagation()}><button className="icon modal-close" aria-label="Close" autoFocus onClick={() => { setPanel(null); setReference(undefined); }}><X size={20}/></button>{reference ? <><h2>Our earlier conversation</h2><p className="subtle">{new Date(reference.created_at).toLocaleString()} · {reference.role === 'user' ? 'You' : 'minimi'}</p><div className="reference-content">{renderMessage(reference)}</div><button className="text-button" onClick={() => { void openSession(reference.session_id); setReference(undefined); setPanel(null); }}>Open conversation</button></> : panel === 'memory' ? <><Brain size={24}/><h2>A few things about you</h2><p className="subtle">Useful preferences and facts, with the words they came from. Earlier conversations stay searchable separately.</p><div className="capacity"><span style={{ width: `${memorySize / 1600 * 100}%` }}/></div><p className="capacity-label">{memorySize} / 1,600 characters</p>{facts.length ? facts.map(f => <div className="fact" key={f.key}><div><strong>{f.key.replaceAll('_', ' ')}</strong><p>{f.value}</p><button className="inline-link" onClick={() => void showReference(f.source_id)}>“{f.quote}”</button></div><button className="icon" aria-label={`Forget ${f.key}`} onClick={async () => { await api(`/memory/${f.key}`, { method: 'DELETE' }); await memoryPanel(); }}><Trash2 size={15}/></button></div>) : <div className="memory-empty">Nothing saved yet.<p>Tell me a preference or what you’re working on. Only useful, explicitly stated facts belong here.</p></div>}<p className="subtle small">Forgetting a profile fact keeps your chat history. Deleting a conversation removes its messages and memories saved from it. Saved facts may appear shortly after a reply.</p></> : <><SlidersHorizontal size={24}/><h2>Make yourself at home</h2><p className="subtle">Use a model you already have access to. Add keys to the server’s <code>.env</code> file and restart.</p><div className="settings-list">{config?.providers.map(p => <div key={p.id}><span><strong>{p.label}</strong><small>{p.model || 'Set a model ID in .env'}</small></span><span className={`connection ${p.available ? 'connected' : ''}`}>{p.available ? 'Connected' : 'Not configured'}</span></div>)}<div><span><strong>Web search</strong><small>TAVILY_API_KEY</small></span><span className={`connection ${config?.searchAvailable ? 'connected' : ''}`}>{config?.searchAvailable ? 'Connected' : 'Not configured'}</span></div></div><p className="subtle small">Current timezone: {timezone}. Keys stay on the server. Compatible models need streaming and tool calling. No subscription is required.</p><a className="text-button" href="https://github.com/vercel/ai" target="_blank" rel="noreferrer">About the provider adapter <ArrowUpRight size={14}/></a></>}</section></div>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
