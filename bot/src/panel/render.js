import { page, h, empty, money as fmtMoney, plural, cap } from './layout.js';

export { h };

function card(a, { hhmm, money, maskPhoneUi }) {
  const done = a.status === 'done';
  const noShow = a.status === 'no_show';
  const cls = done ? 'appt done' : noShow ? 'appt noshow' : 'appt';

  return `
<div class="${cls}" id="appt-${a.id}" style="--m:${h(a.color || '#a855f7')}">
  <div class="hd">
    <span class="time">${h(hhmm(a.starts_at))}</span>
    <span class="who">${h(a.client_name || 'Без имени')}</span>
    ${a.bot_paused ? '<span class="tag hu">бот молчит</span>' : ''}
  </div>
  <div class="meta">
    <span>${h(a.service)}</span>
    <span>${h(money(a.price_kzt))}</span>
  </div>
  ${a.comment ? `<div class="note-line">${h(a.comment)}</div>` : ''}

  ${done ? '<div class="state">✓ Пришла</div>'
    : noShow ? '<div class="state">✕ Не пришла</div>'
    : `<button class="btn primary block lg" style="margin-top:12px"
         hx-post="/panel/appt/${a.id}/status"
         hx-vals='{"status":"done"}'
         hx-target="#appt-${a.id}" hx-swap="outerHTML">Пришла</button>`}

  <details>
    <summary aria-label="Действия с записью">•••</summary>
    <div class="acts">
      <a class="btn" href="/panel/client/${a.client_id}/phone" target="_blank" rel="noopener">
        💬 WhatsApp · ${h(maskPhoneUi(a.phone_e164))}</a>
      ${!done && !noShow ? `
      <button class="btn"
        hx-post="/panel/appt/${a.id}/status" hx-vals='{"status":"no_show"}'
        hx-target="#appt-${a.id}" hx-swap="outerHTML"
        hx-confirm="Отметить, что клиентка не пришла?">Не пришла</button>` : ''}
      ${a.bot_paused
        ? `<button class="btn" hx-post="/panel/client/${a.client_id}/bot"
             hx-vals='{"action":"resume"}' hx-swap="none">Включить бота</button>`
        : `<button class="btn ghost" hx-post="/panel/client/${a.client_id}/bot"
             hx-vals='{"action":"pause","minutes":"120"}' hx-swap="none">Бот молчит 2 часа</button>`}
      ${!done && !noShow ? `
      <button class="btn danger"
        hx-post="/panel/appt/${a.id}/cancel" hx-vals='{"notify":"1"}'
        hx-confirm="Отменить запись? Клиентке уйдёт сообщение."
        hx-swap="none">Отменить запись</button>` : ''}
    </div>
  </details>
</div>`;
}

function day(d) {
  const strip = d.strip.map((s) => `
    <a href="/panel/?date=${h(s.iso)}${d.masterId ? `&master=${d.masterId}` : ''}"
       class="chip ${s.isActive ? 'on' : ''} ${s.isToday ? 'today' : ''}">
      <span class="wd">${h(s.wd)}</span><span class="dd">${h(s.day)}</span>
    </a>`).join('');

  const filters = [
    `<a href="/panel/?date=${h(d.date)}" class="pill ${!d.masterId ? 'on' : ''}">Все</a>`,
    ...d.masters.map((m) => `
      <a href="/panel/?date=${h(d.date)}&master=${m.id}"
         class="pill ${d.masterId === m.id ? 'on' : ''}" style="--m:${h(m.color)}">
        <span class="dot"></span>${h(m.name)}</a>`),
  ].join('');

  const groups = d.groups.length === 0
    ? empty('🗓', 'На этот день записей нет', 'Свободный день. Записать клиентку можно кнопкой ниже')
    : d.groups.map((g) => `
      <section class="mgroup" style="--m:${h(g.master.color)}">
        <h2>${h(g.master.master)}</h2>
        ${g.items.map((a) => card(a, d)).join('')}
      </section>`).join('');

  const body = `
    <div class="strip">${strip}</div>
    <div class="filters">${filters}</div>
    <main id="daylist"
          hx-get="/panel/?date=${h(d.date)}${d.masterId ? `&master=${d.masterId}` : ''}"
          hx-trigger="refreshDay from:body"
          hx-select="#daylist" hx-swap="outerHTML">
      ${groups}
    </main>
    <div class="cta-row">
      <a class="btn primary block lg" href="/panel/new?date=${h(d.date)}">+ Записать вручную</a>
    </div>`;

  return page({
    title: cap(d.title),
    sub: `${d.total} ${plural(d.total, 'запись', 'записи', 'записей')} · ${fmtMoney(d.revenue)}`,
    body, active: 'day', dev: d.dev, salon: d.salonName,
  });
}

function newAppt(d) {
  const body = `
  <form class="form"
        hx-post="/panel/new" hx-target="#formerr" hx-swap="innerHTML">
    <div class="card">
      <div class="row2">
        <div class="field"><label>Телефон</label>
          <input type="tel" name="phone" inputmode="tel" required placeholder="+7 701 234 56 78"></div>
        <div class="field"><label>Имя</label>
          <input type="text" name="name" placeholder="Как зовут"></div>
      </div>
    </div>

    <div class="card">
      <div class="field"><label>Услуга</label>
        <select name="service" required
                hx-get="/panel/new/slots" hx-target="#slots" hx-include="closest form" hx-trigger="change" hx-indicator="#slots">
          <option value="">— выберите —</option>
          ${d.services.map((s) => `<option value="${s.id}">${h(s.name)} · ${s.duration_min} мин</option>`).join('')}
        </select></div>
      <div class="row2" style="margin-top:16px">
        <div class="field"><label>Мастер</label>
          <select name="master" hx-get="/panel/new/slots" hx-target="#slots"
                  hx-include="closest form" hx-trigger="change" hx-indicator="#slots">
            <option value="">Любой</option>
            ${d.masters.map((m) => `<option value="${m.id}">${h(m.name)}</option>`).join('')}
          </select></div>
        <div class="field"><label>Дата</label>
          <input type="date" name="date" value="${h(d.date)}" required
                 hx-get="/panel/new/slots" hx-target="#slots"
                 hx-include="closest form" hx-trigger="change" hx-indicator="#slots"></div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Свободное время</div>
      <div id="slots" class="slots"><span style="color:var(--muted);font-size:14px">
        Сначала выберите услугу</span></div>
    </div>

    <div id="formerr" role="alert"></div>
    <button type="submit" class="btn primary block lg">Записать</button>
  </form>`;

  return page({
    title: 'Новая запись', body, active: 'day', dev: d.dev,
    back: `/panel/?date=${h(d.date)}`, salon: d.salonName,
  });
}

function slots(d) {
  if (!d.slots.length) {
    return '<span style="color:var(--muted);font-size:14px">Свободного времени нет. Попробуйте другой день.</span>';
  }
  return d.slots.slice(0, 40).map((s) => `
    <label class="slot">
      <input type="radio" name="starts_at" value="${h(s.starts_at)}" required
             onchange="this.closest('form').querySelector('[name=master]').value='${s.master_id}'">
      <b>${h(d.hhmm(s.starts_at))}</b>
      <small>${h(s.master_name)}</small>
    </label>`).join('');
}

const VIEWS = { day, new: newAppt, _card: (d) => card(d.a, d), _slots: slots };

export function render(view, data) {
  const fn = VIEWS[view];
  if (!fn) throw new Error(`Неизвестный шаблон: ${view}`);
  return fn(data);
}
