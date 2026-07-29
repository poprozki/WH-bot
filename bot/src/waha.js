import crypto from 'node:crypto';
import { cfg } from './config.js';
import { log } from './log.js';

const H = { 'X-Api-Key': cfg.waha.apiKey, 'Content-Type': 'application/json' };

async function call(path, body, method = 'POST') {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(`${cfg.waha.url}${path}`, {
      method,
      headers: H,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`WAHA ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(t);
  }
}

export const waha = {
  async sendText(chatId, text) {
    return call('/api/sendText', { session: cfg.waha.session, chatId, text });
  },

  async sendImage(chatId, filePathOrUrl, caption = '') {
    return call('/api/sendImage', {
      session: cfg.waha.session,
      chatId,
      file: { url: filePathOrUrl },
      caption,
    });
  },

  async sendSeen(chatId, messageIds = []) {
    const body = { session: cfg.waha.session, chatId };
    if (messageIds.length) body.messageIds = messageIds;
    return call('/api/sendSeen', body).catch((e) => {
      log.warn('sendSeen failed', { err: e.message });
    });
  },

  async startTyping(chatId) {
    return call('/api/startTyping', { session: cfg.waha.session, chatId }).catch(() => {});
  },

  async stopTyping(chatId) {
    return call('/api/stopTyping', { session: cfg.waha.session, chatId }).catch(() => {});
  },

  async sessionStatus() {
    try {
      const s = await call(`/api/sessions/${cfg.waha.session}`, null, 'GET');
      return s?.status || 'UNKNOWN';
    } catch {
      return 'UNREACHABLE';
    }
  },
};

export function verifyHmac(rawBody, signature) {
  if (!signature) return false;
  const expected = crypto
    .createHmac('sha512', cfg.waha.hmacKey)
    .update(rawBody)
    .digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');

  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function jidToPhone(jid, fallbackPhone = null) {
  if (!jid) return fallbackPhone;

  if (jid.includes('@lid')) return fallbackPhone;
  const digits = String(jid).split('@')[0].split(':')[0].replace(/\D/g, '');
  if (!digits || digits.length < 8) return fallbackPhone;
  return `+${digits}`;
}

export function extractPhone(payload) {
  const candidates = [
    payload?.from,
    payload?.chatId,
    payload?.participant,
    payload?.author,
    payload?._data?.from,
    payload?._data?.author,
    payload?.senderPhone && `${payload.senderPhone}@c.us`,
    payload?._data?.senderPn,
    payload?.senderPn,
  ].filter(Boolean);

  for (const c of candidates) {
    const p = jidToPhone(String(c), null);
    if (p) return p;
  }
  return null;
}

export const isGroup = (chatId) => String(chatId || '').includes('@g.us');
