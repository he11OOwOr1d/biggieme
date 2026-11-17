import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { groqResearch } from '../server/groq-research.ts';

function fixture(invalid = false) {
  const requests: any[] = [];
  const provider = createOpenAICompatible({ name: 'compatible', baseURL: 'https://fixture.example/v1', supportsStructuredOutputs: true, fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body)); requests.push(body);
    assert.equal(body.tools, undefined, 'Groq requests must never contain native function definitions');
    assert.equal(body.tool_choice, undefined);
    if (!body.stream) {
      assert.equal(body.response_format.type, 'json_schema');
      assert.equal(body.response_format.json_schema.strict, true);
      return Response.json({ id: 'plan', object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content: invalid ? 'invalid JSON' : JSON.stringify({ action: 'search', queries: ['SQLite releases'], urls: [] }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
    }
    const text = invalid ? 'I could not verify changes because research planning failed.' : 'I checked the SQLite release page.';
    const chunks = [{ id: 'answer', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] }, { id: 'answer', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }];
    return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  } });
  return { requests, model: provider.chatModel('fixture') };
}
test('Groq uses a validated JSON plan and separate text stream with zero native tool requests', async () => {
  const { model, requests } = fixture(); let text = ''; const executions: any[] = [];
  await groqResearch({ model, messages: [{ role: 'user', content: 'Has anything changed since our last chat about SQLite?' }], instructions: 'Use supplied evidence.', signal: new AbortController().signal, providerOptions: undefined, known: [], needsFreshSearch: true, onText: chunk => { text += chunk; }, execute: async input => {
    executions.push(input);
    return { sources: [{ id: 's', url: 'https://sqlite.org/changes.html', title: 'SQLite', content: 'Release notes', observedAt: '2026-11-17', query: 'SQLite releases', kind: input.queries.length ? 'search' : 'page' }], errors: [], note: 'Fixture evidence' };
  } });
  assert.equal(requests.at(-1).messages.at(-1).content, 'Has anything changed since our last chat about SQLite?');
  assert.equal(requests.length, 2); assert.equal(executions.length, 2);
  assert.deepEqual(executions[0], { queries: ['SQLite releases'], urls: [], fresh: true });
  assert.deepEqual(executions[1].urls, ['https://sqlite.org/changes.html']);
  assert.match(text, /checked/);
});
test('unparseable plans retry once, execute nothing, and synthesize an explicit research failure', async () => {
  const { model, requests } = fixture(true); let calls = 0; let text = '';
  await groqResearch({ model, messages: [{ role: 'user', content: 'Check updates' }], instructions: 'Disclose missing evidence.', signal: new AbortController().signal, providerOptions: undefined, known: [], needsFreshSearch: true, onText: chunk => { text += chunk; }, execute: async () => { calls++; throw new Error('Invalid plans cannot execute'); } });
  assert.equal(calls, 0); assert.equal(requests.length, 2); assert.match(text, /could not verify/);
  assert.ok(requests.every(r => !r.stream), 'Failed planning must not trigger a misleading synthesis call');
});

test('all-search failure preserves the baseline link and skips unsupported answer generation', async () => {
 const {model,requests}=fixture();let text='';const stages:string[]=[];
 await groqResearch({model,messages:[{role:'user',content:'Has anything changed?'}],instructions:'Use evidence.',signal:new AbortController().signal,providerOptions:undefined,known:[],needsFreshSearch:true,baseline:{question:'Compare coding tools',answerId:'original-answer',answeredAt:'2026-11-17T00:00:00Z'},onStage:stage=>{stages.push(stage);},onText:chunk=>{text+=chunk;},execute:async()=>({sources:[],errors:['Web search timed out after 20 seconds.']})});
 assert.equal(requests.length,1);assert.ok(stages.includes('research_unverified'));assert.match(text,/#message-original-answer/);assert.match(text,/could not verify changes/);assert.doesNotMatch(text,/remains (accurate|current|verified)/);
});
