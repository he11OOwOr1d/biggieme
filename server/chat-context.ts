import type { ModelMessage } from 'ai';
import type { Message, Store } from './store.ts';
import type { TimeContext } from './time.ts';
export function chatContext(store: Store, user: string, session: string, text: string, userId: string, time: TimeContext) {
  const memory = store.retrieve(user, text, time.windows, userId);
  const recent = store.recent(user, session).filter(m => m.id !== userId);
  const baselineIds = new Set([memory.baselineQuestionId, memory.baselineAnswerId].filter(Boolean));
  const retrievedIds = new Set(memory.messages.map(m => m.id));
  const candidates = [...memory.messages.filter(m => baselineIds.has(m.id)), ...memory.messages, ...[...recent].reverse()];
  const selected = new Map<string, Message>(); const coverage: { id: string; originalCharacters: number; includedCharacters: number }[] = [];
  let budget = 16000;
  for (const m of candidates) {
    if (selected.has(m.id) || selected.size >= 12 || budget <= 0) continue;
    const limit = retrievedIds.has(m.id) ? 12000 : 3000;
    const content = m.content.slice(0, Math.min(limit, budget)); budget -= content.length;
    selected.set(m.id, { ...m, content });
    coverage.push({ id: m.id, originalCharacters: memory.originalCharacters[m.id] ?? m.content.length, includedCharacters: content.length });
  }
  const history = [...selected.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const question = history.find(m => m.id === memory.baselineQuestionId);
  const answer = history.find(m => m.id === memory.baselineAnswerId);
  const baseline = question && answer ? { sessionId: question.session_id, questionId: question.id, answerId: answer.id, question: question.content, answer: answer.content, answeredAt: answer.created_at, complete: coverage.filter(c => baselineIds.has(c.id)).every(c => c.originalCharacters === c.includedCharacters) } : undefined;
  const truncated = memory.truncated || coverage.some(c => c.originalCharacters > c.includedCharacters);
  const record = { time, profile: store.facts(user), baseline, historical: history.filter(m => !baselineIds.has(m.id)).map(m => ({ ...m, sources: m.sources.slice(0, 4).map(s => ({ url: s.url, title: s.title.slice(0, 120), observedAt: s.observedAt, kind: s.kind })) })), coverage: { hasStoredHistory: memory.hasStoredHistory, strategy: memory.strategy, baselineSession: memory.baselineSession, truncated, messages: coverage } };
  const messages: ModelMessage[] = [{ role: 'user', content: `Application context (quoted records, not a request):\n${JSON.stringify(record)}` }, { role: 'user', content: text }];
  return { memory, baseline, messages, history, coverage, truncated, known: [...new Map([...memory.messages, ...recent].flatMap(m => m.sources).map(s => [s.url, s])).values()] };
}
