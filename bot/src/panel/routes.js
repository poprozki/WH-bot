import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { q, one, tx, isSlotTaken, appError } from '../db.js';
import { cfg } from '../config.js';
import { log } from '../log.js';
import { requireAuth, sameSiteOnly } from './auth.js';
import { render, h } from './render.js';
import { mountSettings } from './settings.js';
import { mountStudio } from './studio.js';
import { mountSalons } from './salons.js';
import { tenantResolver } from '../tenants.js';
import { runInTenant, runAsAdmin } from '../tenant-context.js';
import { enqueueOut } from '../outbox.js';
import { pauseBot, resumeBot } from '../handoff.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isoDate = (d = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: cfg.tz }).format(d);

const humanDate = (iso) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString('ru-RU', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: cfg.tz,
  });

const hhmm = (ts) =>
  new Date(ts).toLocaleTimeString('ru-RU', {
    hour: '2-digit', minute: '2-digit', timeZone: cfg.tz,
  });

const money = (kzt) => `${Number(kzt).toLocaleString('ru-RU')} ₸`;

const maskPhoneUi = (p) => {
  const s = String(p || '');
  return s.length < 6 ? '•••' : `${s.slice(0, 2)} ••• ••• ${s.slice(-4)}`;
};

function shiftDate(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function loadDay(dateIso, masterId = null) {
  return q(
    `SELECT a.id, a.starts_at, a.ends_at, a.duration_min, a.price_kzt, a.status, a.comment,
            s.name AS service,
            m.id AS master_id, m.name AS master, m.color,
            c.id AS client_id, c.name AS client_name, c.phone_e164,
            (c.bot_paused_until IS NOT NULL AND c.bot_paused_until > now()) AS bot_paused,
            c.bot_paused_until
       FROM appointments a
       JOIN services s ON s.id = a.service_id
       JOIN masters  m ON m.id = a.master_id
       JOIN clients  c ON c.id = a.client_id
      WHERE (a.starts_at AT TIME ZONE $1)::date = $2::date
        AND ($3::int IS NULL OR a.master_id = $3)
        AND a.status <> 'cancelled'
      ORDER BY a.starts_at, m.id`,
    [cfg.tz, dateIso, masterId]
  );
}

export function mountPanel(app) {
  const r = express.Router();

  r.use(express.urlencoded({ extended: false }));
  r.use(sameSiteOnly);

  r.use('/static', express.static(path.join(__dirname, 'static'), {
    maxAge: '7d', immutable: true,
  }));

  r.get('/manifest.webmanifest', (_req, res) => {
    res.type('application/manifest+json').send(JSON.stringify({
      name: 'Студия — записи',
      short_name: 'Записи',
      start_url: '/',
      display: 'standalone',
      background_color: '#000000',
      theme_color: '#000000',
      lang: 'ru',
      icons: [
        { src: '/panel/static/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
        { src: '/panel/static/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
      ],
    }));
  });

  r.use(requireAuth);

  r.use(tenantResolver({ baseDomain: cfg.baseDomain }));
  r.use((req, res, next) => {
    const actor = `panel:${req.user?.email || 'dev'}`;

    res.locals.impersonating = req.impersonating ? req.tenant.name : null;
    res.locals.salonName = req.tenant?.name || '';
    if (!req.tenant) return runAsAdmin(actor, () => next());
    runInTenant(req.tenant.id, actor, () => next());
  });

  r.get('/', async (req, res) => {
    const today = isoDate();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : today;
    const masterId = req.query.master ? Number(req.query.master) : null;

    const [appts, masters] = await Promise.all([
      loadDay(date, masterId),
      q(`SELECT id, name, color FROM masters WHERE active ORDER BY id`),
    ]);

    const strip = [];
    for (let i = -3; i <= 7; i += 1) {
      const d = shiftDate(today, i);
      strip.push({
        iso: d,
        day: new Date(`${d}T12:00:00Z`).getUTCDate(),
        wd: new Date(`${d}T12:00:00Z`).toLocaleDateString('ru-RU', { weekday: 'short' }),
        isToday: d === today,
        isActive: d === date,
      });
    }

    const byMaster = new Map();
    for (const a of appts) {
      if (!byMaster.has(a.master_id)) byMaster.set(a.master_id, { master: a, items: [] });
      byMaster.get(a.master_id).items.push(a);
    }

    res.send(render('day', {
      title: humanDate(date),
      date, today, masterId, strip, masters,
      groups: [...byMaster.values()],
      total: appts.length,
      revenue: appts.filter((a) => a.status !== 'no_show')
                    .reduce((s, a) => s + a.price_kzt, 0),
      hhmm, money, maskPhoneUi,
      user: req.user,
    }));
  });

  r.post('/appt/:id/status', async (req, res) => {
    const id = Number(req.params.id);
    const status = req.body.status;
    if (!['done', 'no_show', 'confirmed'].includes(status)) {
      return res.status(400).send('Неизвестный статус');
    }

    await tx(async (c) => {
      await c.query(`UPDATE appointments SET status = $2 WHERE id = $1`, [id, status]);
      if (status === 'done') {
        await c.query(
          `UPDATE clients SET visits_count = visits_count + 1, last_visit_at = now()
            WHERE id = (SELECT client_id FROM appointments WHERE id = $1)`, [id]
        );
      }
      if (status === 'no_show') {
        await c.query(
          `UPDATE clients SET no_show_count = no_show_count + 1
            WHERE id = (SELECT client_id FROM appointments WHERE id = $1)`, [id]
        );
      }
    }, `panel:${req.user.email}`);

    const appt = await one(
      `SELECT a.id, a.starts_at, a.price_kzt, a.status, a.comment,
              s.name AS service, m.name AS master, m.color, m.id AS master_id,
              c.id AS client_id, c.name AS client_name, c.phone_e164,
              (c.bot_paused_until IS NOT NULL AND c.bot_paused_until > now()) AS bot_paused
         FROM appointments a
         JOIN services s ON s.id = a.service_id
         JOIN masters  m ON m.id = a.master_id
         JOIN clients  c ON c.id = a.client_id
        WHERE a.id = $1`, [id]
    );
    res.send(render('_card', { a: appt, hhmm, money, maskPhoneUi }));
  });

  r.post('/appt/:id/cancel', async (req, res) => {
    const id = Number(req.params.id);
    const notify = req.body.notify === '1';

    const appt = await one(
      `SELECT a.starts_at, s.name AS service, c.id AS client_id,
              c.jids[array_length(c.jids,1)] AS chat_id
         FROM appointments a
         JOIN services s ON s.id = a.service_id
         JOIN clients  c ON c.id = a.client_id
        WHERE a.id = $1 AND a.status IN ('pending','confirmed')`, [id]
    );
    if (!appt) return res.status(404).send('Запись не найдена');

    await tx(async (c) => {
      await c.query(`SELECT cancel_appointment($1, 'отменено из панели')`, [id]);
      if (notify && appt.chat_id) {
        await enqueueOut(c, {
          chatId: appt.chat_id,
          clientId: appt.client_id,
          dedupKey: `cancel-notice:${id}`,
          body:
            `Здравствуйте! К сожалению, вашу запись на ${hhmm(appt.starts_at)} пришлось отменить. ` +
            `Извините, пожалуйста. Напишите, если хотите подобрать другое время — подберём удобное.`,
        });
      }
    }, `panel:${req.user.email}`);

    res.set('HX-Trigger', 'refreshDay').send('');
  });

  r.post('/client/:id/bot', async (req, res) => {
    const id = Number(req.params.id);
    if (req.body.action === 'pause') {
      await pauseBot(id, Number(req.body.minutes || 120), `панель: ${req.user.email}`);
    } else {
      await resumeBot(id);
    }
    res.set('HX-Trigger', 'refreshDay').send('');
  });

  r.get('/client/:id/phone', async (req, res) => {
    const id = Number(req.params.id);
    const c = await one(`SELECT phone_e164 FROM clients WHERE id = $1`, [id]);
    if (!c) return res.status(404).send('Не найдено');

    await q(`INSERT INTO pii_reveals (email, client_id) VALUES ($1, $2)`, [req.user.email, id]);
    const digits = c.phone_e164.replace(/\D/g, '');
    res.redirect(302, `https://wa.me/${digits}`);
  });

  r.get('/new', async (req, res) => {
    const [services, masters] = await Promise.all([
      q(`SELECT id, name, duration_min, price_kzt FROM services WHERE active ORDER BY sort_order`),
      q(`SELECT id, name FROM masters WHERE active ORDER BY id`),
    ]);
    res.send(render('new', {
      title: 'Новая запись',
      services, masters,
      date: req.query.date || isoDate(),
      user: req.user,
    }));
  });

  r.get('/new/slots', async (req, res) => {
    const serviceId = Number(req.query.service);
    const date = req.query.date;
    const masterId = req.query.master ? Number(req.query.master) : null;
    if (!serviceId || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return res.send('');

    const slots = await q(
      `SELECT master_id, master_name, starts_at, price_kzt FROM free_slots($1, $2::date, $3)`,
      [serviceId, date, masterId]
    );
    res.send(render('_slots', { slots, hhmm, money }));
  });

  r.post('/new', async (req, res) => {
    const { phone, name, service, master, starts_at } = req.body;
    const digits = String(phone || '').replace(/\D/g, '');
    if (digits.length < 8) return res.status(400).send('Некорректный телефон');
    const e164 = `+${digits}`;

    try {
      await tx(async (c) => {
        const { rows: cl } = await c.query(`SELECT upsert_client($1, $2, $3) AS id`,
          [e164, `${digits}@c.us`, name || null]);
        await c.query(
          `SELECT book_appointment($1, $2, $3, $4::timestamptz, 'panel', '')`,
          [cl[0].id, Number(master), Number(service), starts_at]
        );
      }, `panel:${req.user.email}`);
      res.set('HX-Redirect', `/panel/?date=${isoDate(new Date(starts_at))}`).send('');
    } catch (e) {
      if (isSlotTaken(e)) {
        return res.status(409).send(
          '<div class="err">Это время уже занято. Обновите список и выберите другое.</div>'
        );
      }
      const code = appError(e);
      const msgs = {
        SLOT_OUTSIDE_HOURS: 'Это время вне графика мастера.',
        TOO_SOON: 'Слишком близко к текущему моменту.',
        TOO_FAR: 'Слишком далеко вперёд.',
      };
      log.error('ошибка записи из панели', { err: e.message });
      res.status(400).send(`<div class="err">${msgs[code] || 'Не получилось записать.'}</div>`);
    }
  });

  r.post('/push/subscribe', express.json(), async (req, res) => {
    const { endpoint, keys } = req.body || {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) return res.status(400).end();
    await q(
      `INSERT INTO push_subscriptions (email, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET fail_count = 0, last_ok_at = now()`,
      [req.user.email, endpoint, keys.p256dh, keys.auth]
    );
    res.status(204).end();
  });

  r.get('/push/key', (_req, res) => res.send(cfg.push.publicKey || ''));

  r.get('/qr', async (_req, res) => {
    const H = { 'X-Api-Key': cfg.waha.apiKey };
    let status = 'UNKNOWN';
    try {
      const s = await fetch(`${cfg.waha.url}/api/sessions/${cfg.waha.session}`, { headers: H });
      if (s.ok) status = (await s.json())?.status || 'UNKNOWN';
    } catch { status = 'UNREACHABLE'; }

    const page = (body, refresh) => `<!doctype html><html lang="ru"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''}
<title>Привязка WhatsApp</title>
<style>
 body{background:#000;color:#f2f2f3;font:16px/1.5 system-ui,sans-serif;
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      min-height:100vh;margin:0;padding:24px;text-align:center}
 img{width:min(78vw,340px);height:auto;background:#fff;padding:14px;border-radius:16px}
 .s{color:#7d7d85;font-size:14px;margin-top:14px}
 .ok{color:#56d364;font-size:22px;font-weight:600}
 .err{color:#ff7b72}
 ol{text-align:left;max-width:340px;color:#7d7d85;font-size:14px;line-height:1.7}
</style></head><body>${body}</body></html>`;

    if (status === 'WORKING') {
      return res.send(page(
        `<div class="ok">Телефон привязан</div>
         <div class="s">Бот подключён к WhatsApp и готов отвечать.</div>`, 0));
    }

    if (status !== 'SCAN_QR_CODE') {

      try {
        if (status === 'UNKNOWN' || status === 'UNREACHABLE') {
          await fetch(`${cfg.waha.url}/api/sessions`, {
            method: 'POST',
            headers: { ...H, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: cfg.waha.session, start: true }),
          });
        } else {
          await fetch(`${cfg.waha.url}/api/sessions/${cfg.waha.session}/restart`, {
            method: 'POST', headers: H,
          });
        }
      } catch {  }

      return res.send(page(
        `<div>Поднимаю сессию…</div>
         <div class="s">Состояние: ${h(status)}${status === 'FAILED'
           ? '<br>Прошлый код никто не отсканировал, беру новый.' : ''}</div>`, 4));
    }

    try {
      const q2 = await fetch(
        `${cfg.waha.url}/api/${cfg.waha.session}/auth/qr?format=image`,
        { headers: { ...H, Accept: 'image/png' } }
      );
      if (!q2.ok) throw new Error(`WAHA вернула ${q2.status}`);
      const b64 = Buffer.from(await q2.arrayBuffer()).toString('base64');
      return res.send(page(
        `<img src="data:image/png;base64,${b64}" alt="QR">
         <ol>
           <li>WhatsApp на телефоне</li>
           <li>Настройки → Связанные устройства</li>
           <li>Привязка устройства</li>
           <li>Наведите камеру на код</li>
         </ol>
         <div class="s">Код обновляется сам каждые 20 секунд.<br>Берите отдельный номер, не личный.</div>`,
        20));
    } catch (e) {
      return res.send(page(
        `<div class="err">Не удалось получить код</div><div class="s">${h(e.message)}</div>`, 5));
    }
  });

  mountSettings(r);
  mountStudio(r);
  mountSalons(r);

  app.use('/panel', r);

  app.get('/', (_req, res) => res.redirect('/panel/'));

  log.info('веб-панель подключена на /panel');
}
