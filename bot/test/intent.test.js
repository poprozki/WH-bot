import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { routeBookingIntent } from '../src/intent.js';

const ACTIVE = [{ id: 42 }];
const NONE = [];

const op = (text, active = ACTIVE) => routeBookingIntent(text, active).op;

describe('перенос', () => {
  for (const t of [
    'можно на часик позже',
    'можно на час раньше',
    'перенесите пожалуйста на субботу',
    'перенесите на другой день',
    'а можно пораньше',
    'а можно попозже',
    'подвиньте на полчаса раньше',
    'сдвиньте на 30 минут позже',
    'поменяйте время пожалуйста',
    'не успеваю к 15, можно позже',
  ]) {
    test(`«${t}» -> RESCHEDULE`, () => assert.equal(op(t), 'RESCHEDULE'));
  }

  test('кириллические окончания не ломают шаблон', () => {

    assert.equal(op('можно на часик позже'), 'RESCHEDULE');
    assert.equal(op('можно на полчасика раньше'), 'RESCHEDULE');
  });

  test('без активной записи перенос невозможен', () => {
    assert.equal(op('можно на часик позже', NONE), 'NONE');
  });
});

describe('добавление услуги', () => {
  for (const t of [
    'можно ещё педикюр добавить',
    'добавьте пожалуйста дизайн',
    'и педикюр тоже',
    'заодно снятие сделайте',
  ]) {
    test(`«${t}» -> ADD_SERVICE`, () => assert.equal(op(t), 'ADD_SERVICE'));
  }
});

describe('новая запись', () => {
  for (const t of [
    'хочу записаться ещё раз',
    'запишите на следующий месяц тоже',
    'можно через две недели ещё раз',
  ]) {
    test(`«${t}» -> NEW`, () => assert.equal(op(t), 'NEW'));
  }
});

describe('опоздание — это НЕ перенос', () => {
  for (const t of [
    'я опоздаю минут на 15',
    'застряла в пробке, буду позже минут на 20',
    'немного задержусь',
  ]) {
    test(`«${t}» -> LATE`, () => assert.equal(op(t), 'LATE'));
  }

  test('время записи трогать нельзя', () => {
    const r = routeBookingIntent('я опоздаю на 15 минут', ACTIVE);
    assert.equal(r.op, 'LATE');
    assert.match(r.hint, /НЕ МЕНЯЙ|не меняй/i,
      'подсказка обязана запрещать изменение времени');
  });
});

describe('отмена', () => {
  for (const t of [
    'отмените запись',
    'не смогу прийти',
    'не получится, извините',
    'уберите запись пожалуйста',
  ]) {
    test(`«${t}» -> CANCEL`, () => assert.equal(op(t), 'CANCEL'));
  }

  test('отмену принимаем без причины и без условий', () => {
    const r = routeBookingIntent('не смогу прийти', ACTIVE);
    assert.match(r.hint, /ВСЕГДА/,
      'подсказка обязана требовать безусловного приёма отмены');
    assert.match(r.hint, /причину не спрашивай/i);
  });
});

describe('приоритеты', () => {
  test('отмена важнее переноса', () => {

    assert.equal(op('не смогу прийти, может перенесём'), 'CANCEL');
  });

  test('опоздание важнее переноса', () => {
    assert.equal(op('опоздаю, буду позже'), 'LATE');
  });

  test('запись есть, намерение неясно — не переспрашиваем очевидное', () => {
    const r = routeBookingIntent('а во сколько я записана', ACTIVE);
    assert.equal(r.op, 'UNKNOWN_WITH_BOOKING');
    assert.match(r.hint, /ничего не переспрашивая|отвечай сразу/i);
  });

  test('записи нет и намерения нет — тишина', () => {
    const r = routeBookingIntent('здравствуйте', NONE);
    assert.equal(r.op, 'NONE');
    assert.equal(r.hint, '');
  });
});

describe('ложные срабатывания', () => {
  test('«вы очень приятный человек» не считается просьбой позвать человека', () => {

    assert.equal(op('вы очень приятный человек, спасибо', NONE), 'NONE');
  });

  test('вопрос про цену не является операцией', () => {
    assert.equal(op('сколько стоит педикюр', NONE), 'NONE');
  });
});
