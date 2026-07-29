function req(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Не задана обязательная переменная окружения: ${name}`);
  return v;
}

export const cfg = {
  tz: process.env.SALON_TZ || 'Asia/Almaty',
  port: Number(process.env.PORT || 3000),
  nodeEnv: process.env.NODE_ENV || 'production',

  db: {
    url: req('DATABASE_URL'),
    max: Number(process.env.DB_POOL_MAX || 8),
  },

  waha: {
    url: (process.env.WAHA_URL || 'http://waha:3000').replace(/\/+$/, ''),
    apiKey: req('WAHA_API_KEY'),
    session: process.env.WAHA_SESSION || 'default',
    hmacKey: req('WAHA_HMAC_KEY'),

    filesMount: process.env.WAHA_FILES_MOUNT || '/app/waha-files',
  },

  asr: {
    url: (process.env.ASR_URL || '').replace(/\/+$/, ''),
    timeoutMs: Number(process.env.ASR_TIMEOUT_MS || 12000),

    groqKey: process.env.GROQ_API_KEY || '',
  },

  llm: {
    provider: process.env.LLM_PROVIDER || 'deepseek',
    apiKey: req('LLM_API_KEY'),
    freeModel: process.env.LLM_FREE_MODEL || '',
    maxToolRounds: Number(process.env.LLM_MAX_TOOL_ROUNDS || 8),
    maxTokens: Number(process.env.LLM_MAX_TOKENS || 900),
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 45000),
  },

  debounce: {
    quietMs: Number(process.env.DEBOUNCE_QUIET_MS || 7000),
    hardCapMs: Number(process.env.DEBOUNCE_HARD_MS || 25000),
    tickMs: Number(process.env.DEBOUNCE_TICK_MS || 1000),
  },

  devAlerts: {
    telegramToken: process.env.DEV_TELEGRAM_TOKEN || '',
    telegramChatId: process.env.DEV_TELEGRAM_CHAT_ID || '',
  },

  push: {
    publicKey: process.env.VAPID_PUBLIC_KEY || '',
    privateKey: process.env.VAPID_PRIVATE_KEY || '',
    subject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
  },

  panel: {
    sessionSecret: req('SESSION_SECRET'),
    origin: process.env.PANEL_ORIGIN || 'http://localhost:3001',
    sessionDays: Number(process.env.PANEL_SESSION_DAYS || 30),
  },

  selfUrl: process.env.SELF_URL || 'http://bot:3000',

  baseDomain: process.env.BASE_DOMAIN || '',

  sheets: {
    email: process.env.GOOGLE_SA_EMAIL || '',

    key: (process.env.GOOGLE_SA_KEY || '').replace(/\\n/g, '\n'),
  },
};

export const isProd = cfg.nodeEnv === 'production';
