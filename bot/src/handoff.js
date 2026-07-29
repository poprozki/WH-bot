import { q, one } from './db.js';
import { log } from './log.js';

export {
  HUMAN_RE, MEDICAL_RE, PAUSE, isOwnerTakeover, isResumeCommand,
} from './handoff-rules.js';

export async function pauseBot(clientId, minutes, reason) {
  await q(
    `UPDATE clients
        SET bot_paused_until = GREATEST(COALESCE(bot_paused_until, now()), now())
                               + make_interval(mins => $2)
      WHERE id = $1`,
    [clientId, minutes]
  );
  log.info('бот заглушен в чате', { clientId, minutes, reason });
}

export async function resumeBot(clientId) {
  await q(`UPDATE clients SET bot_paused_until = NULL WHERE id = $1`, [clientId]);
  log.info('бот снова отвечает в чате', { clientId });
}

export async function isPaused(clientId) {
  const r = await one(
    `SELECT (bot_paused_until IS NOT NULL AND bot_paused_until > now()) AS paused,
            blocked
       FROM clients WHERE id = $1`,
    [clientId]
  );
  if (!r) return false;
  return r.paused || r.blocked;
}
