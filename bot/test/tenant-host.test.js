import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { slugFromHost } from '../src/host.js';

const D = 'salon.kz';

describe('нормальные поддомены', () => {
  test('простой поддомен', () => {
    assert.equal(slugFromHost('nogotok.salon.kz', D), 'nogotok');
  });

  test('с портом', () => {
    assert.equal(slugFromHost('nogotok.salon.kz:3000', D), 'nogotok');
  });

  test('регистр не важен', () => {
    assert.equal(slugFromHost('NoGoToK.Salon.KZ', D), 'nogotok');
  });

  test('пробелы обрезаются', () => {
    assert.equal(slugFromHost('  nogotok.salon.kz  ', D), 'nogotok');
  });

  test('дефис допустим', () => {
    assert.equal(slugFromHost('krasota-almaty.salon.kz', D), 'krasota-almaty');
  });
});

describe('служебные имена салоном не считаются', () => {
  for (const sub of ['panel', 'admin', 'www', 'api']) {
    test(`${sub}.salon.kz -> общая панель`, () => {
      assert.equal(slugFromHost(`${sub}.${D}`, D), null);
    });
  }
});

describe('падаем закрыто', () => {
  test('корневой домен — не салон', () => {
    assert.equal(slugFromHost(D, D), null);
  });

  test('чужой домен — не салон', () => {

    assert.equal(slugFromHost('nogotok.evil.com', D), null);
    assert.equal(slugFromHost('salon.kz.evil.com', D), null);
  });

  test('домен, лишь заканчивающийся на наш — не салон', () => {

    assert.equal(slugFromHost('a.notsalon.kz', 'salon.kz'), null);
  });

  test('вложенные поддомены не наши', () => {

    assert.equal(slugFromHost('a.b.salon.kz', D), null);
  });

  test('пустой поддомен', () => {
    assert.equal(slugFromHost('.salon.kz', D), null);
  });

  test('пустой хост', () => {
    assert.equal(slugFromHost('', D), null);
    assert.equal(slugFromHost(null, D), null);
    assert.equal(slugFromHost(undefined, D), null);
  });

  test('без корневого домена поддомены не разбираются', () => {

    assert.equal(slugFromHost('nogotok.salon.kz', ''), null);
    assert.equal(slugFromHost('nogotok.salon.kz', null), null);
  });

  test('localhost — не салон', () => {
    assert.equal(slugFromHost('localhost', D), null);
    assert.equal(slugFromHost('127.0.0.1:3011', D), null);
  });
});

describe('попытки обмана', () => {
  for (const host of [
    'nogotok.salon.kz.attacker.io',
    'xn--salon.kz',
    'nogotok..salon.kz',
    'nogotok.salon.kz.',
    '../nogotok.salon.kz',
  ]) {
    test(`«${host}» не даёт салона`, () => {
      const r = slugFromHost(host, D);
      assert.ok(r === null || /^[a-z][a-z0-9-]*$/.test(r),
        `резолвер вернул подозрительное значение: ${r}`);
    });
  }
});
