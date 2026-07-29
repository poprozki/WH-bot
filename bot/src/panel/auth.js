import { createRemoteJWKSet, jwtVerify } from 'jose';
import { q, one } from '../db.js';
import { runAsAdmin } from '../tenant-context.js';
import { cfg, isProd } from '../config.js';
import { log } from '../log.js';

const teamDomain = process.env.CF_ACCESS_TEAM_DOMAIN || '';
const audience = process.env.CF_ACCESS_AUD || '';

const JWKS = teamDomain
  ? createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`))
  : null;

const devAuth = process.env.PANEL_DEV_AUTH === '1';
if (devAuth && isProd) {
  throw new Error(
    'PANEL_DEV_AUTH=1 при NODE_ENV=production. Это открытая панель с телефонами клиенток. Отказываюсь стартовать.'
  );
}
if (devAuth) {
  log.warn('ПАНЕЛЬ БЕЗ АУТЕНТИФИКАЦИИ (PANEL_DEV_AUTH=1). Только для локальной разработки.');
}

export async function requireAuth(req, res, next) {
  try {
    let email;

    if (devAuth) {
      email = process.env.PANEL_DEV_EMAIL || 'dev@localhost';
    } else {
      if (!JWKS || !audience) {
        log.error('Cloudflare Access не настроен: нет CF_ACCESS_TEAM_DOMAIN или CF_ACCESS_AUD');
        return res.status(500).send('Панель не настроена');
      }
      const token = req.get('Cf-Access-Jwt-Assertion');
      if (!token) {

        log.warn('запрос в панель без токена Access');
        return res.status(403).send('Доступ запрещён');
      }
      const { payload } = await jwtVerify(token, JWKS, {
        issuer: `https://${teamDomain}`,
        audience,
      });
      email = String(payload.email || '').toLowerCase();
    }

    if (!email) return res.status(403).send('Доступ запрещён');

    const identity = await runAsAdmin('проверка доступа в панель', async () => {
      let row = await one(
        `SELECT email, display_name, role, master_id, tenant_id
           FROM panel_identities WHERE email = $1 ORDER BY tenant_id LIMIT 1`,
        [email]
      );
      if (row) {
        await q(`UPDATE panel_identities SET last_seen_at = now() WHERE email = $1`, [email]);
        return row;
      }

      const count = await one(`SELECT count(*)::int AS n FROM panel_identities`);
      if (count.n > 0) return null;

      const first = await one(`SELECT id FROM tenants ORDER BY id LIMIT 1`);
      if (!first) return null;
      row = await one(
        `INSERT INTO panel_identities (tenant_id, email, display_name, role)
         VALUES ($1, $2, $3, 'owner')
         RETURNING email, display_name, role, master_id, tenant_id`,
        [first.id, email, email.split('@')[0]]
      );
      log.info('создана первая учётная запись панели', { email });
      return row;
    });

    if (!identity) {

      log.warn('вход в панель от неизвестной почты', { email });
      return res.status(403).send('Доступ запрещён');
    }

    if (devAuth) identity.role = 'dev';

    req.user = identity;
    next();
  } catch (e) {
    log.warn('проверка токена Access не прошла', { err: e.message });
    res.status(403).send('Доступ запрещён');
  }
}

export function sameSiteOnly(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();

  const site = req.get('Sec-Fetch-Site');
  if (site) {
    if (site === 'same-origin' || site === 'none') return next();
    log.warn('отбит межсайтовый запрос', { site, path: req.path });
    return res.status(403).send('Запрос отклонён');
  }

  const origin = req.get('Origin');
  if (origin && origin !== cfg.panel.origin) {
    log.warn('отбит запрос с чужого источника', { origin });
    return res.status(403).send('Запрос отклонён');
  }
  return next();
}
