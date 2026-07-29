import { pool } from './db.js';
import { asPlatformAdmin, withTenant } from './tenant-db.js';
import { runAsAdmin } from './tenant-context.js';
import { slugFromHost } from './host.js';
import { log } from './log.js';

export { slugFromHost };

const cache = new Map();
const TTL_MS = 30_000;

export function invalidateTenantCache(slug = null) {
  if (slug) cache.delete(slug); else cache.clear();
}

async function loadBySlug(slug) {
  const hit = cache.get(slug);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.row;

  const row = await asPlatformAdmin(async (c) => {
    const { rows } = await c.query(
      `SELECT id, slug, name, status, wa_session, timezone,
              llm_daily_limit_usd, llm_spent_today_usd, llm_spent_date, msg_hourly_limit
         FROM tenants WHERE slug = $1`,
      [slug]
    );
    return rows[0] || null;
  }, 'поиск салона по адресу');
  cache.set(slug, { row, at: Date.now() });
  return row;
}

export async function tenantBySession(waSession) {
  return asPlatformAdmin(async (c) => {
    const { rows } = await c.query(
      `SELECT id, slug, name, status, wa_session, timezone FROM tenants WHERE wa_session = $1`,
      [waSession]);
    return rows[0] || null;
  }, 'поиск салона по сессии');
}

export async function listTenants() {
  return asPlatformAdmin(async (c) => {
    const { rows } = await c.query(`
      SELECT t.*,
             (SELECT count(*) FROM clients WHERE tenant_id = t.id)::int AS clients,
             (SELECT count(*) FROM appointments
               WHERE tenant_id = t.id AND status IN ('confirmed','done')
                 AND starts_at > now() - interval '30 days')::int AS appts30,
             (SELECT max(at) FROM messages WHERE tenant_id = t.id) AS last_msg
        FROM tenants t
       ORDER BY t.id`);
    return rows;
  }, 'список салонов для консоли');
}

export function tenantResolver({ baseDomain, singleTenantFallback = true } = {}) {
  return async (req, res, next) => {
    try {
      let tenant = null;
      let impersonating = false;

      const slug = slugFromHost(req.hostname || req.get('host'), baseDomain);
      if (slug) {
        tenant = await loadBySlug(slug);
        if (!tenant) {

          log.warn('запрос на неизвестный поддомен', { slug });
          return res.status(404).send('Салон не найден');
        }
      }

      if (!tenant && req.user?.role === 'dev') {
        const want = String(req.query.t || req.cookies?.devTenant || '').trim();
        if (want) {
          tenant = await loadBySlug(want);
          impersonating = Boolean(tenant);
        }
      }

      if (!tenant && singleTenantFallback) {
        const rows = await asPlatformAdmin(async (c) => {
          const r = await c.query(
            `SELECT id, slug, name, status, wa_session, timezone FROM tenants ORDER BY id LIMIT 2`);
          return r.rows;
        }, 'режим одного салона');
        if (rows.length === 1) tenant = rows[0];
      }

      if (!tenant) {
        req.tenant = null;
        return next();
      }

      if (tenant.status === 'suspended' || tenant.status === 'closed') {
        return res.status(423).send('Салон приостановлен. Свяжитесь с поддержкой.');
      }

      req.tenant = tenant;
      req.impersonating = impersonating;
      if (impersonating) {
        log.info('просмотр от имени салона', { slug: tenant.slug, by: req.user?.email });
      }
      next();
    } catch (e) {
      log.error('ошибка определения салона', { err: e.message });
      res.status(500).send('Ошибка');
    }
  };
}

export function requireTenant(req, res, next) {
  if (!req.tenant) return res.status(400).send('Салон не определён');
  next();
}

