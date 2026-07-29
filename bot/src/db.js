import pg from 'pg';
import { cfg } from './config.js';
import { currentTenantId, currentActor, isAdminContext } from './tenant-context.js';

pg.types.setTypeParser(1184, (v) => v);
pg.types.setTypeParser(1114, (v) => v);
pg.types.setTypeParser(20, (v) => parseInt(v, 10));

export const pool = new pg.Pool({
  connectionString: cfg.db.url,
  max: cfg.db.max,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  application_name: 'salon-bot',

  options: `-c timezone=${cfg.tz}`,
});

pool.on('error', (err) => {
  console.error(JSON.stringify({ lvl: 'error', msg: 'pg pool error', err: err.message }));
});

async function bindContext(client) {
  const tenantId = currentTenantId();
  const actor = currentActor();

  if (isAdminContext()) {
    await client.query('SELECT set_config($1, $2, true)', ['app.admin', 'on']);
  } else {

    await client.query('SELECT set_config($1, $2, true)',
      ['app.tenant_id', String(tenantId ?? 0)]);
  }
  await client.query('SELECT set_config($1, $2, true)', ['app.actor', actor]);
}

export async function q(text, params = []) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await bindContext(client);
    const res = await client.query(text, params);
    await client.query('COMMIT');
    return res.rows;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function one(text, params = []) {
  const rows = await q(text, params);
  return rows[0] ?? null;
}

export async function tx(fn, actor = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await bindContext(client);
    if (actor) {
      await client.query('SELECT set_config($1, $2, true)', ['app.actor', actor]);
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export function isSlotTaken(err) {
  return err?.code === '23P01';
}

export function appError(err) {
  const m = err?.message || '';
  for (const code of [
    'SLOT_OUTSIDE_HOURS', 'TOO_SOON', 'TOO_FAR', 'SERVICE_NOT_FOUND',
    'APPT_NOT_FOUND', 'APPT_NOT_ACTIVE', 'CLIENT_BLOCKED',
  ]) {
    if (m.includes(code)) return code;
  }
  return null;
}

export async function healthy() {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
