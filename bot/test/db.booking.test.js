import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://salon:salon@127.0.0.1:5432/salon';

const pool = new pg.Pool({ connectionString: URL, max: 4, connectionTimeoutMillis: 3000 });
let available = false;
try {
  await pool.query('SELECT 1');
  available = true;
} catch (e) {
  console.log(`  ⚠ база недоступна (${e.code || e.message}), тесты БД пропущены`);
}

after(async () => { await pool.end(); });

const skip = () => (available ? false : 'нет подключения к базе');

async function inRollback(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id','1',true)");
    return await fn(c);
  } finally {

    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}

describe('свободные слоты', () => {
  test('обед мастера вычитается из смены', { skip: skip() }, async () => {

    await inRollback(async (c) => {
      const { rows: spans } = await c.query(
        `SELECT lower(span) AS s, upper(span) AS e
           FROM working_spans(1, (CURRENT_DATE + 1)::date) ORDER BY 1`);
      assert.ok(spans.length >= 1, 'у мастера должен быть рабочий интервал');

      const { rows: slots } = await c.query(
        `SELECT to_char(starts_at,'HH24:MI') AS t
           FROM free_slots(5, (CURRENT_DATE + 1)::date, 1)
          WHERE to_char(starts_at,'HH24:MI') BETWEEN '14:00' AND '14:45'`);
      assert.equal(slots.length, 0,
        `в обеденное время слотов быть не должно, а найдено: ${slots.map((r) => r.t)}`);
    });
  });

  test('услуга не должна залезать на обед хвостом', { skip: skip() }, async () => {

    await inRollback(async (c) => {
      const { rows } = await c.query(
        `SELECT to_char(starts_at,'HH24:MI') AS t
           FROM free_slots(5, (CURRENT_DATE + 1)::date, 1)
          WHERE to_char(starts_at,'HH24:MI') = '13:45'`);
      assert.equal(rows.length, 0, 'слот 13:45 залезает на обед и предлагаться не должен');
    });
  });

  test('слот, заканчивающийся ровно к обеду, допустим', { skip: skip() }, async () => {
    await inRollback(async (c) => {
      const { rows } = await c.query(
        `SELECT to_char(starts_at,'HH24:MI') AS t
           FROM free_slots(5, (CURRENT_DATE + 1)::date, 1)
          WHERE to_char(starts_at,'HH24:MI') = '13:30'`);
      assert.equal(rows.length, 1, 'слот 13:30 заканчивается ровно в 14:00 и допустим');
    });
  });
});

describe('причины отказа вместо пустого списка', () => {
  const cases = [
    ['вчера', 'CURRENT_DATE - 1', null, 'PAST'],
    ['через год', 'CURRENT_DATE + 400', null, 'TOO_FAR'],
    ['сегодня', 'CURRENT_DATE', null, 'TOO_LATE_TODAY'],
  ];

  for (const [name, dateExpr, master, expected] of cases) {
    test(`${name} -> ${expected}`, { skip: skip() }, async () => {
      await inRollback(async (c) => {
        const { rows } = await c.query(
          `SELECT code FROM free_slots_reason(2, (${dateExpr})::date, $1)`, [master]);
        assert.equal(rows[0]?.code, expected);
      });
    });
  }

  test('услугу никто не делает -> MASTER_CANT_DO', { skip: skip() }, async () => {
    await inRollback(async (c) => {

      const { rows } = await c.query(
        `SELECT code FROM free_slots_reason(3, (CURRENT_DATE + 2)::date, 3)`);
      assert.equal(rows[0]?.code, 'MASTER_CANT_DO');
    });
  });

  test('причина никогда не бывает пустой', { skip: skip() }, async () => {

    await inRollback(async (c) => {
      for (const d of [-1, 0, 1, 2, 7, 400]) {
        const { rows } = await c.query(
          `SELECT code FROM free_slots_reason(2, (CURRENT_DATE + $1::int)::date, NULL)`, [d]);
        assert.ok(rows[0]?.code, `для смещения ${d} дней должна быть причина`);
      }
    });
  });
});

