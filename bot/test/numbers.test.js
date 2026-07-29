import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractAmounts, extractMoments } from '../src/llm/numbers.js';

const amounts = (t) => [...extractAmounts(t)];
const moments = (t) => [...extractMoments(t)];

describe('суммы: ловятся', () => {
  const cases = [
    ['11 000 ₸', 11000],
    ['11000₸', 11000],
    ['5000 тг', 5000],
    ['от 1 000 тенге', 1000],
    ['400 тысяч тенге', 400000],
    ['15 тыс', 15000],
    ['2 млн тенге', 2000000],
    ['примерно полмиллиона', 500000],
    ['двести тысяч тенге', 200000],
    ['около 350 000 тенге', 350000],
  ];
  for (const [text, expected] of cases) {
    test(`«${text}» -> ${expected}`, () => {
      assert.ok(amounts(text).includes(expected),
        `ожидали ${expected}, получили ${JSON.stringify(amounts(text))}`);
    });
  }

  test('множитель нормализуется в число', () => {

    assert.deepEqual(amounts('400 тысяч тенге'), [400000]);
  });
});

describe('суммы: НЕ ловятся', () => {
  for (const text of [
    'полтора часа',
    'на три дня',
    '400 клиенток',
    'запись номер 42',
    'маникюр 90 минут',
    'три мастера',
  ]) {
    test(`«${text}» деньгами не является`, () => {
      assert.deepEqual(amounts(text), [],
        `ложное срабатывание: ${JSON.stringify(amounts(text))}`);
    });
  }
});

describe('время: ловится', () => {
  const cases = [
    ['в 15:00', '15:00'],
    ['в 9 утра', '09:00'],
    ['в 7 вечера', '19:00'],
    ['в три часа дня', '15:00'],
    ['в девять утра', '09:00'],
    ['в два часа ночи', '02:00'],
    ['в полдень', '12:00'],
    ['в полночь', '00:00'],
    ['в половине двенадцатого', '11:30'],
    ['в половине шестого', '05:30'],
    ['в половине первого', '00:30'],
  ];
  for (const [text, expected] of cases) {
    test(`«${text}» -> ${expected}`, () => {
      assert.ok(moments(text).includes(expected),
        `ожидали ${expected}, получили ${JSON.stringify(moments(text))}`);
    });
  }

  test('порядковые разбираются по самой длинной основе', () => {

    assert.deepEqual(moments('в половине двенадцатого'), ['11:30']);
  });
});

describe('время: НЕ ловится', () => {
  for (const text of [
    'на три дня',
    'за два дня',
    'через 20 минут',
    'полтора часа',
    'три тысячи тенге',
    'двенадцать услуг',
    'около трёх дня',
  ]) {
    test(`«${text}» моментом не является`, () => {
      assert.deepEqual(moments(text), [],
        `ложное срабатывание: ${JSON.stringify(moments(text))}`);
    });
  }

  test('предлог меняет смысл целиком', () => {

    assert.deepEqual(moments('в три часа дня'), ['15:00']);
    assert.deepEqual(moments('на три дня'), []);
  });
});

describe('кириллица и границы слов', () => {
  test('\\b не используется рядом с кириллицей', async () => {

    const fs = await import('node:fs/promises');
    const url = await import('node:url');
    const src = await fs.readFile(
      url.fileURLToPath(new URL('../src/llm/numbers.js', import.meta.url)), 'utf8');

    const bad = src.split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
      .filter(({ line }) => /\\b[а-яёА-ЯЁ]|[а-яёА-ЯЁ]\\b/u.test(line));

    assert.deepEqual(bad.map((b) => b.n), [],
      `\\b рядом с кириллицей в строках: ${bad.map((b) => `${b.n}: ${b.line.trim()}`).join(' | ')}`);
  });

  test('«тг» не путается с «тгшный»', () => {
    assert.deepEqual(amounts('5000 тг'), [5000]);
    assert.deepEqual(amounts('5000 тгшный'), []);
  });
});
