import { extractAmounts, extractMoments } from './numbers.js';

export function extractPrices(text) {
  return extractAmounts(text);
}

export function extractTimes(text) {
  return extractMoments(text);
}

const PRICE_KEYS = /^(цена|стоимость|price|price_kzt|сумма|итого|total)$/i;
const TIME_KEYS = /^(время|starts_at|время_начала|когда)$/i;

export function collectAllowed(toolResults) {
  const prices = new Set();
  const times = new Set();

  const addTimeFromIso = (v) => {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) {
      times.add(d.toLocaleTimeString('ru-RU', {
        hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Almaty',
      }));
    }
  };

  const walk = (v, key = '') => {
    if (v == null) return;

    if (typeof v === 'number') {

      if (PRICE_KEYS.test(key)) prices.add(v);
      return;
    }

    if (typeof v === 'string') {
      if (PRICE_KEYS.test(key)) {
        for (const p of extractPrices(v)) prices.add(p);
      }
      if (TIME_KEYS.test(key) || /^\d{4}-\d{2}-\d{2}T/.test(v)) {
        for (const t of extractTimes(v)) times.add(t);
        if (/^\d{4}-\d{2}-\d{2}T/.test(v)) addTimeFromIso(v);
      }
      return;
    }

    if (Array.isArray(v)) { v.forEach((x) => walk(x, key)); return; }
    if (typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) walk(val, k);
    }
  };

  toolResults.forEach((r) => walk(r, ''));
  return { prices, times };
}

const PROMISE_RE = new RegExp(
  '(?:скидк|бесплатн|в подарок|подарим|бонус|акци|рассрочк|сертификат|' +
  'кешбэк|кэшбэк|компенсир|вернём деньги|вернем деньги|за наш счёт|за наш счет|' +
  'переделаем бесплатно|гаранти(?:я|ю|рую|руем|ровано))',
  'i'
);

const PAYMENT_RE = /(?:\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b|\bKZ\d{18}\b|\bIBAN\b)/i;

const INTERNAL_LEAK_RE = new RegExp(
  '(?:система (?:показывает|выдаёт|говорит|не даёт)|' +

  'find_slots|list_services|create_booking|my_bookings|cancel_booking|' +
  'reschedule_booking|add_service|escalate_to_human|' +
  'инструмент|функци[яию]\\s|апи\\b|api\\b|' +
  'слот[ыи]\\s+для\\s+отдельных|' +
  'в базе( данных)?|запрос(?:е|ом)? к|' +
  'не могу вызвать|ошибка \\d{3}|json|null|undefined)',
  'i'
);

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu;

export function limitEmoji(text, max = 1) {
  const found = String(text).match(EMOJI_RE);
  if (!found || found.length <= max) return String(text);
  let seen = 0;
  return String(text).replace(EMOJI_RE, (e) => (++seen <= max ? e : '')).replace(/ {2,}/g, ' ');
}

export function checkReply(text, toolResults = [], userText = '') {
  let out = limitEmoji(String(text || ''));

  if (!out.trim()) {
    return { ok: false, reason: 'empty', text: out };
  }

  const leak = out.match(INTERNAL_LEAK_RE);
  if (leak) {
    return { ok: false, reason: 'internal_leak', detail: leak[0], text: out };
  }

  const promise = out.match(PROMISE_RE);
  if (promise) {
    return { ok: false, reason: 'promise', detail: promise[0], text: out };
  }

  const pay = out.match(PAYMENT_RE);
  if (pay) {
    return { ok: false, reason: 'payment_details', detail: pay[0].slice(0, 8), text: out };
  }

  const allowed = collectAllowed(toolResults);

  const fromUser = { times: extractTimes(userText) };

  for (const p of extractPrices(out)) {
    if (allowed.prices.has(p)) continue;
    return {
      ok: false, reason: 'invented_price', detail: String(p), text: out,
    };
  }

  for (const t of extractTimes(out)) {
    if (allowed.times.has(t) || fromUser.times.has(t)) continue;
    return {
      ok: false, reason: 'invented_time', detail: t, text: out,
    };
  }

  return { ok: true, text: out };
}

export function correctionFor(check) {
  switch (check.reason) {
    case 'invented_price':
      return `Ты назвала цену ${check.detail}, которой нет в прайсе. ` +
             'Цены брать ТОЛЬКО из результата list_services. ' +
             'Вызови list_services и напиши ответ заново, с настоящими ценами.';
    case 'invented_time':
      return `Ты назвала время ${check.detail}, которого нет среди свободных. ` +
             'Время брать ТОЛЬКО из результата find_slots. ' +
             'Вызови find_slots на нужную дату и предложи реальные варианты.';
    case 'internal_leak':
      return `Из ответа убери упоминание внутренней кухни («${check.detail}»). ` +
             'Клиентка не должна знать про систему, инструменты и слоты. ' +
             'Напиши по-человечески, как администратор.';
    case 'promise':
      return `Ты пообещала «${check.detail}». Скидки, подарки и гарантии даёт ` +
             'только владелица — ты такого права не имеешь. Перепиши ответ без обещаний, ' +
             'а если клиентка настаивает — вызови escalate_to_human.';
    case 'payment_details':
      return 'В ответе оказались платёжные реквизиты. Их отправлять нельзя никогда: ' +
             'от имени салонов постоянно пишут мошенники. Про оплату скажи словами, ' +
             'без номеров карт и счетов.';
    case 'empty':
      return 'Ответ пустой. Напиши клиентке по существу.';
    default:
      return 'Перепиши ответ.';
  }
}
