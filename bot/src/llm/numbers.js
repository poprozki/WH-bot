const UNITS = {
  ноль: 0, один: 1, одна: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5,
  шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10, одиннадцать: 11,
  двенадцать: 12, тринадцать: 13, четырнадцать: 14, пятнадцать: 15,
  шестнадцать: 16, семнадцать: 17, восемнадцать: 18, девятнадцать: 19,
  двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50,
  шестьдесят: 60, семьдесят: 70, восемьдесят: 80, девяносто: 90,
  сто: 100, двести: 200, триста: 300, четыреста: 400, пятьсот: 500,
  шестьсот: 600, семьсот: 700, восемьсот: 800, девятьсот: 900,
  полдень: 12, полночь: 0,
};

const ORDINALS = {
  перв: 1, втор: 2, треть: 3, четвёрт: 4, четверт: 4, пят: 5, шест: 6,
  седьм: 7, восьм: 8, девят: 9, десят: 10, одиннадцат: 11, двенадцат: 12,
};

const MULT = [
  [/(?:тысяч[аи]?|тыс\.?)(?![а-яё])/iu, 1_000],
  [/(?:миллион[аов]*|млн\.?)(?![а-яё])/iu, 1_000_000],
];

const WORDS_BY_LEN = Object.keys(UNITS)
  .sort((a, b) => b.length - a.length)
  .join('|');

const MONEY_WORD = /(?:₸|тенге|тг(?![а-яё])|руб(?:л[а-яё]+)?|₽|сом)/iu;

export function extractAmounts(text) {
  const out = new Set();
  const s = String(text || '');

  const re = /(\d[\d\s ]{0,12}\d|\d)\s*(тысяч[аи]?|тыс\.?|млн\.?|миллион[аов]*)?\s*(₸|тенге|тг(?![а-яё])|руб[а-яё]*|₽|сом)?/giu;
  let m;
  while ((m = re.exec(s))) {
    const raw = Number(m[1].replace(/[\s ]/g, ''));
    if (!Number.isFinite(raw) || raw <= 0) continue;

    const word = m[2] || '';
    const currency = m[3] || '';
    if (!word && !currency) continue;

    let mult = 1;
    for (const [rx, k] of MULT) if (rx.test(word)) { mult = k; break; }
    out.add(raw * mult);
  }

  if (/полмиллиона/iu.test(s)) out.add(500_000);
  if (/полтораста тысяч/iu.test(s)) out.add(150_000);

  const wordAmount = /([а-яё]+)\s+(тысяч[аи]?|миллион[аов]*)(?![а-яё])/giu;
  while ((m = wordAmount.exec(s))) {
    const n = UNITS[m[1].toLowerCase()];
    if (!n) continue;

    out.add(n * (/миллион/iu.test(m[2]) ? 1_000_000 : 1_000));
  }

  return out;
}

export function extractMoments(text) {
  const out = new Set();
  const s = String(text || '');
  const pad = (h, mm = 0) =>
    `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;

  const canon = /\b([01]?\d|2[0-3]):([0-5]\d)\b/g;
  let m;
  while ((m = canon.exec(s))) out.add(pad(Number(m[1]), m[2]));

  const digitPart = /(\d{1,2})\s*(?:часов|часа|час)?\s*(утра|дня|вечера|ночи)(?![а-яё])/giu;
  while ((m = digitPart.exec(s))) {
    out.add(pad(toDay(Number(m[1]), m[2])));
  }

  const wordPart = new RegExp(
    `(?<![а-яё])(${WORDS_BY_LEN})\\s*(?:часов|часа|час)?\\s*(утра|дня|вечера|ночи)(?![а-яё])`,
    'giu'
  );
  while ((m = wordPart.exec(s))) {
    const h = UNITS[m[1].toLowerCase()];
    if (h === undefined) continue;

    const before = s.slice(Math.max(0, m.index - 12), m.index).toLowerCase();
    if (/(?:^|\s)(?:на|за|через|около)\s*$/u.test(before)) continue;

    out.add(pad(toDay(h, m[2])));
  }

  if (/(?<![а-яё])в\s+полдень(?![а-яё])/iu.test(s)) out.add('12:00');
  if (/(?<![а-яё])в\s+полночь(?![а-яё])/iu.test(s)) out.add('00:00');

  const half = /(?<![а-яё])в\s+половине\s+([а-яё]+|\d{1,2})/iu;
  const hm = s.match(half);
  if (hm) {
    const word = hm[1].toLowerCase();
    let raw = Number(word);
    if (!Number.isFinite(raw)) {

      let best = '';
      let val = NaN;
      for (const [stem, n] of Object.entries(ORDINALS)) {
        if (word.startsWith(stem) && stem.length > best.length) { best = stem; val = n; }
      }
      if (!best) {
        for (const w of Object.keys(UNITS)) {
          const stem = w.replace(/ь$/u, '');
          if (word.startsWith(stem) && stem.length > best.length) { best = stem; val = UNITS[w]; }
        }
      }
      raw = val;
    }
    if (Number.isFinite(raw) && raw >= 1 && raw <= 24) out.add(pad((raw + 23) % 24, 30));
  }

  return out;
}

function toDay(h, part) {
  const p = String(part).toLowerCase();
  if (h > 24) return h % 24;
  if (p === 'утра') return h === 12 ? 0 : h;
  if (p === 'дня') return h < 12 ? h + 12 : h;
  if (p === 'вечера') return h < 12 ? h + 12 : h;
  if (p === 'ночи') return h === 12 ? 0 : (h < 6 ? h : (h + 12) % 24);
  return h;
}

export function extractRangeBounds(text) {
  const out = new Set();
  const re = /от\s+([\d\sа-яё]+?)\s+до\s+([\d\sа-яё]+?)(?:\s|,|\.|$)/giu;
  let m;
  while ((m = re.exec(String(text || '')))) {
    for (const part of [m[1], m[2]]) {

      const withMult = `${part} ${m[2]}`;
      for (const a of extractAmounts(withMult)) out.add(a);
      for (const a of extractAmounts(part)) out.add(a);
    }
  }
  return out;
}