describe('двойная запись', () => {
  test('два мастера не сядут на одно время', { skip: skip() }, async () => {
    await inRollback(async (c) => {
      const { rows: slot } = await c.query(
        `SELECT starts_at, master_id FROM free_slots(1, (CURRENT_DATE + 2)::date, 1) LIMIT 1`);
      if (!slot.length) return;
      const { starts_at, master_id } = slot[0];

      const { rows: cl } = await c.query(
        `INSERT INTO clients (phone_e164, primary_jid, jids, name)
         VALUES ('+77010000001','t1@test',ARRAY['t1@test'],'Тест1') RETURNING id`);
      const { rows: cl2 } = await c.query(
        `INSERT INTO clients (phone_e164, primary_jid, jids, name)
         VALUES ('+77010000002','t2@test',ARRAY['t2@test'],'Тест2') RETURNING id`);

      await c.query(`SELECT book_appointment($1,$2,1,$3::timestamptz,'bot','')`,
        [cl[0].id, master_id, starts_at]);

      await assert.rejects(
        () => c.query(`SELECT book_appointment($1,$2,1,$3::timestamptz,'bot','')`,
          [cl2[0].id, master_id, starts_at]),
        (e) => e.code === '23P01',
        'вторая запись на тот же слот обязана отклоняться базой');
    });
  });

  test('клиентка не может быть у двух мастеров сразу', { skip: skip() }, async () => {

    await inRollback(async (c) => {
      const { rows: slots } = await c.query(
        `SELECT starts_at, master_id FROM free_slots(1, (CURRENT_DATE + 2)::date, NULL)
          ORDER BY starts_at LIMIT 20`);
      const first = slots[0];
      const other = slots.find((s) => s.master_id !== first?.master_id
        && String(s.starts_at) === String(first?.starts_at));
      if (!first || !other) return;

      const { rows: cl } = await c.query(
        `INSERT INTO clients (phone_e164, primary_jid, jids, name)
         VALUES ('+77010000003','t3@test',ARRAY['t3@test'],'Тест3') RETURNING id`);

      await c.query(`SELECT book_appointment($1,$2,1,$3::timestamptz,'bot','')`,
        [cl[0].id, first.master_id, first.starts_at]);

      await assert.rejects(
        () => c.query(`SELECT book_appointment($1,$2,1,$3::timestamptz,'bot','')`,
          [cl[0].id, other.master_id, other.starts_at]),
        (e) => e.code === '23P01',
        'один человек не может сидеть у двух мастеров одновременно');
    });
  });
});

describe('комбо: несколько услуг за визит', () => {
  test('длительность и цена складываются', { skip: skip() }, async () => {
    await inRollback(async (c) => {
      const { rows: slot } = await c.query(
        `SELECT starts_at, master_id FROM free_slots(3, (CURRENT_DATE + 3)::date, NULL) LIMIT 1`);
      if (!slot.length) return;

      const { rows: cl } = await c.query(
        `INSERT INTO clients (phone_e164, primary_jid, jids, name)
         VALUES ('+77010000004','t4@test',ARRAY['t4@test'],'Тест4') RETURNING id`);

      const { rows: r } = await c.query(
        `SELECT book_appointment_multi($1,$2,ARRAY[1,5]::int[],$3::timestamptz,'bot','') AS id`,
        [cl[0].id, slot[0].master_id, slot[0].starts_at]);

      const { rows: appt } = await c.query(
        `SELECT a.duration_min, a.price_kzt,
                (SELECT count(*) FROM appointment_services WHERE appointment_id = a.id) AS n
           FROM appointments a WHERE a.id = $1`, [r[0].id]);

      const { rows: svc } = await c.query(
        `SELECT sum(duration_min) d, sum(price_kzt) p FROM services WHERE id IN (1,5)`);

      assert.equal(Number(appt[0].n), 2, 'в визите должно быть две услуги');
      assert.equal(appt[0].duration_min, Number(svc[0].d), 'длительность = сумма');
      assert.equal(appt[0].price_kzt, Number(svc[0].p), 'цена = сумма');
    });
  });
});

describe('изоляция салонов', () => {
  test('под чужим салоном данных не видно', { skip: skip() }, async () => {

    const botUrl = process.env.BOT_DATABASE_URL;
    if (!botUrl) return;

    const bot = new pg.Pool({ connectionString: botUrl, max: 2 });
    try {
      const c = await bot.connect();
      try {
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.tenant_id','999999',true)");
        for (const t of ['clients', 'appointments', 'services', 'messages']) {
          const { rows } = await c.query(`SELECT count(*)::int n FROM ${t}`);
          assert.equal(rows[0].n, 0, `таблица ${t} не должна отдавать чужие строки`);
        }
        await c.query('ROLLBACK');
      } finally { c.release(); }
    } finally { await bot.end(); }
  });

  test('без указания салона данных не видно', { skip: skip() }, async () => {
    const botUrl = process.env.BOT_DATABASE_URL;
    if (!botUrl) return;

    const bot = new pg.Pool({ connectionString: botUrl, max: 2 });
    try {
      const { rows } = await bot.query('SELECT count(*)::int n FROM clients');
      assert.equal(rows[0].n, 0, 'без салона система обязана падать закрыто');
    } finally { await bot.end(); }
  });
});

describe('часовой пояс', () => {
  test('база живёт в зоне салона, а не сервера', { skip: skip() }, async () => {

    await inRollback(async (c) => {
      const { rows } = await c.query(`SELECT to_char(now(), 'TZH') AS off`);
      assert.equal(rows[0].off, '+05', 'смещение должно быть +05 (Asia/Almaty)');
    });
  });
});
