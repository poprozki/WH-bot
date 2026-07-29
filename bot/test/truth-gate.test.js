import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkReply, correctionFor, extractPrices, extractTimes, collectAllowed, limitEmoji,
} from '../src/llm/truth-gate.js';

const SERVICES = [{
  услуги: [
    { 'название': 'Маникюр без покрытия', 'длительность_мин': 60, 'цена': '6 000 ₸' },
    { 'название': 'Маникюр + гель-лак', 'длительность_мин': 90, 'цена': '11 000 ₸' },
  ],
  всего_найдено: 40,
}];

const SLOTS = [{
  свободные_слоты: [
    { 'время': '11:00', 'мастер': 'Айгуль', starts_at: '2026-07-30T11:00:00+05:00' },
    { 'время': '15:30', 'мастер': 'Динара', starts_at: '2026-07-30T15:30:00+05:00' },
  ],
}];

describe('извлечение чисел', () => {
  test('цены в разных написаниях', () => {
    assert.deepEqual([...extractPrices('11 000 ₸')], [11000]);
    assert.deepEqual([...extractPrices('11000₸')], [11000]);
    assert.deepEqual([...extractPrices('от 1 000 тенге')], [1000]);
    assert.deepEqual([...extractPrices('5000 тг')], [5000]);
  });

  test('текст без денег не даёт цен', () => {
    assert.equal(extractPrices('маникюр 90 минут').size, 0);
    assert.equal(extractPrices('запись номер 42').size, 0);
  });

  test('время', () => {
    assert.deepEqual([...extractTimes('в 11:00 и в 9:30')], ['11:00', '09:30']);
  });
});

describe('разрешённые числа собираются только из денежных полей', () => {
  test('длительность НЕ становится ценой', () => {

    const allowed = collectAllowed(SERVICES);
    assert.ok(allowed.prices.has(11000), 'настоящая цена разрешена');
    assert.ok(!allowed.prices.has(90), 'длительность 90 не является ценой');
    assert.ok(!allowed.prices.has(60), 'длительность 60 не является ценой');
    assert.ok(!allowed.prices.has(40), 'счётчик «всего_найдено» не является ценой');
  });

  test('время берётся из временных полей и ISO', () => {
    const allowed = collectAllowed(SLOTS);
    assert.ok(allowed.times.has('11:00'));
    assert.ok(allowed.times.has('15:30'));
  });
});

describe('цены', () => {
  test('настоящая цена проходит', () => {
    const r = checkReply('Маникюр с гель-лаком — 11 000 ₸', SERVICES, '');
    assert.equal(r.ok, true);
  });

  test('выдуманная цена блокируется', () => {

    const r = checkReply('Классический маникюр — 5 000 ₸', SERVICES, '');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invented_price');
    assert.equal(r.detail, '5000');
  });

  test('длительность, названная как цена, блокируется', () => {
    const r = checkReply('Маникюр стоит 90 ₸', SERVICES, '');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invented_price');
  });

  test('цену из сообщения клиентки повторять НЕЛЬЗЯ', () => {

    const r = checkReply('Да, всё верно, 5 000 ₸', SERVICES, 'вы же говорили 5000');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invented_price');
  });
});

describe('время', () => {
  test('время из find_slots проходит', () => {
    const r = checkReply('Есть свободно в 11:00', SLOTS, '');
    assert.equal(r.ok, true);
  });

  test('выдуманное время блокируется', () => {
    const r = checkReply('Могу предложить 11:00 или 16:45', SLOTS, '');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invented_time');
    assert.equal(r.detail, '16:45');
  });

  test('время, названное клиенткой, повторить эхом можно', () => {

    const r = checkReply('Проверю, свободно ли в 14:00', SLOTS, 'а можно в 14:00?');
    assert.equal(r.ok, true);
  });
});

describe('обещания', () => {
  for (const phrase of [
    'Сделаем вам скидку как постоянной клиентке',
    'Дизайн в подарок',
    'Первое посещение бесплатно',
    'Можем оформить в рассрочку',
    'Гарантирую, что покрытие не слетит',
    'Вернём деньги, если не понравится',
  ]) {
    test(`блокируется: «${phrase}»`, () => {
      const r = checkReply(phrase, SERVICES, '');
      assert.equal(r.ok, false, 'обещание должно быть заблокировано');
      assert.equal(r.reason, 'promise');
    });
  }

  test('обычный ответ про цену не считается обещанием', () => {
    const r = checkReply('Маникюр с покрытием — 11 000 ₸, это наша базовая услуга.', SERVICES, '');
    assert.equal(r.ok, true);
  });
});

describe('платёжные реквизиты', () => {
  test('номер карты блокируется', () => {

    const r = checkReply('Переведите на 4400 4301 2345 6789', SERVICES, '');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'payment_details');
  });
});

describe('внутренняя кухня', () => {
  for (const phrase of [
    'Похоже, система показывает слоты для отдельных услуг',
    'Инструмент вернул пустой список',
    'В базе такой услуги нет',
  ]) {
    test(`блокируется: «${phrase}»`, () => {
      const r = checkReply(phrase, SERVICES, '');
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'internal_leak');
    });
  }
});

describe('эмодзи', () => {
  test('один остаётся', () => {
    assert.equal(limitEmoji('Привет 😊'), 'Привет 😊');
  });

  test('лишние срезаются', () => {
    const out = limitEmoji('Привет 😊💅✨🎨 рада вас видеть');
    const count = (out.match(/[\u{1F300}-\u{1FAFF}]/gu) || []).length;
    assert.equal(count, 1, 'должен остаться ровно один эмодзи');
    assert.ok(out.includes('рада вас видеть'), 'текст не пострадал');
  });
});

describe('пустой ответ', () => {
  test('пустая строка не проходит', () => {
    assert.equal(checkReply('   ', SERVICES, '').ok, false);
    assert.equal(checkReply('', SERVICES, '').reason, 'empty');
  });
});

describe('подсказки на исправление', () => {
  test('у каждой причины есть внятное указание модели', () => {
    for (const reason of ['invented_price', 'invented_time', 'internal_leak', 'promise', 'empty']) {
      const text = correctionFor({ reason, detail: 'X' });
      assert.ok(text.length > 20, `подсказка для ${reason} слишком короткая`);
      assert.ok(/[а-яё]/i.test(text), `подсказка для ${reason} должна быть по-русски`);
    }
  });
});
