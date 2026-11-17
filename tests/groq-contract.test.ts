import test from 'node:test';
import assert from 'node:assert/strict';
import { generateText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { SearchService } from '../server/search.ts';

test('Groq search contract uses strict schema and SDK validation through the actual adapter', async () => {
  let request: any;
  const provider = createOpenAICompatible({ name: 'compatible', baseURL: 'https://fixture.example/v1', apiKey: 'fixture-only', fetch: async (_url, init) => {
    request = JSON.parse(String(init?.body));
    return Response.json({ id: 'fixture', object: 'chat.completion', created: 1, model: 'openai/gpt-oss-120b', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'fixture-call', type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ queries: [], urls: [], fresh: true }) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  } });
  const search = new SearchService('fixture-only');
  await generateText({ model: provider.chatModel('openai/gpt-oss-120b'), prompt: 'Search SQLite releases', toolChoice: 'required', providerOptions: { compatible: { disable_tool_validation: true, reasoningEffort: 'low' } }, tools: { web_search: search.makeTool([], () => {}, () => {}, undefined, false, true) } });
  assert.equal(request.tool_choice, 'required');
  assert.equal(request.disable_tool_validation, true);
  assert.equal(request.reasoning_effort, 'low');
  const fn = request.tools[0].function;
  assert.equal(fn.name, 'web_search');
  assert.equal(fn.strict, true);
  assert.deepEqual([...fn.parameters.required].sort(), ['fresh', 'queries', 'urls']);
  assert.equal(fn.parameters.additionalProperties, false);
  assert.equal(fn.parameters.properties.queries.type, 'array');
  assert.equal(fn.parameters.properties.queries.items.type, 'string');
  assert.equal(fn.parameters.properties.urls.type, 'array');
  assert.equal(fn.parameters.properties.fresh.type, 'boolean');
  assert.equal(fn.parameters.properties.urls.items.format, undefined, 'Groq strict mode rejects JSON Schema uri format; execution still checks the URL allowlist');
});

test('Groq strict schema still refuses untrusted URL reads before any external request', async () => {
  let requests = 0;
  const search = new SearchService('fixture-only', async () => { requests++; return Response.json({}); });
  const tool = search.makeTool([], () => {}, () => {}, undefined, false, true);
  const result = await tool.execute!({ queries: [], urls: ['not a URL', 'https://private.example/unknown'], fresh: true }, {} as any) as any;
  assert.equal(requests, 0);
  assert.equal(result.sources.length, 0);
  assert.equal(result.errors.length, 2);
});

test('low reasoning effort is scoped to Groq GPT-OSS, leaving other compatible providers unchanged', async () => {
  const { providerOptions } = await import('../server/models.ts');
  const keys = ['COMPATIBLE_BASE_URL', 'COMPATIBLE_MODEL'] as const;
  const previous = keys.map(key => process.env[key]);
  try {
    process.env.COMPATIBLE_BASE_URL = 'https://api.groq.com/openai/v1';
    process.env.COMPATIBLE_MODEL = 'openai/gpt-oss-120b';
    assert.deepEqual(providerOptions('compatible'), { compatible: { reasoningEffort: 'low' } });
    process.env.COMPATIBLE_MODEL = 'other-model';
    assert.equal(providerOptions('compatible'), undefined);
    process.env.COMPATIBLE_MODEL = 'openai/gpt-oss-120b';
    process.env.COMPATIBLE_BASE_URL = 'https://other.example/v1';
    assert.equal(providerOptions('compatible'), undefined);
  } finally {
    keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
  }
});
