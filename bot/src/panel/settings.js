import express from 'express';
import { q, one, tx } from '../db.js';
import { page, h, empty, money, plural } from './layout.js';
import { log } from '../log.js';

const WEEKDAYS = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
const DAYS_SHORT = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

const shell = (title, body, back = '/panel/settings', dev = process.env.PANEL_DEV_AUTH === '1') =>
  page({ title, body, active: 'set', back, dev });

export function mountSettings(r) {
  const s = express.Router();
  s.use(express.urlencoded({ extended: false }));

  s.get('/', async (_req, res) => {
    const [svc, m, st] = await Promise.all([
      one(`SELECT count(*)::int n FROM services WHERE active`),
      one(`SELECT count(*)::int n FROM masters WHERE active`),
      one(`SELECT * FROM settings WHERE id`),
    ]);
    res.send(shell('Настройки', `
      <div class="menu">
        <a href="/panel/settings/services"><span class="ico">💅</span>
          <span class="tx"><b>Услуги и цены</b><span>что делаем и за сколько</span></span>
          <span class="val">${svc.n} ${plural(svc.n, "услуга", "услуги", "услуг")}</span><span class="chev">›</span></a>
        <a href="/panel/settings/masters"><span class="ico">👩</span>
          <span class="tx"><b>Мастера</b><span>кто работает</span></span>
          <span class="val">${m.n} ${plural(m.n, "мастер", "мастера", "мастеров")}</span><span class="chev">›</span></a>
        <a href="/panel/settings/schedule"><span class="ico">🕘</span>
          <span class="tx"><b>График работы</b><span>постоянное расписание на неделю</span></span>
          <span class="chev">›</span></a>
        <a href="/panel/settings/days"><span class="ico">🏖</span>
          <span class="tx"><b>Выходные и отпуска</b><span>разовые нерабочие дни</span></span>
          <span class="chev">›</span></a>
        <a href="/panel/settings/voice"><span class="ico">💬</span>
          <span class="tx"><b>Как бот разговаривает</b><span>имя, тон, ваши правила</span></span>
          <span class="val">${h(st.bot_name || 'Алина')}</span><span class="chev">›</span></a>
        <a href="/panel/settings/salon"><span class="ico">⚙️</span>
          <span class="tx"><b>Салон и бот</b><span>сроки, перерывы, тихие часы</span></span>
          <span class="val">${st.bot_enabled ? 'бот включён' : 'ВЫКЛЮЧЕН'}</span><span class="chev">›</span></a>
      </div>
      <div class="note">Всё, что вы поменяете здесь, бот начнёт говорить клиенткам сразу же.</div>`, ''));
  });

  s.get('/services', async (_req, res) => {
    const rows = await q(`SELECT * FROM services ORDER BY sort_order, id`);
    const items = rows.map((x) => `
      <form class="card ${x.active ? '' : 'off'}"
            hx-post="/panel/settings/services/${x.id}" hx-swap="none">
        <div class="card-title">${h(x.name)}</div>
        <div class="row2">
          <label>Цена, ₸<input type="number" inputmode="numeric" name="price" value="${x.price_kzt}" min="0" step="500"></label>
          <label>Время, мин<input type="number" inputmode="numeric" name="duration" value="${x.duration_min}" min="5" step="5"></label>
        </div>
        <div class="check">
          <label class="check"><input type="checkbox" name="active" value="1" ${x.active ? 'checked' : ''}> показывать</label>
          <button class="btn primary">Сохранить</button>
          <span class="msg-ok" id="s${x.id}" role="status"></span>
        </div>
      </form>`).join('');

    res.send(shell('Услуги и цены', items + `
      <div class="note">
        Снимите галочку «показывать» — и бот перестанет предлагать услугу,
        а уже назначенные записи останутся.<br><br>
        Новые услуги пока добавляет разработчик: к каждой нужны ещё синонимы,
        по которым клиентки её называют («шеллак», «покрытие»), иначе бот
        не поймёт с первого раза.
      </div>`, '/panel/settings'));
  });

  s.post('/services/:id', async (req, res) => {
    const id = Number(req.params.id);
    await q(
      `UPDATE services SET price_kzt = $2, duration_min = $3, active = $4 WHERE id = $1`,
      [id, Number(req.body.price) || 0, Number(req.body.duration) || 30, req.body.active === '1']
    );
    log.info('услуга изменена из панели', { id, by: req.user?.email });
    res.set('HX-Trigger', 'saved').send('');
  });

  s.get('/masters', async (_req, res) => {
    const rows = await q(`SELECT * FROM masters ORDER BY id`);
    const items = rows.map((x) => `
      <form class="card ${x.active ? '' : 'off'}"
            hx-post="/panel/settings/masters/${x.id}" hx-swap="none">
        <div class="row2">
          <label>Имя<input type="text" name="name" value="${h(x.name)}" required></label>
          <label>Цвет<input type="color" name="color" value="${h(x.color)}" ></label>
        </div>
        <div class="check">
          <label class="check"><input type="checkbox" name="active" value="1" ${x.active ? 'checked' : ''}> работает</label>
          <button class="btn primary">Сохранить</button>
        </div>
      </form>`).join('');

    res.send(shell('Мастера', items + `
      <form class="card" hx-post="/panel/settings/masters/new" hx-swap="none"
            hx-on::after-request="location.reload()">
        <div class="card-title">Добавить мастера</div>
        <label>Имя<input type="text" name="name" required placeholder="Имя нового мастера"></label>
        <button class="btn primary">Добавить</button>
      </form>
      <div class="note">
        Если мастер больше не работает — снимите галочку «работает». Удалить её нельзя: пропадёт история записей. После этого откройте экран «Сегодня» и перенесите её будущие записи другим мастерам.
      </div>`, '/panel/settings'));
  });

  s.post('/masters/new', async (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 60);
    if (!name) return res.status(400).send('Пустое имя');
    await tx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO masters (name) VALUES ($1) RETURNING id`, [name]);

      await c.query(
        `INSERT INTO master_services (master_id, service_id)
         SELECT $1, id FROM services WHERE active`, [rows[0].id]);

      await c.query(
        `INSERT INTO shifts (master_id, weekday, starts_time, ends_time)
         SELECT $1, d, '10:00'::time, '20:00'::time FROM generate_series(1,6) d`,
        [rows[0].id]);
    }, `panel:${req.user?.email}`);
    res.send('');
  });

  s.post('/masters/:id', async (req, res) => {
    await q(`UPDATE masters SET name = $2, color = $3, active = $4 WHERE id = $1`, [
      Number(req.params.id),
      String(req.body.name || '').trim().slice(0, 60),
      String(req.body.color || '#c084fc'),
      req.body.active === '1',
    ]);
    res.set('HX-Trigger', 'saved').send('');
  });

  s.get('/schedule', async (_req, res) => {
    const masters = await q(`SELECT id, name FROM masters WHERE active ORDER BY id`);
    const shifts = await q(`SELECT * FROM shifts ORDER BY master_id, weekday`);

    const blocks = masters.map((m) => {
      const rows = [1, 2, 3, 4, 5, 6, 0].map((wd) => {
        const sh = shifts.find((x) => x.master_id === m.id && x.weekday === wd);
        return `
        <div class="row3">
          <label>${DAYS_SHORT[wd]}
            <input type="time" name="from_${wd}" value="${sh ? String(sh.starts_time).slice(0, 5) : ''}"></label>
          <label>до
            <input type="time" name="to_${wd}" value="${sh ? String(sh.ends_time).slice(0, 5) : ''}"></label>
          <label class="check">
            <input type="checkbox" name="off_${wd}" value="1" ${sh ? '' : 'checked'}> выходной</label>
        </div>`;
      }).join('');

      return `
      <form class="card" hx-post="/panel/settings/schedule/${m.id}" hx-swap="none">
        <div class="card-title">${h(m.name)}</div>
        ${rows}
        <button class="btn primary">Сохранить график</button>
      </form>`;
    }).join('');

    res.send(shell('График работы', blocks + `
      <div class="note">
        Это постоянный недельный график. Отпуск, больничный или разовый выходной добавляйте на экране <a href="/panel/settings/days">«Выходные и отпуска»</a>. Обеденные перерывы пока настраивает разработчик.<br><br>
        Бот никогда не предложит время вне этого графика, даже если очень попросят.
      </div>`, '/panel/settings'));
  });

  s.post('/schedule/:id', async (req, res) => {
    const masterId = Number(req.params.id);
    await tx(async (c) => {
      await c.query(`DELETE FROM shifts WHERE master_id = $1`, [masterId]);
      for (const wd of [0, 1, 2, 3, 4, 5, 6]) {
        if (req.body[`off_${wd}`] === '1') continue;
        const from = req.body[`from_${wd}`];
        const to = req.body[`to_${wd}`];
        if (!from || !to || from >= to) continue;
        await c.query(
          `INSERT INTO shifts (master_id, weekday, starts_time, ends_time)
           VALUES ($1, $2, $3::time, $4::time)`,
          [masterId, wd, from, to]
        );
      }
    }, `panel:${req.user?.email}`);
    log.info('график изменён из панели', { masterId, by: req.user?.email });
    res.set('HX-Trigger', 'saved').send('');
  });

  s.get('/salon', async (_req, res) => {
    const st = await one(`SELECT * FROM settings WHERE id`);
    res.send(shell('Салон и бот', `
      <form class="card" hx-post="/panel/settings/salon" hx-swap="none">
        <label>Название студии<input type="text" name="salon_name" value="${h(st.salon_name)}"></label>
        <label>Адрес<input type="text" name="address" value="${h(st.address)}"></label>

        <div class="card-title">Правила записи</div>
        <div class="row2">
          <label>Не раньше чем через, мин
            <input type="number" inputmode="numeric" name="min_lead" value="${st.min_lead_minutes}" min="0" step="15"></label>
          <label>Не дальше чем на, дней
            <input type="number" inputmode="numeric" name="horizon" value="${st.booking_horizon_days}" min="1" max="365"></label>
        </div>
        <div class="row2">
          <label>Перерыв между клиентками, мин
            <input type="number" inputmode="numeric" name="buffer" value="${st.default_buffer_min}" min="0" step="5"></label>
          <label>Отмена не позже чем за, часов
            <input type="number" inputmode="numeric" name="cancel_h" value="${st.cancel_deadline_hours}" min="0"></label>
        </div>

        <div class="card-title">Тихие часы</div>
        <div class="row2">
          <label>с<input type="time" name="quiet_from" value="${String(st.quiet_from).slice(0, 5)}"></label>
          <label>до<input type="time" name="quiet_to" value="${String(st.quiet_to).slice(0, 5)}"></label>
        </div>

        <div class="check">
          <label class="check"><input type="checkbox" name="bot_enabled" value="1"
            ${st.bot_enabled ? 'checked' : ''}> <b>Бот отвечает клиенткам</b></label>
        </div>

        <button class="btn primary">Сохранить</button>
      </form>
      <div class="note">
        <b>Не раньше чем через</b> — чтобы никто не записался «через десять минут»,
        когда мастер не успеет подготовиться.<br><br>
        <b>Тихие часы</b> — в это время бот не шлёт напоминания. На входящие
        сообщения он отвечает круглосуточно.<br><br>
        <b>Галочка «Бот отвечает»</b> — главный рубильник. Снимете — бот сразу
        замолчит во всех чатах, а сообщения клиенток продолжат приходить вам
        в WhatsApp как обычно.
      </div>`, '/panel/settings'));
  });

  s.post('/salon', async (req, res) => {
    await q(
      `UPDATE settings SET
         salon_name = $1, address = $2,
         min_lead_minutes = $3, booking_horizon_days = $4,
         default_buffer_min = $5, cancel_deadline_hours = $6,
         quiet_from = $7::time, quiet_to = $8::time,
         bot_enabled = $9
       WHERE id`,
      [
        String(req.body.salon_name || '').slice(0, 100),
        String(req.body.address || '').slice(0, 200),
        Number(req.body.min_lead) || 0,
        Number(req.body.horizon) || 60,
        Number(req.body.buffer) || 0,
        Number(req.body.cancel_h) || 0,
        req.body.quiet_from || '21:00',
        req.body.quiet_to || '09:00',
        req.body.bot_enabled === '1',
      ]
    );
    log.info('настройки салона изменены', { by: req.user?.email });
    res.set('HX-Trigger', 'saved').send('');
  });

  s.get('/voice', async (_req, res) => {
    const st = await one(`SELECT * FROM settings LIMIT 1`);
    res.send(shell('Как бот разговаривает', `
      <form class="card" hx-post="/panel/settings/voice" hx-swap="none">
        <div class="row2">
          <label>Имя бота<input name="bot_name" value="${h(st.bot_name)}" maxlength="30"></label>
          <label>Имя администратора<input name="owner_name" value="${h(st.owner_name)}"
            placeholder="Кто отвечает лично"></label>
        </div>
        <label>Телефон администратора
          <input name="owner_phone" value="${h(st.owner_phone)}" placeholder="+7 ..."></label>

        <div class="field">
          <label for="price_policy_text">Ответ на просьбу о скидке</label>
          <textarea id="price_policy_text" name="price_policy_text" rows="3">${h(st.price_policy_text)}</textarea>
        </div>

        <div class="field">
          <label for="payment_note">Как и когда платить</label>
          <textarea id="payment_note" name="payment_note" rows="2">${h(st.payment_note)}</textarea>
        </div>

        <div class="field">
          <label for="extra_rules">Ваши правила для бота</label>
          <textarea id="extra_rules" name="extra_rules" rows="6" placeholder="Например: у нас нельзя с детьми до 12 лет. Парковка во дворе, въезд с улицы Абая.">${h(st.extra_rules)}</textarea>
        </div>

        <button class="btn primary">Сохранить</button>
      </form>
      <div class="note">
        <b>Ваши правила</b> — то, чего бот знать не может: парковка, лифт, можно ли
        с детьми, есть ли где подождать. Пишите обычными фразами, по одной на строку.<br><br>
        <b>Что сюда писать НЕ надо:</b> цены и услуги — они берутся из прайса,
        а не отсюда. Если написать цену здесь, бот всё равно назовёт ту, что в прайсе:
        числа проверяются по базе.<br><br>
        <b>Ответ про скидку</b> бот произносит дословно. Своих формулировок про скидки
        он придумывать не может — это запрещено на уровне кода, чтобы он не пообещал
        клиентке то, чего вы не давали.<br><br>
        Проверить, как звучит, можно в <a href="/panel/console">Консоли</a> — там бот
        отвечает по-настоящему, но в WhatsApp ничего не уходит.
      </div>`, '/panel/settings'));
  });

  s.post('/voice', async (req, res) => {
    await q(
      `UPDATE settings SET bot_name = $1, owner_name = $2, owner_phone = $3,
              price_policy_text = $4, payment_note = $5, extra_rules = $6`,
      [
        String(req.body.bot_name || 'Алина').slice(0, 30),
        String(req.body.owner_name || '').slice(0, 60),
        String(req.body.owner_phone || '').slice(0, 30),
        String(req.body.price_policy_text || '').slice(0, 500),
        String(req.body.payment_note || '').slice(0, 300),
        String(req.body.extra_rules || '').slice(0, 2000),
      ]
    );
    log.info('изменён тон бота', { by: req.user?.email });
    res.set('HX-Trigger', 'saved').send('');
  });

  s.get('/days', async (_req, res) => {
    const [masters, rows] = await Promise.all([
      q(`SELECT id, name FROM masters WHERE active ORDER BY id`),
      q(`SELECT e.id, e.master_id, e.kind, e.reason, e.span,
                lower(e.span) AS starts, upper(e.span) AS ends, m.name AS master
           FROM schedule_exceptions e
           LEFT JOIN masters m ON m.id = e.master_id
          WHERE upper(e.span) > now()
            AND NOT (e.reason = 'обед')
          ORDER BY lower(e.span) LIMIT 60`),
    ]);

    const fmt = (ts) => new Date(ts).toLocaleDateString('ru-RU',
      { day: 'numeric', month: 'long', timeZone: 'Asia/Almaty' });

    const list = rows.length ? rows.map((x) => `
      <div class="card split">
        <div>
          <div class="ttl">${h(x.master || 'Вся студия')}</div>
          <div class="sub">
            ${h(fmt(x.starts))}${fmt(x.starts) !== fmt(x.ends) ? ' — ' + h(fmt(x.ends)) : ''}
            ${x.reason ? ' · ' + h(x.reason) : ''}
          </div>
        </div>
        <button class="btn ghost"
          aria-label="Убрать: ${h(fmt(x.starts))}${x.reason ? ', ' + h(x.reason) : ''}"
          hx-post="/panel/settings/days/${x.id}/delete"
          hx-on::after-request="location.reload()">Убрать</button>
      </div>`).join('')
      : '<div class="note">Ближайших выходных и отпусков не запланировано</div>';

    res.send(shell('Выходные и отпуска', `
      ${list}
      <form class="card" hx-post="/panel/settings/days" hx-swap="none"
            hx-on::after-request="location.reload()">
        <div class="card-title">Добавить нерабочие дни</div>
        <label>Кто<select name="master_id">
          <option value="">Вся студия (праздник, ремонт)</option>
          ${masters.map((m) => `<option value="${m.id}">${h(m.name)}</option>`).join('')}
        </select></label>
        <div class="row2">
          <label>С<input type="date" name="from" required></label>
          <label>По<input type="date" name="to" required></label>
        </div>
        <label>Причина
          <input name="reason" placeholder="отпуск, больничный, праздник"></label>
        <button class="btn primary">Добавить</button>
      </form>
      <div class="note">
        Бот перестанет предлагать это время сразу же и будет честно говорить
        «мы в этот день не работаем», а не «всё занято». Это важная разница:
        после первого клиентка приходит в другой день, после второго может уйти.<br><br>
        <b>Уже созданные записи на эти дни НЕ отменяются автоматически</b> —
        посмотрите их на экране «Сегодня» и решите сами, кого перенести.
        Автоматическая отмена чужих записей слишком опасна, чтобы делать её без вас.
      </div>`, '/panel/settings'));
  });

  s.post('/days', async (req, res) => {
    const from = req.body.from;
    const to = req.body.to;
    if (!from || !to || to < from) return res.status(400).send('Неверные даты');
    await q(
      `INSERT INTO schedule_exceptions (master_id, kind, span, reason)
       VALUES ($1, 'off',
               tstzrange(($2::date)::timestamp AT TIME ZONE 'Asia/Almaty',
                         (($3::date) + 1)::timestamp AT TIME ZONE 'Asia/Almaty', '[)'),
               $4)`,
      [req.body.master_id ? Number(req.body.master_id) : null, from, to,
       String(req.body.reason || '').slice(0, 100)]
    );
    log.info('добавлены нерабочие дни', { from, to, by: req.user?.email });
    res.send('');
  });

  s.post('/days/:id/delete', async (req, res) => {
    await q(`DELETE FROM schedule_exceptions WHERE id = $1`, [Number(req.params.id)]);
    res.send('');
  });

  r.use('/settings', s);
}
