import express from 'express';
import { q, one, tx } from '../db.js';
import { cfg } from '../config.js';
import { page as shellPage, h, empty, money as fmtMoney, plural } from './layout.js';
import { log } from '../log.js';
import { handleTurn } from '../agent.js';

const isDev = (req) => req.user?.role === 'dev' || process.env.PANEL_DEV_AUTH === '1';

const money = (v) => `${Number(v || 0).toLocaleString('ru-RU')} ₸`;

const page = (title, body, tab, dev) => shellPage({ title, body, active: tab, dev });
const dt = (ts) => new Date(ts).toLocaleString('ru-RU', {
  day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: cfg.tz,
});
const maskPhoneUi = (p) => {
  const s = String(p || '');
  return s.length < 6 ? 'Без номера' : `${s.slice(0, 2)} ••• ••• ${s.slice(-4)}`;
};

export function mountStudio(r) {
  const s = express.Router();
  s.use(express.urlencoded({ extended: false }));

  s.get('/chats', async (req, res) => {
    const rows = await q(`
      WITH last AS (
        SELECT DISTINCT ON (client_id)
               client_id, role, content, at
          FROM messages
         ORDER BY client_id, at DESC
      )
      SELECT c.id, c.name, c.phone_e164, c.primary_jid,
             c.bot_paused_until,
             l.role AS last_role, l.content AS last_text, l.at AS last_at,
             (SELECT count(*) FROM messages m WHERE m.client_id = c.id) AS msgs,
             (SELECT count(*) FROM appointments a
               WHERE a.client_id = c.id AND a.status IN ('confirmed','done')) AS bookings
        FROM clients c
        JOIN last l ON l.client_id = c.id
       ORDER BY l.at DESC
       LIMIT 60`);

    const list = rows.length === 0
      ? empty('chat','Пока ни одного диалога','Как только клиентка напишет боту, диалог появится здесь')
      : rows.map((c) => {

        const unanswered = c.last_role === 'user';
        const paused = c.bot_paused_until && new Date(c.bot_paused_until) > new Date();
        return `
        <a class="conv" href="/panel/chats/${c.id}">
          <div class="hd">
            <span class="who">${h(c.name || maskPhoneUi(c.phone_e164))}
              ${unanswered ? '<span class="tag no">без ответа</span>' : ''}
              ${paused ? '<span class="tag hu">ждёт вашего ответа</span>' : ''}
              ${c.bookings > 0 ? '<span class="tag ok">записана</span>' : ''}
            </span>
            <span class="when">${h(dt(c.last_at))}</span>
          </div>
          <div class="last">${c.last_role === 'assistant' ? 'Бот: ' : ''}${h(String(c.last_text).slice(0, 90))}</div>
        </a>`;
      }).join('');

    res.send(page('Чаты', `<div class="card flush">${list}</div>`, 'chats', isDev(req)));
  });

  s.get('/chats/:id', async (req, res) => {
    const id = Number(req.params.id);
    const client = await one(`SELECT * FROM clients WHERE id = $1`, [id]);
    if (!client) return res.status(404).send('Не найдено');

    const msgs = await q(
      `SELECT role, content, at FROM messages WHERE client_id = $1 ORDER BY at LIMIT 200`, [id]);
    const appts = await q(
      `SELECT a.starts_at, a.price_kzt, a.status, m.name AS master
         FROM appointments a JOIN masters m ON m.id = a.master_id
        WHERE a.client_id = $1 ORDER BY a.starts_at DESC LIMIT 5`, [id]);

    const thread = msgs.map((m) => `
      <div class="bubble ${m.role === 'user' ? 'u' : 'a'}">${h(m.content)}
        <div class="t">${h(dt(m.at))}</div></div>`).join('');

    const apptBlock = appts.length ? `
      <div class="card"><b>Записи</b>
        <div class="tbl-wrap"><table class="d">${appts.map((a) => `
          <tr><td>${h(dt(a.starts_at))}</td><td>${h(a.master)}</td>
              <td>${h(money(a.price_kzt))}</td><td>${h({pending:'ожидает',confirmed:'подтверждена',done:'состоялась',cancelled:'отменена',no_show:'не пришла'}[a.status] || a.status)}</td></tr>`).join('')}
        </table></div></div>` : '';

    res.send(page(client.name || maskPhoneUi(client.phone_e164), `
      <div class="card" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <span>${h(maskPhoneUi(client.phone_e164))}</span>
        <span style="color:var(--muted)">визитов: ${client.visits_count}</span>
        ${client.no_show_count > 0 ? `<span class="tag no">не пришла ${client.no_show_count} раз</span>` : ''}
      </div>
      ${apptBlock}
      <div class="thread">${thread || empty('chat','Сообщений нет')}</div>
      <div style="height:20px"></div>`, 'chats', isDev(req)));
  });

  s.get('/stats', async (req, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));

    const [conv, rev, ans, top] = await Promise.all([
      one(`
        SELECT
          count(DISTINCT c.id)::int AS всего,
          count(DISTINCT a.client_id)::int AS записались
        FROM clients c
        LEFT JOIN appointments a ON a.client_id = c.id
             AND a.status IN ('confirmed','done')
             AND a.created_at > now() - make_interval(days => $1)
        WHERE c.first_seen_at > now() - make_interval(days => $1)`, [days]),
      one(`
        SELECT
          COALESCE(sum(price_kzt) FILTER (WHERE status = 'done'), 0)::int AS получено,
          COALESCE(sum(price_kzt) FILTER (WHERE status = 'confirmed'), 0)::int AS ожидается,
          COALESCE(sum(price_kzt) FILTER (WHERE status IN ('cancelled','no_show')), 0)::int AS потеряно,
          count(*) FILTER (WHERE status = 'no_show')::int AS неявки
        FROM appointments
        WHERE starts_at > now() - make_interval(days => $1)`, [days]),
      one(`
        WITH last AS (
          SELECT DISTINCT ON (client_id) client_id, role
            FROM messages WHERE at > now() - make_interval(days => $1)
           ORDER BY client_id, at DESC
        )
        SELECT count(*) FILTER (WHERE role = 'assistant')::int AS отвечено,
               count(*) FILTER (WHERE role = 'user')::int AS без_ответа
          FROM last`, [days]),
      q(`SELECT s.name, count(*)::int AS n
           FROM appointments a
           JOIN appointment_services x ON x.appointment_id = a.id
           JOIN services s ON s.id = x.service_id
          WHERE a.starts_at > now() - make_interval(days => $1)
            AND a.status IN ('confirmed','done')
          GROUP BY s.name ORDER BY n DESC LIMIT 5`, [days]),
    ]);

    const pct = conv.всего ? Math.round((conv.записались / conv.всего) * 100) : 0;

    res.send(page(`Статистика за ${days} ${plural(days, 'день', 'дня', 'дней')}`, `
      <div class="kpi">
        <div class="c"><div class="v">${pct}%</div><div class="l">дошли до записи</div>
          <div class="s">${conv.записались} из ${conv.всего} написавших</div></div>
        <div class="c"><div class="v">${ans.отвечено ?? 0}</div><div class="l">${plural(ans.отвечено ?? 0, 'диалог с ботом', 'диалога с ботом', 'диалогов с ботом')}</div>
          <div class="s">без ответа: ${ans.без_ответа ?? 0}</div></div>
        <div class="c"><div class="v">${money(rev.получено)}</div><div class="l">заработано</div>
          <div class="s">ожидается ${money(rev.ожидается)}</div></div>
        <div class="c"><div class="v">${money(rev.потеряно)}</div><div class="l">потеряно</div>
          <div class="s">неявок: ${rev.неявки}</div></div>
      </div>
      ${top.length ? `<div class="card"><div class="card-title">Что заказывают чаще</div>
        <div class="tbl-wrap"><table class="d">${top.map((t) => `
          <tr><td>${h(t.name)}</td><td class="num">${t.n}</td></tr>`).join('')}</table></div>
      </div>` : empty('chart', 'Пока нет данных', 'появятся после первых записей')}
      <div class="note">
        «Без ответа» — диалоги, где последнее слово осталось за клиенткой.
        Это либо бот промолчал, либо ждёт вашего ответа после передачи человеку.
      </div>`, 'stats', isDev(req)));
  });

  s.get('/console', async (req, res) => {
    if (!isDev(req)) return res.status(403).send('Только для разработчика');
    const tester = await ensureTester();
    const msgs = await q(
      `SELECT role, content, at FROM messages WHERE client_id = $1 ORDER BY at LIMIT 100`,
      [tester.id]);

    res.send(page('Тестовая консоль', `
      <div class="note">
        Пишите как клиентка. Бот отвечает по-настоящему, с базой и моделью,
        но в WhatsApp ничего не уходит.
      </div>
      <div class="thread" id="thread" aria-live="polite">
        ${msgs.map((m) => `<div class="bubble ${m.role === 'user' ? 'u' : 'a'}">${h(m.content)}</div>`).join('')
          || empty('beaker','Напишите первое сообщение','Бот ответит по-настоящему, но в WhatsApp ничего не уйдёт')}
      </div>
      <form class="composer" hx-post="/panel/console/send" hx-target="#thread"
            hx-swap="beforeend" hx-on::after-request="this.reset()">
        <input name="text" placeholder="Сообщение от клиентки" required autocomplete="off">
        <button class="btn primary">Отправить</button>
      </form>
      <form class="composer" hx-post="/panel/console/reset" hx-target="#thread" hx-swap="innerHTML" hx-confirm="Стереть весь тестовый диалог?">
        <button class="btn ghost">Очистить диалог</button>
      </form>`, 'con', true));
  });

  s.post('/console/send', async (req, res) => {
    if (!isDev(req)) return res.status(403).send('');
    const text = String(req.body.text || '').trim();
    if (!text) return res.send('');

    const tester = await ensureTester();
    const started = Date.now();
    let out;
    try {
      out = await handleTurn({
        clientId: tester.id,
        chatId: tester.primary_jid,
        clientName: tester.name,
        userText: text,
        clientRow: tester,
      });
    } catch (e) {
      log.error('ошибка тестовой консоли', { err: e.message });
      out = { text: `[ошибка] ${e.message}`, degraded: 'exception' };
    }

    const ms = Date.now() - started;
    res.send(
      `<div class="bubble u">${h(text)}</div>` +
      `<div class="bubble a">${h(out.text || '(пусто)')}</div>` +
      `<div class="sysline">${ms} мс${out.degraded ? ` · деградация: ${h(out.degraded)}` : ''}` +
      `${out.escalated ? ' · позван человек' : ''}</div>`
    );
  });

  s.post('/console/reset', async (req, res) => {
    if (!isDev(req)) return res.status(403).send('');
    const tester = await ensureTester();
    await tx(async (c) => {
      await c.query(`DELETE FROM messages WHERE client_id = $1`, [tester.id]);
      await c.query(
        `UPDATE appointments SET status = 'cancelled' WHERE client_id = $1 AND status IN ('pending','confirmed')`,
        [tester.id]);
      await c.query(`UPDATE clients SET bot_paused_until = NULL WHERE id = $1`, [tester.id]);
    }, 'console');
    res.send('<div class="empty">Диалог очищен</div>');
  });

  async function ensureTester() {
    const jid = 'console-tester@internal';
    let t = await one(`SELECT * FROM clients WHERE primary_jid = $1`, [jid]);
    if (!t) {
      await q(`SELECT upsert_client(NULL, $1, $2)`, [jid, 'Тестовая клиентка']);
      t = await one(`SELECT * FROM clients WHERE primary_jid = $1`, [jid]);
    }
    return t;
  }

  s.get('/ops', async (req, res) => {
    if (!isDev(req)) return res.status(403).send('Только для разработчика');

    const WA_RU = {
      WORKING: 'работает', SCAN_QR_CODE: 'нужен QR', STARTING: 'запускается',
      FAILED: 'упала', STOPPED: 'остановлена',
    };
    let waStatus = 'недоступна';
    try {
      const r = await fetch(`${cfg.waha.url}/api/sessions/${cfg.waha.session}`,
        { headers: { 'X-Api-Key': cfg.waha.apiKey } });
      if (r.ok) { const st = (await r.json())?.status; waStatus = WA_RU[st] || st || '?'; }
    } catch {  }

    const [outb, inb, cl] = await Promise.all([
      one(`SELECT count(*) FILTER (WHERE sent_at IS NULL)::int AS в_очереди,
                  count(*) FILTER (WHERE sent_at IS NULL AND attempts >= 3)::int AS застряли,
                  count(*) FILTER (WHERE ack = -1)::int AS отвергнуто
             FROM outbox`),
      one(`SELECT count(*)::int AS n FROM inbox_buffer`),
      one(`SELECT count(*)::int AS n FROM clients WHERE primary_jid <> 'console-tester@internal'`),
    ]);

    res.send(page('Служебное', `
      <div class="kpi">
        <div class="c"><div class="v txt">${h(waStatus)}</div>
          <div class="l">сессия WhatsApp</div>
          ${waStatus !== 'работает' ? '<div class="s"><a href="/panel/qr">привязать телефон</a></div>' : ''}</div>
        <div class="c"><div class="v">${outb.в_очереди}</div><div class="l">исходящих в очереди</div>
          <div class="s">застряли: ${outb.застряли} · отклонено: ${outb.отвергнуто}</div></div>
        <div class="c"><div class="v">${inb.n}</div><div class="l">входящих в разборе</div></div>
        <div class="c"><div class="v">${cl.n}</div><div class="l">${plural(cl.n, "клиентка", "клиентки", "клиенток")} всего</div></div>
      </div>
      <div class="card"><b>Модель</b>
        <div class="tbl-wrap"><table class="d">
          <tr><td>провайдер</td><td>${h(cfg.llm.provider)}</td></tr>
          <tr><td>лимит раундов инструментов</td><td>${cfg.llm.maxToolRounds}</td></tr>
          <tr><td>часовой пояс</td><td>${h(cfg.tz)}</td></tr>
        </table></div>
      </div>`, 'ops', true));
  });

  r.use('/', s);
}
