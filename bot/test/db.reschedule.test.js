import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://salon:salon@127.0.0.1:5432/salon';

const pool = new pg.Pool({ connectionString: URL, max: 4, connectionTimeoutMillis: 3000 });
let available = false;
try { await pool.query('SELECT 1'); available = true; } catch {  }
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

async function seed(c, phone, dayOffset = 6) {
  const { rows: slots } = await c.query(
    `SELECT starts_at, master_id FROM free_slots(1, (CURRENT_DATE + $1::int)::date, NULL)
      ORDER BY starts_at LIMIT 8`, [dayOffset]);
  if (slots.length < 2) return null;

  const { rows: cl } = await c.query(
    `INSERT INTO clients (phone_e164, primary_jid, jids, name)
     VALUES ($1, $1 || '@t', ARRAY[$1 || '@t'], 'Тест') RETURNING id`, [phone]);

  const { rows: b } = await c.query(
    `SELECT book_appointment_multi($1,$2,ARRAY[1]::int[],$3::timestamptz,'bot','') AS id`,
    [cl[0].id, slots[0].master_id, slots[0].starts_at]);

  return { clientId: cl[0].id, apptId: b[0].id, slots };
}

describe('перенос', () => {
  test('флаги напоминаний сбрасываются', { skip: skip() }, async () => {

    await inRollback(async (c) => {
      const s = await seed(c, '+77018000001');
      if (!s) return;

      await c.query(
        `UPDATE appointments SET reminded_24h_at = now(), reminded_2h_at = now() WHERE id = $1`,
        [s.apptId]);

      const later = s.slots.find((x) => String(x.starts_at) !== String(s.slots[0].starts_at));
      await c.query(`SELECT reschedule_appointment($1, $2::timestamptz, NULL)`,
        [s.apptId, later.starts_at]);

      const { rows } = await c.query(
        `SELECT reminded_24h_at, reminded_2h_at, reschedule_count
           FROM appointments WHERE id = $1`, [s.apptId]);

      assert.equal(rows[0].reminded_24h_at, null, 'напоминание за сутки должно быть сброшено');
      assert.equal(rows[0].reminded_2h_at, null, 'напоминание за 2 часа должно быть сброшено');
      assert.equal(rows[0].reschedule_count, 1, 'счётчик переносов должен вырасти');
    });
  });

  test('slot пересчитывается — иначе защита от пересечений врёт', { skip: skip() }, async () => {
    await inRollback(async (c) => {
      const s = await seed(c, '+77018000002');
      if (!s) return;
      const later = s.slots.find((x) => String(x.starts_at) !== String(s.slots[0].starts_at));

      await c.query(`SELECT reschedule_appointment($1, $2::timestamptz, NULL)`,
        [s.apptId, later.starts_at]);

      const { rows } = await c.query(
        `SELECT starts_at, lower(slot) AS slot_start, ends_at FROM appointments WHERE id = $1`,
        [s.apptId]);
      assert.equal(String(rows[0].slot_start), String(rows[0].starts_at),
        'начало слота обязано совпадать с новым временем записи');
    });
  });

  test('перенос в занятое время отклоняется', { skip: skip() }, async () => {
    await inRollback(async (c) => {
      const s = await seed(c, '+77018000003');
      if (!s) return;

      const { rows: fresh } = await c.query(
        `SELECT starts_at, master_id FROM free_slots(1, (CURRENT_DATE + 6)::date, $1)
          ORDER BY starts_at LIMIT 5`, [s.slots[0].master_id]);
      if (!fresh.length) return;
      const later = fresh[0];

      const { rows: cl2 } = await c.query(
        `INSERT INTO clients (phone_e164, primary_jid, jids, name)
         VALUES ('+77018000013','x@t',ARRAY['x@t'],'Другая') RETURNING id`);
      await c.query(`SELECT book_appointment_multi($1,$2,ARRAY[1]::int[],$3::timestamptz,'bot','')`,
        [cl2[0].id, later.master_id, later.starts_at]);

      await assert.rejects(
        () => c.query(`SELECT reschedule_appointment($1, $2::timestamptz, NULL)`,
          [s.apptId, later.starts_at]),
        (e) => e.code === '23P01',
        'перенос на занятое время обязан отклоняться');
    });
  });

  test('перенос вне графика отклоняется', { skip: skip() }, async () => {
    await inRollback(async (c) => {
      const s = await seed(c, '+77018000004');
      if (!s) return;

      const night = new Date(s.slots[0].starts_at);
      night.setUTCHours(23, 0, 0, 0);
      await assert.rejects(
        () => c.query(`SELECT reschedule_appointment($1, $2::timestamptz, NULL)`,
          [s.apptId, night.toISOString()]),
        (e) => /SLOT_OUTSIDE_HOURS|TOO_SOON/.test(e.message));
    });
  });

  test('отменённую запись перенести нельзя', { skip: skip() }, async () => {
    await inRollback(async (c) => {
      const s = await seed(c, '+77018000005');
      if (!s) return;
      await c.query(`UPDATE appointments SET status='cancelled' WHERE id=$1`, [s.apptId]);
      const later = s.slots[1];
      await assert.rejects(
        () => c.query(`SELECT reschedule_appointment($1, $2::timestamptz, NULL)`,
          [s.apptId, later.starts_at]),
        (e) => /APPT_NOT_ACTIVE/.test(e.message));
    });
  });
});

