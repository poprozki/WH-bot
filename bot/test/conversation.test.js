import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { draftMode, stripGreeting, stripNagging } from '../src/conversation-rules.js';
import { plural, cap, h } from '../src/panel/layout.js';

const HOUR = 3_600_000;
const now = Date.UTC(2026, 6, 28, 12, 0, 0);
const ago = (hours) => ({ updated_at: new Date(now - hours * HOUR).toISOString() });

describe('лестница возврата', () => {
  test('черновика нет — начинаем с нуля', () => {
    assert.equal(draftMode(now, null), 'FRESH');
    assert.equal(draftMode(now, {}), 'FRESH');
  });

  test('до 6 часов — продолжаем молча', () => {

    assert.equal(draftMode(now, ago(0.5)), 'CONTINUE');
    assert.equal(draftMode(now, ago(5.9)), 'CONTINUE');
  });

  test('6–36 часов — предлагаем продолжить с того места', () => {
    assert.equal(draftMode(now, ago(6)), 'CONFIRM');
    assert.equal(draftMode(now, ago(24)), 'CONFIRM');
    assert.equal(draftMode(now, ago(35.9)), 'CONFIRM');
  });

  test('36 часов — неделя: один факт из прошлого', () => {

    assert.equal(draftMode(now, ago(36)), 'HINT');
    assert.equal(draftMode(now, ago(24 * 6)), 'HINT');
  });

  test('больше недели — как впервые', () => {
    assert.equal(draftMode(now, ago(24 * 7)), 'FRESH');
    assert.equal(draftMode(now, ago(24 * 30)), 'FRESH');
  });

  test('границы порогов не пересекаются', () => {
    const modes = [0, 3, 6, 20, 36, 100, 168, 500].map((hh) => draftMode(now, ago(hh)));
    assert.deepEqual(modes,
      ['CONTINUE', 'CONTINUE', 'CONFIRM', 'CONFIRM', 'HINT', 'HINT', 'FRESH', 'FRESH']);
  });
});

describe('приветствие', () => {
  test('срезается вместе со знаками и поднимается регистр', () => {
    assert.equal(stripGreeting('Здравствуйте! Педикюр стоит 13 000 ₸'),
      'Педикюр стоит 13 000 ₸');
    assert.equal(stripGreeting('Добрый день, свободно в 15:00'),
      'Свободно в 15:00');
    assert.equal(stripGreeting('Привет — записываю вас'), 'Записываю вас');
  });

  test('приветствие внутри текста не трогаем', () => {
    const t = 'Мастер передала вам привет и ждёт в 15:00';
    assert.equal(stripGreeting(t), t);
  });

  test('текст без приветствия остаётся как есть', () => {
    assert.equal(stripGreeting('Свободно в 11:00'), 'Свободно в 11:00');
  });
});

describe('упрёки клиентке', () => {
  for (const phrase of [
    'Как я уже говорила, педикюр стоит 13 000',
    'Повторюсь: свободно только в 15:00',
    'Вы уже спрашивали об этом',
    'В прошлый раз вы записывались к Айгуль',
    'И снова здравствуйте!',
  ]) {
    test(`ловится: «${phrase.slice(0, 30)}…»`, () => {
      const r = stripNagging(phrase);
      assert.equal(r.clean, false, 'фраза должна быть отмечена как упрёк');
      assert.ok(r.phrase, 'должна вернуться найденная фраза');
    });
  }

  test('нормальный ответ проходит', () => {
    assert.equal(stripNagging('Педикюр — 13 000 ₸, свободно в 15:00').clean, true);
  });

  test('слово «повторить» само по себе не упрёк', () => {
    assert.equal(stripNagging('Могу повторить дизайн, который делали').clean, true);
  });
});

describe('русские склонения', () => {
  test('записи', () => {
    const f = (n) => `${n} ${plural(n, 'запись', 'записи', 'записей')}`;
    assert.equal(f(1), '1 запись');
    assert.equal(f(2), '2 записи');
    assert.equal(f(4), '4 записи');
    assert.equal(f(5), '5 записей');
    assert.equal(f(11), '11 записей');
    assert.equal(f(12), '12 записей');
    assert.equal(f(14), '14 записей');
    assert.equal(f(21), '21 запись');
    assert.equal(f(22), '22 записи');
    assert.equal(f(25), '25 записей');
    assert.equal(f(101), '101 запись');
    assert.equal(f(111), '111 записей');
    assert.equal(f(0), '0 записей');
  });

  test('клиентки', () => {
    const f = (n) => `${n} ${plural(n, 'клиентка', 'клиентки', 'клиенток')}`;
    assert.equal(f(1), '1 клиентка');
    assert.equal(f(3), '3 клиентки');
    assert.equal(f(8), '8 клиенток');
  });
});

describe('заглавная буква', () => {
  test('поднимает первую, остальное не трогает', () => {
    assert.equal(cap('вторник, 28 июля'), 'Вторник, 28 июля');
    assert.equal(cap('Вторник'), 'Вторник');
    assert.equal(cap(''), '');
  });

  test('НЕ капитализирует каждое слово', () => {

    assert.equal(cap('услуги и цены'), 'Услуги и цены');
  });
});

describe('экранирование', () => {
  test('имена клиенток приходят из WhatsApp — это чужой ввод', () => {
    assert.equal(h('<script>alert(1)</script>'),
      '&lt;script&gt;alert(1)&lt;/script&gt;');
    assert.equal(h('Аня "Ноготочки"'), 'Аня &quot;Ноготочки&quot;');
    assert.equal(h("O'Брайен"), 'O&#39;Брайен');
    assert.equal(h('Маша & Даша'), 'Маша &amp; Даша');
  });

  test('пустые значения не ломают вывод', () => {
    assert.equal(h(null), '');
    assert.equal(h(undefined), '');
    assert.equal(h(0), '0');
  });
});
