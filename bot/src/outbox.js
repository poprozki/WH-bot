import { q, one } from './db.js';
import { waha } from './waha.js';
import { log, maskPhone } from './log.js';
import { devAlert } from './alerts.js';

const MAX_ATTEMPTS = 6;

export async function enqueueOut(client, { chatId, clientId, body, kind = 'text', mediaPath = null, sendAfter = null, dedupKey = null }) {
  const sql = `
    INSERT INTO outbox (chat_id, client_id, kind, body, media_path, send_after, dedup_key)
    VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()), $7)
    ON CONFLICT (tenant_id, dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING
    RETURNING id`;
  const params = [chatId, clientId, kind, body, mediaPath, sendAfter, dedupKey];
  const res = client ? await client.query(sql, params) : { rows: await q(sql, params) };
  return res.rows[0]?.id ?? null;
}

export async function drainOutbox() {
  const rows = await q(
    `UPDATE outbox
        SET attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM outbox
         WHERE sent_at IS NULL
           AND attempts < $1
           AND send_after <= now()
         ORDER BY send_after
         LIMIT 10
         FOR UPDATE SKIP LOCKED
      )
    RETURNING id, chat_id, client_id, kind, body, media_path, attempts`,
    [MAX_ATTEMPTS]
  );

  for (const m of rows) {
    try {
      let res;
      if (m.kind === 'image' && m.media_path) {
        res = await waha.sendImage(m.chat_id, m.media_path, m.body || '');
      } else {
        res = await waha.sendText(m.chat_id, m.body);
      }
      await q(
        `UPDATE outbox SET sent_at = now(), wa_message_id = $2, last_error = NULL WHERE id = $1`,
        [m.id, res?.id?._serialized || res?.id || null]
      );
    } catch (e) {
      const willRetry = m.attempts < MAX_ATTEMPTS;
      await q(`UPDATE outbox SET last_error = $2 WHERE id = $1`, [m.id, String(e.message).slice(0, 500)]);
      log.warn('не удалось отправить сообщение', { id: m.id, attempts: m.attempts, willRetry, err: e.message });

      if (!willRetry) {

        await devAlert(
          `❌ Не доставлено после ${MAX_ATTEMPTS} попыток\n` +
          `chat: ${maskPhone(m.chat_id)}\n` +
          `ошибка: ${e.message}`
        );
      }

      const delaySec = Math.min(30 * 2 ** (m.attempts - 1), 900);
      await q(
        `UPDATE outbox SET send_after = now() + make_interval(secs => $2) WHERE id = $1`,
        [m.id, delaySec]
      );
    }
  }
  return rows.length;
}

export async function updateAck(waMessageId, ack) {
  if (!waMessageId) return;
  const row = await one(
    `UPDATE outbox SET ack = $2 WHERE wa_message_id = $1 RETURNING id, chat_id, body`,
    [waMessageId, ack]
  );
  if (row && ack === -1) {
    log.error('WhatsApp отверг сообщение', { id: row.id });
    await devAlert(`⚠️ WhatsApp вернул ack=-1 (сообщение не принято)\nchat: ${maskPhone(row.chat_id)}`);
  }
}

export async function stuckCount() {
  const r = await one(
    `SELECT count(*)::int AS n FROM outbox
      WHERE sent_at IS NULL AND created_at < now() - interval '5 minutes'`
  );
  return r?.n ?? 0;
}
