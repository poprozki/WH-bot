const stub = {
  PG_PASSWORD: 'test',
  BOT_DB_PASSWORD: 'test',
  DATABASE_URL: 'postgres://bot:test@127.0.0.1:5432/salon_test',
  WAHA_URL: 'http://127.0.0.1:3010',
  WAHA_API_KEY: 'test',
  WAHA_HMAC_KEY: 'test',
  LLM_API_KEY: 'test-key',
  LLM_PROVIDER: 'deepseek',
  SESSION_SECRET: 'test-secret-at-least-32-characters-long',
  SALON_TZ: 'Asia/Almaty',
  TZ: 'Asia/Almaty',
  NODE_ENV: 'test',
};

for (const [k, v] of Object.entries(stub)) {
  if (!process.env[k]) process.env[k] = v;
}
