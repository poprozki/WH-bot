import webpush from 'web-push';
import { q } from './db.js';
import { cfg } from './config.js';
import { log } from './log.js';

const alertTimestamps = new Map();

function throttled(key, windowMs = 30 * 60_000) {
  const last = alertTimestamps.get(key) || 0;
  if (Date.now() - last < windowMs) return true;
  alertTimestamps.set(key, Date.now());
  return false;
}

export async function devAlert(text, { key = null, urgent = false } = {}) {
  if (key && throttled(key)) return;
  log.warn('DEV ALERT', { text: String(text).slice(0, 200) });

  const { telegramToken, telegramChatId } = cfg.devAlerts;
  if (!telegramToken || !telegramChatId) return;

  try {
    await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegramChatId,
        text: `${urgent ? '🚨 ' : ''}[salon-bot] ${text}`,
        disable_notification: !urgent,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {

    log.error('не удалось отправить алерт разработчику', { err: e.message });
  }
}

let pushReady = false;
if (cfg.push.publicKey && cfg.push.privateKey) {
  webpush.setVapidDetails(cfg.push.subject, cfg.push.publicKey, cfg.push.privateKey);
  pushReady = true;
} else {
  log.warn('VAPID-ключи не заданы, push владелице отключён');
}

export async function notifyOwner({ title, body, url = '/', urgent = false }) {
  if (!pushReady) return;

  const subs = await q(
    `SELECT ps.id, ps.endpoint, ps.p256dh, ps.auth
       FROM push_subscriptions ps
       JOIN panel_users u ON u.id = ps.user_id
      WHERE u.role = 'owner' AND ps.fail_count < 5`
  );

  const payload = JSON.stringify({ title, body, url, urgent });

  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        { TTL: urgent ? 3600 : 86400, urgency: urgent ? 'high' : 'normal' }
      );
      await q(`UPDATE push_subscriptions SET last_ok_at = now(), fail_count = 0 WHERE id = $1`, [s.id]);
    } catch (e) {

      const gone = e.statusCode === 404 || e.statusCode === 410;
      if (gone) {
        await q(`DELETE FROM push_subscriptions WHERE id = $1`, [s.id]);
        log.info('удалена мёртвая push-подписка', { id: s.id });
      } else {
        await q(`UPDATE push_subscriptions SET fail_count = fail_count + 1 WHERE id = $1`, [s.id]);
        log.warn('push не доставлен', { id: s.id, code: e.statusCode });
      }
    }
  }

  if (subs.length === 0) {
    await devAlert(
      'У владелицы нет ни одной активной push-подписки — уведомления до неё не доходят. ' +
      'Возможно, удалила иконку с домашнего экрана.',
      { key: 'no-push-subs' }
    );
  }
}
