import { pool } from './db.js';
import { runInTenant, runAsAdmin } from './tenant-context.js';
import { log } from './log.js';

export async function withTenant(tenantId, fn, actor = 'system') {
  const id = Number(tenantId);
  if (!Number.isInteger(id) || id <= 0) {

    throw new Error(`withTenant: некорректный tenantId (${tenantId})`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', String(id)]);
    await client.query('SELECT set_config($1, $2, true)', ['app.actor', actor]);

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

export async function tq(tenantId, text, params = [], actor = 'system') {
  return withTenant(tenantId, async (c) => (await c.query(text, params)).rows, actor);
}

export async function tone(tenantId, text, params = [], actor = 'system') {
  const rows = await tq(tenantId, text, params, actor);
  return rows[0] ?? null;
}

export async function asPlatformAdmin(fn, reason = '') {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.admin', 'on']);

    log.debug('служебный доступ ко всем арендаторам', { reason });
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

export async function assertIsolation() {

  const leaked = await withTenant(999999, async (c) => {
    const { rows } = await c.query('SELECT count(*)::int AS n FROM clients');
    return rows[0].n;
  });
  if (leaked !== 0) {
    throw new Error(
      `ИЗОЛЯЦИЯ АРЕНДАТОРОВ НЕ РАБОТАЕТ: под несуществующим арендатором видно ${leaked} клиенток. ` +
      'Проверьте, что RLS включён и что роль приложения не имеет BYPASSRLS.'
    );
  }

  const { rows } = await pool.query('SELECT id FROM tenants ORDER BY id LIMIT 1');
  if (rows.length) {
    const visible = await withTenant(rows[0].id, async (c) => {
      const r = await c.query('SELECT count(*)::int AS n FROM services');
      return r.rows[0].n;
    });
    log.info('изоляция арендаторов проверена', { tenantId: rows[0].id, услуг: visible });
  }
  return true;
}
