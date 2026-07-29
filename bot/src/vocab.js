import { one } from './db.js';

const cache = new Map();
const TTL_MS = 60_000;

const FALLBACK = {
  code: 'salon',
  shape: 'booking',
  res_one: 'мастер', res_gen: 'мастера', res_dat: 'мастеру',
  res_acc: 'мастера', res_many: 'мастера', res_female: true,
  svc_one: 'услуга', svc_gen: 'услуги', svc_acc: 'услугу', svc_many: 'услуги',
  appt_one: 'запись', appt_acc: 'запись', appt_many: 'записи',
  client_one: 'клиентка', client_many: 'клиентки', client_female: true,
  slot_step_min: 15, buffer_min: 10, min_lead_min: 90, horizon_days: 60,
  needs_resource: true, needs_address: false, allows_photos: true,
  prompt_extra: '',
};

export async function vocab(verticalCode) {
  const code = verticalCode || 'salon';
  const hit = cache.get(code);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v;

  const row = await one(`SELECT * FROM verticals WHERE code = $1`, [code])
    .catch(() => null);
  const v = row || FALLBACK;
  cache.set(code, { v, at: Date.now() });
  return v;
}

export function invalidateVocab() { cache.clear(); }

export function agree(v, verbFemale, verbMale) {
  return v.res_female ? verbFemale : verbMale;
}

export function vocabBlock(v) {
  const lines = [
    'СЛОВАРЬ ЭТОГО БИЗНЕСА — используй ИМЕННО эти слова, не заменяй своими:',
    `— тот, к кому записывают: ${v.res_one} (кого: ${v.res_acc}, к кому: ${v.res_dat}, чего нет: ${v.res_gen})`,
    `— то, на что записывают: ${v.svc_one} (что: ${v.svc_acc}, чего: ${v.svc_gen})`,
    `— сама запись: ${v.appt_one} (что: ${v.appt_acc})`,
  ];

  if (!v.res_female) {
    lines.push(`— «${v.res_one}» мужского рода: пиши «свободен», «освободится», а не «свободна».`);
  }
  if (!v.needs_resource) {
    lines.push(`— выбирать ${v.res_acc} не нужно, не спрашивай об этом.`);
  }
  if (!v.allows_photos) {
    lines.push('— фото здесь не обсуждаем и не оцениваем.');
  }
  if (v.prompt_extra) {
    lines.push('', v.prompt_extra);
  }

  return lines.join('\n');
}

export function labels(v) {
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  return {
    resourceOne: v.res_one,
    resourceMany: cap(v.res_many),
    serviceOne: v.svc_one,
    serviceMany: cap(v.svc_many),
    apptOne: v.appt_one,
    apptMany: cap(v.appt_many),
    clientOne: v.client_one,
    clientMany: cap(v.client_many),

    pickResource: `Выберите ${v.res_acc}`,
    anyResource: v.res_female ? 'Любая' : 'Любой',
    noSlots: `Свободного времени нет`,
    addResource: `Добавить ${v.res_acc}`,
    settingsServices: `${cap(v.svc_many)} и цены`,
  };
}
