export const PROVIDERS = {

  deepseek: {
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',

    extra: { thinking: { type: 'disabled' } },
    headers: {},
    supportsCache: true,
  },

  openrouter_free: {
    baseURL: 'https://openrouter.ai/api/v1',
    model: process.env.LLM_FREE_MODEL || 'google/gemma-4-31b-it:free',
    extra: {},
    headers: { 'HTTP-Referer': 'https://salon.local', 'X-Title': 'Salon Bot' },
    supportsCache: false,
  },

  openrouter: {
    baseURL: 'https://openrouter.ai/api/v1',
    model: 'deepseek/deepseek-v4-flash',
    extra: {
      reasoning: { enabled: false },
      provider: { only: ['deepseek'], allow_fallbacks: false },
    },
    headers: { 'HTTP-Referer': 'https://salon.local', 'X-Title': 'Salon Bot' },
    supportsCache: true,
  },

  groq: {
    baseURL: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    extra: {},
    headers: {},
    supportsCache: false,
  },
};

export function getProvider(name) {
  const p = PROVIDERS[name];
  if (!p) {
    throw new Error(
      `Неизвестный LLM_PROVIDER: ${name}. Доступные: ${Object.keys(PROVIDERS).join(', ')}`
    );
  }
  return p;
}
