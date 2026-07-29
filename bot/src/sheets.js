import crypto from 'node:crypto';
import { cfg } from './config.js';
import { log } from './log.js';
import { withTenant } from './tenant-db.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

let cachedToken = null;

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function getToken() {
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.value;
  if (!cfg.sheets.email || !cfg.sheets.key) {
    throw new Error('Google Таблицы не настроены: нет GOOGLE_SA_EMAIL или GOOGLE_SA_KEY');
  }

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: cfg.sheets.email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const sig = b64url(signer.sign(cfg.sheets.key));
  const jwt = `${header}.${claim}.${sig}`;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`Google не выдал токен: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json();
  cachedToken = { value: data.access_token, exp: Date.now() + (data.expires_in - 120) * 1000 };
  return cachedToken.value;
}

async function sheetsApi(spreadsheetId, path, { method = 'GET', body = null } = {}) {
  const token = await getToken();
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}${path}`,
    {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    }
  );
  const text = await res.text();
  if (!res.ok) {

    if (res.status === 403) {
      throw new Error(
        `Нет доступа к таблице. Откройте её и дайте права редактора на ${cfg.sheets.email}`
      );
    }
    if (res.status === 404) throw new Error('Таблица не найдена — проверьте ссылку');
    if (res.status === 429) throw new Error('Слишком часто обращаемся к таблице, попробуем позже');
    throw new Error(`Google Таблицы: ${res.status} ${text.slice(0, 200)}`);
  }
  return text ? JSON.parse(text) : null;
}

export function sheetIdFromUrl(url) {
  const m = String(url || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : (/^[a-zA-Z0-9-_]{20,}$/.test(String(url).trim()) ? String(url).trim() : null);
}

const HEADERS = [
  'Дата', 'Время', 'Клиентка', 'Телефон', 'Услуги',
  'Мастер', 'Длительность, мин', 'Стоимость, ₸', 'Статус', 'Источник', 'Создана',
];

const STATUS_RU = {
  pending: 'ожидает', confirmed: 'подтверждена', done: 'состоялась',
  cancelled: 'отменена', no_show: 'не пришла',
};

export async function exportBookings(tenantId, spreadsheetId, { days = 90 } = {}) {
  const rows = await withTenant(tenantId, async (c) => {
    const { rows: r } = await c.query(`
      SELECT a.starts_at, a.duration_min, a.price_kzt, a.status, a.source, a.created_at,
             c.name AS client_name, c.phone_e164,
             m.name AS master,
             (SELECT string_agg(s.name, ' + ' ORDER BY x.position)
                FROM appointment_services x JOIN services s ON s.id = x.service_id
               WHERE x.appointment_id = a.id) AS services
        FROM appointments a
        JOIN clients c ON c.id = a.client_id
        JOIN masters m ON m.id = a.master_id
       WHERE a.starts_at > now() - make_interval(days => $1)
       ORDER BY a.starts_at DESC
       LIMIT 5000`, [days]);
    return r;
  }, 'system');

  const tz = 'Asia/Almaty';
  const values = [HEADERS, ...rows.map((r) => {
    const d = new Date(r.starts_at);
    return [
      d.toLocaleDateString('ru-RU', { timeZone: tz }),
      d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: tz }),
      r.client_name || '',
      r.phone_e164 || '',
      r.services || '',
      r.master,
      r.duration_min,
      r.price_kzt,
      STATUS_RU[r.status] || r.status,
      r.source === 'bot' ? 'бот' : r.source === 'panel' ? 'вручную' : r.source,
      new Date(r.created_at).toLocaleDateString('ru-RU', { timeZone: tz }),
    ];
  })];

  await sheetsApi(spreadsheetId, '/values/Записи!A:Z:clear', { method: 'POST', body: {} })
    .catch(async (e) => {

      if (String(e.message).includes('Unable to parse range')) {
        await sheetsApi(spreadsheetId, ':batchUpdate', {
          method: 'POST',
          body: { requests: [{ addSheet: { properties: { title: 'Записи' } } }] },
        });
      } else throw e;
    });

  await sheetsApi(
    spreadsheetId,
    '/values/Записи!A1:K' + values.length + '?valueInputOption=USER_ENTERED',
    { method: 'PUT', body: { values } }
  );

  log.info('выгружено в Google Таблицу', { tenantId, строк: rows.length });
  return rows.length;
}

export async function testAccess(spreadsheetId) {
  const meta = await sheetsApi(spreadsheetId, '?fields=properties.title,sheets.properties.title');
  return {
    ok: true,
    title: meta?.properties?.title || 'без названия',
    sheets: (meta?.sheets || []).map((s) => s.properties.title),
  };
}
