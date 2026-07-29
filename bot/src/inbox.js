import { q, one, tx } from './db.js';
import { cfg } from './config.js';
import { log } from './log.js';

export async function enqueue({ chatId, clientId, msgId, body, kind = 'text' }) {
  const rows = await q(
    `INSERT INTO inbox_buffer (channel, chat_id, client_id, msg_id, body, kind)
     VALUES ('whatsapp', $1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, channel, msg_id) DO NOTHING
     RETURNING id`,
    [chatId, clientId, msgId, body, kind]
  );
  if (rows.length === 0) {
    log.debug('duplicate webhook ignored', { msgId });
    return false;
  }
  return true;
}

export async function claimReady() {
  const quiet = Math.round(cfg.debounce.quietMs / 1000);
  const hard = Math.round(cfg.debounce.hardCapMs / 1000);

  return tx(async (c) => {
    const { rows: ready } = await c.query(
      `SELECT chat_id
         FROM inbox_buffer
        WHERE claimed_at IS NULL
        GROUP BY chat_id
       HAVING max(received_at) < now() - make_interval(secs => $1)
           OR min(received_at) < now() - make_interval(secs => $2)
        LIMIT 20`,
      [quiet, hard]
    );
    if (ready.length === 0) return [];

    const chatIds = ready.map((r) => r.chat_id);
    const { rows } = await c.query(
      `UPDATE inbox_buffer
          SET claimed_at = now()
        WHERE chat_id = ANY($1) AND claimed_at IS NULL
      RETURNING id, chat_id, client_id, msg_id, body, kind, received_at`,
      [chatIds]
    );

    const byChat = new Map();
    for (const r of rows.sort((a, b) => (a.received_at < b.received_at ? -1 : 1))) {
      if (!byChat.has(r.chat_id)) byChat.set(r.chat_id, []);
      byChat.get(r.chat_id).push(r);
    }
    return [...byChat.entries()].map(([chatId, items]) => ({ chatId, items }));
  });
}

export async function release(ids) {
  if (!ids.length) return;
  await q(`DELETE FROM inbox_buffer WHERE id = ANY($1)`, [ids]);
}

export async function requeue(ids) {
  if (!ids.length) return;
  await q(`UPDATE inbox_buffer SET claimed_at = NULL WHERE id = ANY($1)`, [ids]);
}

export async function reapStale() {
  const r = await one(`SELECT reap_stale_claims('2 minutes'::interval) AS n`);
  const n = Number(r?.n || 0);
  if (n > 0) log.warn('вернул в очередь зависшие сообщения', { count: n });
  return n;
}

export function joinBurst(items) {
  return items
    .map((i) => {
      if (i.kind === 'voice') return `[голосовое, расшифровка] ${i.body}`;
      if (i.kind === 'image') return `[фото] ${i.body || 'без подписи'}`;
      return i.body;
    })
    .filter((s) => s && s.trim())
    .join('\n');
}
