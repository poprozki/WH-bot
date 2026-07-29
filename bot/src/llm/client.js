import OpenAI from 'openai';
import { cfg } from '../config.js';
import { getProvider } from './providers.js';
import { log } from '../log.js';

const provider = getProvider(cfg.llm.provider);

const client = new OpenAI({
  apiKey: cfg.llm.apiKey,
  baseURL: provider.baseURL,
  defaultHeaders: provider.headers,
  timeout: cfg.llm.timeoutMs,
  maxRetries: 2,
});

export class LlmError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind;
  }
}

function classify(err) {
  const status = err?.status ?? err?.response?.status;
  const msg = String(err?.message || '').toLowerCase();
  if (status === 429) return 'rate_limit';
  if (status === 402 || msg.includes('insufficient balance') || msg.includes('quota')) return 'no_balance';
  if (msg.includes('timeout') || msg.includes('aborted')) return 'timeout';
  if (status >= 500) return 'server';
  return 'other';
}

export async function chat({ messages, tools, temperature = 0.3 }) {
  const body = {
    model: provider.model,
    messages,
    max_tokens: cfg.llm.maxTokens,
    temperature,
    ...provider.extra,
  };

  if (tools?.length) {
    body.tools = tools;

    body.tool_choice = 'auto';
  }

  try {
    const res = await client.chat.completions.create(body);

    const usage = res.usage || {};
    const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;

    log.debug('llm usage', {
      in: usage.prompt_tokens, out: usage.completion_tokens, cached,
    });

    return { message: res.choices?.[0]?.message ?? {}, usage, cachedTokens: cached };
  } catch (err) {
    const kind = classify(err);
    log.warn('llm call failed', { kind, err: String(err.message).slice(0, 200) });
    throw new LlmError(err.message, kind);
  }
}

export const providerInfo = {
  name: cfg.llm.provider,
  model: provider.model,
  supportsCache: provider.supportsCache,
};
