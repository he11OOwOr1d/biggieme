import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

export type ProviderId = 'openai' | 'anthropic' | 'compatible';
export function providers() {
  return [
    { id: 'openai' as const, label: 'OpenAI', model: process.env.OPENAI_MODEL || 'gpt-6-luna', available: !!process.env.OPENAI_API_KEY },
    { id: 'anthropic' as const, label: 'Anthropic', model: process.env.ANTHROPIC_MODEL || '', available: !!(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_MODEL) },
    { id: 'compatible' as const, label: 'OpenAI compatible', model: process.env.COMPATIBLE_MODEL || '', available: !!(process.env.COMPATIBLE_BASE_URL && process.env.COMPATIBLE_MODEL && (process.env.COMPATIBLE_API_KEY || process.env.COMPATIBLE_NO_AUTH === 'true')) },
  ];
}
export function modelFor(id: ProviderId): LanguageModel {
  const config = providers().find(p => p.id === id);
  if (!config?.available) throw new Error(`Configure ${id} in .env before chatting.`);
  if (id === 'openai') return createOpenAI({ apiKey: process.env.OPENAI_API_KEY }).responses(config.model);
  if (id === 'anthropic') return createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })(config.model);
  return createOpenAICompatible({ name: 'compatible', baseURL: process.env.COMPATIBLE_BASE_URL!, apiKey: process.env.COMPATIBLE_API_KEY || undefined }).chatModel(config.model);
}
export function providerOptions(id: ProviderId): Record<string, Record<string, string | boolean | null>> | undefined {
  if (id === 'compatible' && process.env.COMPATIBLE_BASE_URL
    && new URL(process.env.COMPATIBLE_BASE_URL).hostname === 'api.groq.com'
    && /^openai\/gpt-oss-(20b|120b)$/.test(process.env.COMPATIBLE_MODEL || '')) {
    return { compatible: { reasoningEffort: 'low' } };
  }
  return id === 'openai' && /^gpt-6/.test(process.env.OPENAI_MODEL || 'gpt-6-luna')
    ? { openai: { reasoningEffort: 'low', reasoningSummary: null, store: false } } : undefined;
}