export async function createTenant({ slug, name, copyFromTenantId = null }) {
  if (!/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/.test(slug)) {
    throw new Error('Недопустимый адрес: только латиница, цифры и дефис, 3-32 символа');
  }

  const tenant = await asPlatformAdmin(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO tenants (slug, name, wa_session, status)
       VALUES ($1, $2, $1, 'trial')
       RETURNING *`,
      [slug, name]
    );
    return rows[0];
  }, `создание салона ${slug}`);

  await withTenant(tenant.id, async (c) => {
    await c.query(`INSERT INTO settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [tenant.id]);

    if (copyFromTenantId) {

      await c.query(`
        INSERT INTO services (tenant_id, name, aliases, duration_min, price_kzt, active, sort_order)
        SELECT $1, name, aliases, duration_min, price_kzt, active, sort_order
          FROM services WHERE tenant_id = $2`, [tenant.id, copyFromTenantId]);
      await c.query(`
        INSERT INTO masters (tenant_id, name, color, active)
        SELECT $1, name, color, active FROM masters WHERE tenant_id = $2`,
        [tenant.id, copyFromTenantId]);
    } else {
      await c.query(`
        INSERT INTO services (tenant_id, name, aliases, duration_min, price_kzt, sort_order) VALUES
          ($1,'Маникюр без покрытия', ARRAY['маникюр','без покрытия'], 60, 6000, 10),
          ($1,'Маникюр + гель-лак', ARRAY['гель','гель-лак','шеллак','покрытие'], 90, 11000, 20),
          ($1,'Наращивание ногтей', ARRAY['наращивание','нарастить'], 180, 20000, 30),
          ($1,'Снятие покрытия', ARRAY['снятие','снять'], 30, 3000, 40),
          ($1,'Педикюр', ARRAY['педикюр','ноги'], 90, 13000, 50)`, [tenant.id]);
      await c.query(
        `INSERT INTO masters (tenant_id, name) VALUES ($1, 'Мастер')`, [tenant.id]);
    }

    await c.query(`
      INSERT INTO master_services (tenant_id, master_id, service_id)
      SELECT $1, m.id, s.id FROM masters m, services s
       WHERE m.tenant_id = $1 AND s.tenant_id = $1
      ON CONFLICT DO NOTHING`, [tenant.id]);

    await c.query(`
      INSERT INTO shifts (tenant_id, master_id, weekday, starts_time, ends_time)
      SELECT $1, m.id, d, '10:00'::time, '20:00'::time
        FROM masters m, generate_series(1,6) d
       WHERE m.tenant_id = $1
      ON CONFLICT DO NOTHING`, [tenant.id]);
  }, 'system');

  invalidateTenantCache();
  log.info('создан новый салон', { slug, id: tenant.id });
  return tenant;
}

export async function deleteTenant(id, confirmSlug) {
  return asPlatformAdmin(async (c) => {
    const { rows } = await c.query(`SELECT slug FROM tenants WHERE id = $1`, [id]);
    if (!rows[0]) throw new Error('Салон не найден');
    if (rows[0].slug !== confirmSlug) {
      throw new Error('Название для подтверждения не совпало — удаление отменено');
    }
    await c.query(`DELETE FROM tenants WHERE id = $1`, [id]);
    invalidateTenantCache();
    log.warn('салон удалён вместе со всеми данными', { id, slug: confirmSlug });
    return true;
  }, `удаление салона ${confirmSlug}`);
}

const PRICE = { cachedIn: 0.0028, in: 0.14, out: 0.28 };

export async function trackSpend(tenantId, usage) {
  const cached = usage?.prompt_tokens_details?.cached_tokens || 0;
  const inTok = (usage?.prompt_tokens || 0) - cached;
  const outTok = usage?.completion_tokens || 0;
  const usd = (cached * PRICE.cachedIn + inTok * PRICE.in + outTok * PRICE.out) / 1_000_000;

  await pool.query(`
    UPDATE tenants
       SET llm_spent_today_usd = CASE WHEN llm_spent_date = CURRENT_DATE
                                      THEN llm_spent_today_usd + $2 ELSE $2 END,
           llm_spent_date = CURRENT_DATE
     WHERE id = $1`, [tenantId, usd]);
  return usd;
}

export async function spendAllowed(tenantId) {
  const { rows } = await pool.query(
    `SELECT llm_spent_today_usd, llm_daily_limit_usd, llm_spent_date
       FROM tenants WHERE id = $1`, [tenantId]);
  const t = rows[0];
  if (!t) return false;
  const spent = t.llm_spent_date === new Date().toISOString().slice(0, 10)
    ? Number(t.llm_spent_today_usd) : 0;
  return spent < Number(t.llm_daily_limit_usd);
}
