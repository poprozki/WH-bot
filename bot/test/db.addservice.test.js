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

async function seedBooking(c, { serviceId = 1, dayOffset = 4, phone = '+77019000001' } = {}) {
  const { rows: slot } = await c.query(
    `SELECT starts_at, master_id FROM free_slots($1, (CURRENT_DATE + $2::int)::date, NULL) LIMIT 1`,
    [serviceId, dayOffset]);
  if (!slot.length) return null;

  const { rows: cl } = await c.query(
    `INSERT INTO clients (phone_e164, primary_jid, jids, name)
     VALUES ($1, $1 || '@test', ARRAY[$1 || '@test'], 'Тест') RETURNING id`, [phone]);

  const { rows: b } = await c.query(
    `SELECT book_appointment_multi($1,$2,ARRAY[$3]::int[],$4::timestamptz,'bot','') AS id`,
    [cl[0].id, slot[0].master_id, serviceId, slot[0].starts_at]);

  return { clientId: cl[0].id, apptId: b[0].id, ...slot[0] };
}

describe('добавление услуги', () => {
  test('длительность и цена пересчитываются', { skip: skip() }, async () => {
    await inRollback(async (c) => {
      const s = await seedBooking(c);
      if (!s) return;

      const { rows: before } = await c.query(
        `SELECT duration_min, price_kzt, ends_at FROM appointments WHERE id = $1`, [s.apptId]);

      const { rows: after2 } = await c.query(
        `SELECT out_duration_min AS duration_min, out_price_kzt AS price_kzt,
                out_ends_at AS ends_at, out_services AS services
           FROM add_service_to_appointment($1, 5)`, [s.apptId]);

      const { rows: svc } = await c.query(
        `SELECT duration_min d, price_kzt p FROM services WHERE id = 5`);

      assert.equal(after2[0].duration_min, before[0].duration_min + svc[0].d,
        'длительность обязана вырасти ровно на добавленную услугу');
      assert.equal(after2[0].price_kzt, before[0].price_kzt + svc[0].p,
        'цена обязана вырасти ровно на добавленную услугу');
      assert.ok(new Date(after2[0].ends_at) > new Date(before[0].ends_at),
        'визит должен заканчиваться позже');
      assert.match(after2[0].services, / \+ /, 'в составе должно быть две услуги');
    });
  });

  test('состав визита обновляется, а не подменяется', { skip: skip() }, async () => {
    await inRollback(async (c) => {
      const s = await seedBooking(c, { phone: '+77019000002' });
      if (!s) return;
      await c.query(`SELECT out_duration_min AS duration_min, out_price_kzt AS price_kzt,
                out_ends_at AS ends_at, out_services AS services
           FROM add_service_to_appointment($1, 5)`, [s.apptId]);
      const { rows } = await c.query(
        `SELECT count(*)::int n FROM appointment_services WHERE appointment_id = $1`, [s.apptId]);
      assert.equal(rows[0].n, 2);
    });
  });

  test('вторая запись НЕ создаётся', { skip: skip() }, async () => {

    await inRollback(async (c) => {
      const s = await seedBooking(c, { phone: '+77019000003' });
      if (!s) return;
      await c.query(`SELECT out_duration_min AS duration_min, out_price_kzt AS price_kzt,
                out_ends_at AS ends_at, out_services AS services
           FROM add_service_to_appointment($1, 5)`, [s.apptId]);
      const { rows } = await c.query(
        `SELECT count(*)::int n FROM appointments
          WHERE client_id = $1 AND status IN ('pending','confirmed')`, [s.clientId]);
      assert.equal(rows[0].n, 1, 'у клиентки должна остаться ровно одна запись');
    });
  });

  test('одну услугу дважды добавить нельзя', { skip: skip() }, async () => {
    await inRollback(async (c) => {
      const s = await seedBooking(c, { phone: '+77019000004' });
      if (!s) return;
      await c.query(`SELECT out_duration_min AS duration_min, out_price_kzt AS price_kzt,
                out_ends_at AS ends_at, out_services AS services
           FROM add_service_to_appointment($1, 5)`, [s.apptId]);
      await assert.rejects(
        () => c.query(`SELECT out_duration_min AS duration_min, out_price_kzt AS price_kzt,
                out_ends_at AS ends_at, out_services AS services
           FROM add_service_to_appointment($1, 5)`, [s.apptId]),
        (e) => /SERVICE_ALREADY_ADDED/.test(e.message));
    });
  });

  test('удлинившийся визит не налезает на соседнюю запись', { skip: skip() }, async () => {

    await inRollback(async (c) => {
      const s = await seedBooking(c, { serviceId: 1, dayOffset: 5, phone: '+77019000005' });
      if (!s) return;

      const { rows: a1 } = await c.query(
        `SELECT ends_at, buffer_min FROM appointments WHERE id = $1`, [s.apptId]);
      const nextStart = new Date(new Date(a1[0].ends_at).getTime() + a1[0].buffer_min * 60000);

      const { rows: cl2 } = await c.query(
        `INSERT INTO clients (phone_e164, primary_jid, jids, name)
         VALUES ('+77019000015','n@test',ARRAY['n@test'],'Соседка') RETURNING id`);
      const { rows: b2 } = await c.query(
        `SELECT book_appointment_multi($1,$2,ARRAY[5]::int[],$3::timestamptz,'panel','') AS id`,
        [cl2[0].id, s.master_id, nextStart.toISOString()]).catch(() => ({ rows: [] }));
      if (!b2.length) return;

      await assert.rejects(
        () => c.query(`SELECT * FROM add_service_to_appointment($1, 6)`, [s.apptId]),
        (e) => e.code === '23P01' || /DOESNT_FIT_SHIFT/.test(e.message),
        'удлинение обязано отклоняться, если налезает на следующую клиентку');
    });
  });

  test('к отменённой записи добавить нельзя', { skip: skip() }, async () => {
    await inRollback(async (c) => {
      const s = await seedBooking(c, { phone: '+77019000006' });
      if (!s) return;
      await c.query(`UPDATE appointments SET status = 'cancelled' WHERE id = $1`, [s.apptId]);
      await assert.rejects(
        () => c.query(`SELECT out_duration_min AS duration_min, out_price_kzt AS price_kzt,
                out_ends_at AS ends_at, out_services AS services
           FROM add_service_to_appointment($1, 5)`, [s.apptId]),
        (e) => /APPT_NOT_ACTIVE/.test(e.message));
    });
  });

  test('несуществующая запись — понятная ошибка', { skip: skip() }, async () => {
    await inRollback(async (c) => {
      await assert.rejects(
        () => c.query(`SELECT * FROM add_service_to_appointment(999999, 5)`),
        (e) => /APPT_NOT_FOUND/.test(e.message));
    });
  });
});
