import express from 'express';
import { page, h, empty, money } from './layout.js';
import { log } from '../log.js';
import { cfg } from '../config.js';
import { listTenants, createTenant, deleteTenant, invalidateTenantCache } from '../tenants.js';
import { sessionsOverview, ensureSession, qrDataUri, sessionStatus, sessionPhone, deleteSession } from '../waha-sessions.js';
import { asPlatformAdmin, withTenant } from '../tenant-db.js';
import { sheetIdFromUrl, testAccess, exportBookings } from '../sheets.js';

const usd = (v) => `$${Number(v || 0).toFixed(2)}`;

const shell = (title, body) =>
  page({ title, body, active: 'salons', dev: true,
         back: title === 'Салоны' ? '' : '/panel/salons' });

const STATUS_RU = {
  WORKING: ['работает', 'ok'],
  SCAN_QR_CODE: ['нужен QR', 'no'],
  STARTING: ['запускается', 'hu'],
  FAILED: ['упала', 'no'],
  STOPPED: ['остановлена', 'no'],
  NOT_FOUND: ['не создана', 'no'],
  UNREACHABLE: ['недоступна', 'no'],
};

function devOnly(req, res, next) {
  const dev = req.user?.role === 'dev' || process.env.PANEL_DEV_AUTH === '1';
  if (!dev) return res.status(403).send('Только для разработчика');
  next();
}

