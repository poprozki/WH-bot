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

const RESOLVE = `
  WITH cand AS (
    SELECT s.id, s.name, s.sort_order,
           CASE
             WHEN lower(s.name) = $1 THEN 1000
             WHEN $1 = ANY(SELECT lower(a) FROM unnest(s.aliases) a) THEN 900
             ELSE 0
           END
           + COALESCE((SELECT max(length(a)) FROM unnest(s.aliases) a
                        WHERE $1 LIKE '%' || lower(a) || '%'), 0)
           + CASE WHEN lower(s.name) LIKE '%' || $1 || '%' THEN 50 ELSE 0 END
           AS score
      FROM services s WHERE s.active
  )
  SELECT name FROM cand WHERE score > 0 ORDER BY score DESC, sort_order LIMIT 1`;

async function resolve(phrase) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id','1',true)");
    const { rows } = await c.query(RESOLVE, [phrase.toLowerCase()]);
    return rows[0]?.name ?? null;
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}

describe('специфичность важнее порядка в списке', () => {
  test('«маникюр с гель-лаком» -> покрытие, а не голый маникюр', { skip: skip() }, async () => {
    const r = await resolve('маникюр с гель-лаком');
    assert.match(r || '', /гель-лак/i,
      `ожидали услугу с покрытием, получили «${r}» — это потеря денег салона`);
  });

  test('«шеллак» -> покрытие', { skip: skip() }, async () => {
    const r = await resolve('шеллак');
    assert.match(r || '', /гель-лак/i);
  });

  test('«хочу гель» -> покрытие', { skip: skip() }, async () => {
    const r = await resolve('хочу гель');
    assert.match(r || '', /гель-лак/i);
  });

  test('«маникюр» без уточнений -> базовый маникюр', { skip: skip() }, async () => {

    const r = await resolve('маникюр');
    assert.ok(r, 'услуга должна найтись');
    assert.match(r, /маникюр/i);
  });

  test('«педикюр» не путается с маникюром', { skip: skip() }, async () => {
    const r = await resolve('педикюр');
    assert.match(r || '', /педикюр/i);
  });

  test('«наращивание» -> наращивание', { skip: skip() }, async () => {
    const r = await resolve('хочу наращивание ногтей');
    assert.match(r || '', /наращивание/i);
  });

  test('«снять покрытие» -> снятие', { skip: skip() }, async () => {
    const r = await resolve('снять покрытие');
    assert.ok(r, 'услуга должна найтись');
  });

  test('бессмыслица не находит ничего', { skip: skip() }, async () => {
    assert.equal(await resolve('квантовая физика'), null);
  });
});