describe('отмена', () => {
  test('слот освобождается для других', { skip: skip() }, async () => {
    await inRollback(async (c) => {
      const s = await seed(c, '+77018000006');
      if (!s) return;
      const { starts_at, master_id } = s.slots[0];

      await c.query(`SELECT cancel_appointment($1, 'тест')`, [s.apptId]);

      const { rows: cl2 } = await c.query(
        `INSERT INTO clients (phone_e164, primary_jid, jids, name)
         VALUES ('+77018000016','y@t',ARRAY['y@t'],'Вторая') RETURNING id`);
      const { rows } = await c.query(
        `SELECT book_appointment_multi($1,$2,ARRAY[1]::int[],$3::timestamptz,'bot','') AS id`,
        [cl2[0].id, master_id, starts_at]);
      assert.ok(rows[0].id, 'после отмены слот обязан освободиться');
    });
  });

  test('поздняя отмена помечается триггером', { skip: skip() }, async () => {

    await inRollback(async (c) => {
      const { rows: cl } = await c.query(
        `INSERT INTO clients (phone_e164, primary_jid, jids, name)
         VALUES ('+77018000007','z@t',ARRAY['z@t'],'Поздняя') RETURNING id`);

      const soon = new Date(Date.now() + 60 * 60 * 1000);
      await c.query(
        `INSERT INTO appointments (client_id, master_id, service_id, starts_at,
                                   duration_min, buffer_min, price_kzt, status, source, ends_at, slot)
         VALUES ($1, 1, 1, $2, 60, 10, 6000, 'confirmed', 'panel', $2, tstzrange($2,$2,'[)'))`,
        [cl[0].id, soon.toISOString()]);

      const { rows: a } = await c.query(
        `SELECT id FROM appointments WHERE client_id = $1`, [cl[0].id]);
      await c.query(`UPDATE appointments SET status='cancelled' WHERE id=$1`, [a[0].id]);

      const { rows } = await c.query(
        `SELECT late_cancel, cancelled_at FROM appointments WHERE id=$1`, [a[0].id]);
      assert.equal(rows[0].late_cancel, true, 'отмена за час обязана считаться поздней');
      assert.ok(rows[0].cancelled_at, 'момент отмены должен фиксироваться');
    });
  });

  test('заблаговременная отмена поздней не считается', { skip: skip() }, async () => {
    await inRollback(async (c) => {
      const s = await seed(c, '+77018000008', 10);
      if (!s) return;
      await c.query(`UPDATE appointments SET status='cancelled' WHERE id=$1`, [s.apptId]);
      const { rows } = await c.query(
        `SELECT late_cancel FROM appointments WHERE id=$1`, [s.apptId]);
      assert.equal(rows[0].late_cancel, false);
    });
  });
});

describe('журнал изменений', () => {
  test('каждое изменение записи попадает в историю', { skip: skip() }, async () => {

    await inRollback(async (c) => {
      const s = await seed(c, '+77018000009');
      if (!s) return;
      const later = s.slots.find((x) => String(x.starts_at) !== String(s.slots[0].starts_at));
      await c.query(`SELECT reschedule_appointment($1, $2::timestamptz, NULL)`,
        [s.apptId, later.starts_at]);
      await c.query(`SELECT cancel_appointment($1, 'тест')`, [s.apptId]);

      const { rows } = await c.query(
        `SELECT op FROM appointments_history WHERE appointment_id=$1 ORDER BY id`, [s.apptId]);
      assert.ok(rows.length >= 3, `ожидали минимум 3 записи истории, получили ${rows.length}`);
      assert.equal(rows[0].op, 'INSERT');
    });
  });
});
