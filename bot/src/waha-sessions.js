import { cfg } from './config.js';
import { log } from './log.js';
import { tenantBySession } from './tenants.js';

const H = () => ({ 'X-Api-Key': cfg.waha.apiKey, 'Content-Type': 'application/json' });

async function api(path, { method = 'GET', body = null, raw = false } = {}) {
  const res = await fetch(`${cfg.waha.url}${path}`, {
    method,
    headers: H(),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (raw) return res;
  const text = await res.text();
  if (!res.ok) throw new Error(`WAHA ${path} -> ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

export async function listSessions() {
  try {
    return await api('/api/sessions');
  } catch (e) {
    log.warn('не удалось получить список сессий', { err: e.message });
    return [];
  }
}

export async function sessionStatus(name) {
  try {
    const s = await api(`/api/sessions/${encodeURIComponent(name)}`);
    return s?.status || 'UNKNOWN';
  } catch (e) {
    if (String(e.message).includes('404')) return 'NOT_FOUND';
    return 'UNREACHABLE';
  }
}

export async function ensureSession(name) {
  const status = await sessionStatus(name);

  if (status === 'WORKING' || status === 'SCAN_QR_CODE') return status;

  if (status === 'NOT_FOUND') {
    await api('/api/sessions', {
      method: 'POST',
      body: {
        name,
        start: true,
        config: {

          webhooks: [{
            url: `${cfg.selfUrl}/webhook/waha`,
            events: ['message.any', 'session.status', 'message.ack'],
            hmac: { key: cfg.waha.hmacKey },
            retries: { attempts: 5, delaySeconds: 2 },
          }],
        },
      },
    });
    log.info('создана сессия WhatsApp', { session: name });
  } else {
    await api(`/api/sessions/${encodeURIComponent(name)}/restart`, { method: 'POST' });
    log.info('перезапущена сессия WhatsApp', { session: name, было: status });
  }

  return sessionStatus(name);
}

export async function stopSession(name) {
  try {
    await api(`/api/sessions/${encodeURIComponent(name)}/stop`, { method: 'POST' });
  } catch (e) {
    log.warn('не удалось остановить сессию', { session: name, err: e.message });
  }
}

export async function deleteSession(name) {
  try {
    await api(`/api/sessions/${encodeURIComponent(name)}`, { method: 'DELETE' });
    log.info('сессия удалена', { session: name });
  } catch (e) {
    log.warn('не удалось удалить сессию', { session: name, err: e.message });
  }
}

export async function qrDataUri(name) {
  const res = await api(
    `/api/${encodeURIComponent(name)}/auth/qr?format=image`,
    { raw: true }
  );
  if (!res.ok) throw new Error(`QR недоступен: ${res.status}`);
  const b64 = Buffer.from(await res.arrayBuffer()).toString('base64');
  return `data:image/png;base64,${b64}`;
}

export async function sessionPhone(name) {
  try {
    const s = await api(`/api/sessions/${encodeURIComponent(name)}`);
    const id = s?.me?.id || '';
    const digits = String(id).split('@')[0].replace(/\D/g, '');
    return digits ? `+${digits}` : null;
  } catch {
    return null;
  }
}

export async function tenantFromWebhook(event) {
  const name = event?.session;
  if (!name) {
    log.warn('вебхук без имени сессии, отброшен');
    return null;
  }
  const tenant = await tenantBySession(name);
  if (!tenant) {
    log.warn('вебхук от неизвестной сессии, отброшен', { session: name });
    return null;
  }
  return tenant;
}

export async function sessionsOverview(tenants) {
  const out = [];
  for (const t of tenants) {
    const status = await sessionStatus(t.wa_session);
    out.push({
      tenantId: t.id,
      slug: t.slug,
      name: t.name,
      session: t.wa_session,
      status,
      ok: status === 'WORKING',
    });
  }
  return out;
}