export function mountSalons(r) {
  const s = express.Router();
  s.use(express.urlencoded({ extended: false }));
  s.use(devOnly);

  s.get('/salons', async (_req, res) => {
    const tenants = await listTenants();
    const sess = await sessionsOverview(tenants);
    const byId = new Map(sess.map((x) => [x.tenantId, x]));

    const cards = tenants.map((t) => {
      const st = byId.get(t.id) || { status: 'UNREACHABLE' };
      const [label, cls] = STATUS_RU[st.status] || [st.status, 'no'];
      const spentToday = t.llm_spent_date === new Date().toISOString().slice(0, 10)
        ? Number(t.llm_spent_today_usd) : 0;
      const overLimit = spentToday >= Number(t.llm_daily_limit_usd);

      return `
      <div class="card">
        <div class="hd" >
          <div><div class="ttl">${h(t.name)}</div><div class="sub">${h(t.slug)}</div></div>
          <span class="tag ${cls}">${h(label)}</span>
        </div>
        <div class="meta">
          <span>клиенток: ${t.clients}</span>
          <span>записей за 30 дней: ${t.appts30}</span>
          <span${overLimit ? ' style="color:var(--danger)"' : ''}>ИИ сегодня: ${usd(spentToday)} из бюджета ${usd(t.llm_daily_limit_usd)}</span>
          <span>${t.last_msg ? 'последнее сообщение: ' + new Date(t.last_msg).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) : 'сообщений нет'}</span>
        </div>
        <div class="acts">
          <a class="btn primary" href="/panel/?t=${h(t.slug)}">Открыть</a>
          <a class="btn" href="/panel/salons/${t.id}/link">${st.status === 'WORKING' ? 'WhatsApp' : 'Привязать телефон'}</a>
          <a class="btn" href="/panel/salons/${t.id}/sheets">Таблицы</a>
          <a class="btn" href="/panel/salons/${t.id}/limits">Лимиты</a>
        </div>
      </div>`;
    }).join('');

    res.send(shell('Салоны', `
      ${cards || '<div class="note">Салонов пока нет</div>'}
      <div class="cta-row">
        <a class="btn primary block lg" href="/panel/salons/new">+ Новый салон</a>
      </div>`));
  });

  s.get('/salons/new', async (_req, res) => {
    const tenants = await listTenants();
    res.send(shell('Новый салон', `
      <form class="form" method="post" action="/panel/salons/new">
        <label>Название студии
          <input name="name" required placeholder="Например: Ноготок" autofocus></label>
        <label>Адрес в интернете
          <input name="slug" required pattern="[a-z][a-z0-9-]{1,30}[a-z0-9]"
                 placeholder="nogotok"></label>
        <label>Взять услуги и мастеров из
          <select name="copy_from">
            <option value="">— стандартный набор —</option>
            ${tenants.map((t) => `<option value="${t.id}">${h(t.name)}</option>`).join('')}
          </select></label>
        <button class="btn primary block lg" type="submit">Создать</button>
      </form>
      <div class="note">
        Салон сразу получит услуги, мастера и график пн-сб 10:00-20:00 —
        иначе бот не нашёл бы ни одного свободного времени, и это выглядело бы
        как поломка. Цены владелица поправит под себя.<br><br>
        Адрес в интернете станет поддоменом: <b>nogotok</b>.${h(cfg.baseDomain || 'ваш-домен')}. Поменять его потом нельзя — к нему привязана сессия WhatsApp.
      </div>`));
  });

  s.post('/salons/new', async (req, res) => {
    try {
      const t = await createTenant({
        slug: String(req.body.slug || '').trim().toLowerCase(),
        name: String(req.body.name || '').trim(),
        copyFromTenantId: req.body.copy_from ? Number(req.body.copy_from) : null,
      });
      res.redirect(`/panel/salons/${t.id}/link`);
    } catch (e) {
      res.status(400).send(shell('Ошибка', `
        <div class="msg-err">${h(e.message)}</div>
        <div class="cta-row"><a class="btn" href="/panel/salons/new">Назад</a></div>`));
    }
  });

  s.get('/salons/:id/link', async (req, res) => {
    const t = await getTenant(Number(req.params.id));
    if (!t) return res.status(404).send('Салон не найден');

    let status = await sessionStatus(t.wa_session);
    if (status === 'NOT_FOUND' || status === 'FAILED' || status === 'STOPPED') {
      status = await ensureSession(t.wa_session);
    }

    if (status === 'WORKING') {
      const phone = await sessionPhone(t.wa_session);
      return res.send(shell(t.name, `
        <div class="card">
          <div class="ttl" style="color:var(--ok-text)">Телефон привязан</div>
          <div class="meta"><span>${h(phone || 'номер скрыт')}</span></div>
          <div class="acts">
            <a class="btn primary" href="/panel/?t=${h(t.slug)}">Открыть салон</a>
            <button class="btn danger" hx-post="/panel/salons/${t.id}/unlink"
              hx-confirm="Отвязать телефон? Бот перестанет отвечать в этом салоне."
              hx-on::after-request="location.reload()">Отвязать</button>
          </div>
        </div>`));
    }

    let qr = '';
    try {
      if (status === 'SCAN_QR_CODE') qr = await qrDataUri(t.wa_session);
    } catch (e) {
      log.warn('QR недоступен', { slug: t.slug, err: e.message });
    }

    res.send(shell(`${t.name} — привязка`, `
      ${qr
        ? `<div class="card" style="text-align:center"><img src="${qr}" alt="QR-код для привязки" style="width:min(72vw,320px);background:#fff;padding:14px;border-radius:16px"></div>`
        : `<div class="note">Готовлю код… состояние: ${h(status)}</div>`}
      <div class="note">
        Откройте WhatsApp на телефоне салона:<br>
        Настройки → Связанные устройства → Привязка устройства.<br><br>
        <b>Телефон должен быть отдельный, не личный номер владелицы.</b>
        Протокол неофициальный, номер могут заблокировать — вместе с ним
        уедет вся личная переписка.<br><br>
        Код действует недолго: держите телефон наготове, страница обновится сама.
      </div>
      <meta http-equiv="refresh" content="20">`));
  });

  s.post('/salons/:id/unlink', async (req, res) => {
    const t = await getTenant(Number(req.params.id));
    if (t) await deleteSession(t.wa_session);
    res.send('');
  });

  s.get('/salons/:id/sheets', async (req, res) => {
    const t = await getTenant(Number(req.params.id));
    if (!t) return res.status(404).send('Салон не найден');
    const st = await withTenant(t.id, async (c) => {
      const { rows } = await c.query(`SELECT sheet_id FROM settings LIMIT 1`);
      return rows[0] || {};
    }, 'system').catch(() => ({}));

    res.send(shell(`${t.name} — Таблицы`, `
      <form class="form" style="padding-top:20px" hx-post="/panel/salons/${t.id}/sheets" hx-target="#r" hx-swap="innerHTML">
        <label>Ссылка на Google Таблицу
          <input name="url" placeholder="https://docs.google.com/spreadsheets/d/..."
                 value="${h(st.sheet_id || '')}"></label>
        <button class="btn primary block lg" type="submit">Подключить и выгрузить</button>
      </form>
      <div id="r"></div>
      <div class="note">
        <b>Как подключить.</b> Создайте таблицу, нажмите «Настройки доступа»
        и дайте права <b>редактора</b> вот этой почте:<br>
        <code>${h(cfg.sheets.email || 'сервисный аккаунт не настроен')}</code><br><br>
        Данные выгружаются <b>в одну сторону</b>: из базы в таблицу.
        Обратная синхронизация не делается сознательно — если разрешить
        править расписание в таблице, мимо базы пройдёт защита от двойной
        записи, и две клиентки сядут на одно время.<br><br>
        Сбой таблицы никогда не мешает записи: выгрузка идёт отдельно,
        уже после того как запись создана.
      </div>`));
  });

  s.post('/salons/:id/sheets', async (req, res) => {
    const t = await getTenant(Number(req.params.id));
    if (!t) return res.status(404).send('');
    const id = sheetIdFromUrl(req.body.url);
    if (!id) return res.send('<div class="msg-err">Не разобрал ссылку на таблицу</div>');

    try {
      const info = await testAccess(id);
      await withTenant(t.id, async (c) => {
        await c.query(`UPDATE settings SET sheet_id = $1`, [id]);
      }, `panel:${req.user?.email}`);
      const n = await exportBookings(t.id, id);
      res.send(`<div class="msg-ok">Готово. Таблица «${h(info.title)}», выгружено записей: ${n}.</div>`);
    } catch (e) {
      res.send(`<div class="msg-err">${h(e.message)}</div>`);
    }
  });

  s.get('/salons/:id/limits', async (req, res) => {
    const t = await getTenant(Number(req.params.id));
    if (!t) return res.status(404).send('Салон не найден');

    res.send(shell(`${t.name} — лимиты`, `
      <form class="form" style="padding-top:20px" hx-post="/panel/salons/${t.id}/limits" hx-target="#r" hx-swap="innerHTML">
        <label>Потолок расходов на ИИ в сутки, $
          <input type="number" name="llm" step="0.5" min="0" value="${t.llm_daily_limit_usd}"></label>
        <label>Не больше сообщений в час
          <input type="number" name="msgs" min="10" value="${t.msg_hourly_limit}"></label>
        <label>Состояние
          <select name="status">
            ${['trial', 'active', 'suspended', 'closed'].map((x) =>
              `<option value="${x}" ${t.status === x ? 'selected' : ''}>${
                { trial: 'пробный', active: 'работает', suspended: 'приостановлен', closed: 'закрыт' }[x]
              }</option>`).join('')}
          </select></label>
        <button class="btn primary block lg" type="submit">Сохранить</button>
      </form>
      <div id="r"></div>
      <div class="note">
        Потолок расходов — единственный тормоз: у DeepSeek нет ограничения
        частоты на своей стороне, и зациклившийся бот одного салона иначе
        съел бы месячный бюджет за ночь.
      </div>
      <div style="padding:24px 16px">
        <form hx-post="/panel/salons/${t.id}/delete" hx-target="#r"
              hx-confirm="Удалить салон «${h(t.name)}» вместе со всеми клиентками и записями? Это необратимо.">
          <input name="confirm" placeholder="Впишите ${h(t.slug)} для подтверждения"
                 style="min-height:48px;padding:0 14px;width:100%;border:1px solid var(--danger);
                        border-radius:12px;background:transparent;color:var(--ink);margin-bottom:10px">
          <button class="btn danger block lg">Удалить салон</button>
        </form>
      </div>`));
  });

  s.post('/salons/:id/limits', async (req, res) => {
    await asPlatformAdmin(async (c) => {
      await c.query(
        `UPDATE tenants SET llm_daily_limit_usd = $2, msg_hourly_limit = $3, status = $4 WHERE id = $1`,
        [Number(req.params.id), Number(req.body.llm) || 1, Number(req.body.msgs) || 200,
         String(req.body.status || 'active')]
      );
    }, 'изменение лимитов');
    invalidateTenantCache();
    res.send('<div class="msg-ok">Сохранено</div>');
  });

  s.post('/salons/:id/delete', async (req, res) => {
    try {
      const t = await getTenant(Number(req.params.id));
      if (!t) return res.send('<div class="msg-err">Салон не найден</div>');
      await deleteSession(t.wa_session);
      await deleteTenant(t.id, String(req.body.confirm || '').trim());
      res.set('HX-Redirect', '/panel/salons').send('');
    } catch (e) {
      res.send(`<div class="msg-err">${h(e.message)}</div>`);
    }
  });

  async function getTenant(id) {
    return asPlatformAdmin(async (c) => {
      const { rows } = await c.query(`SELECT * FROM tenants WHERE id = $1`, [id]);
      return rows[0] || null;
    }, 'чтение салона');
  }

  r.use('/', s);
}
