import { q, one } from './db.js';
import { cfg } from './config.js';
import { log } from './log.js';
import { draftMode, stripNagging, stripGreeting } from './conversation-rules.js';

export { draftMode, stripNagging, stripGreeting };

export async function loadDraft(clientId) {
  return one(
    `SELECT * FROM booking_drafts WHERE client_id = $1 AND archived_at IS NULL`,
    [clientId]
  );
}

export async function saveDraft(clientId, patch) {
  await q(
    `INSERT INTO booking_drafts (client_id, service_ids, master_id, wanted_date, note, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (client_id) DO UPDATE
       SET service_ids = COALESCE(EXCLUDED.service_ids, booking_drafts.service_ids),
           master_id   = COALESCE(EXCLUDED.master_id,   booking_drafts.master_id),
           wanted_date = COALESCE(EXCLUDED.wanted_date, booking_drafts.wanted_date),
           note        = COALESCE(EXCLUDED.note,        booking_drafts.note),
           archived_at = NULL,
           updated_at  = now()`,
    [clientId, patch.serviceIds || null, patch.masterId || null,
     patch.wantedDate || null, patch.note || null]
  );
}

export async function archiveDraft(clientId) {
  await q(
    `UPDATE booking_drafts SET archived_at = now() WHERE client_id = $1 AND archived_at IS NULL`,
    [clientId]
  );
}

export async function bookingsSnapshot(clientId) {
  const rows = await q(
    `SELECT a.id, a.starts_at, a.duration_min, a.price_kzt,
            m.name AS master,
            (SELECT string_agg(s.name, ' + ' ORDER BY x.position)
               FROM appointment_services x JOIN services s ON s.id = x.service_id
              WHERE x.appointment_id = a.id) AS services
       FROM appointments a
       JOIN masters m ON m.id = a.master_id
      WHERE a.client_id = $1
        AND a.status IN ('pending','confirmed')
        AND a.starts_at > now() - interval '2 hours'
      ORDER BY a.starts_at
      LIMIT 5`,
    [clientId]
  );
  return rows;
}

export function snapshotAsToolResult(rows) {
  if (!rows.length) return null;
  return {
    активные_записи: rows.map((r) => ({
      id: r.id,
      услуги: r.services,
      время: new Date(r.starts_at).toLocaleTimeString('ru-RU', {
        hour: '2-digit', minute: '2-digit', timeZone: cfg.tz,
      }),
      starts_at: r.starts_at,
      мастер: r.master,
      цена: `${Number(r.price_kzt).toLocaleString('ru-RU')} ₸`,
    })),
  };
}

export async function slotsAroundBooking(appt) {
  if (!appt) return null;
  const day = new Date(appt.starts_at)
    .toLocaleDateString('en-CA', { timeZone: cfg.tz });

  const rows = await q(
    `SELECT master_name, starts_at, price_kzt
       FROM free_slots(
         (SELECT service_id FROM appointments WHERE id = $1),
         $2::date,
         (SELECT master_id FROM appointments WHERE id = $1))
      ORDER BY starts_at LIMIT 12`,
    [appt.id, day]
  );
  if (!rows.length) return null;

  return {
    свободное_время_для_переноса: {
      номер_записи: appt.id,
      дата: day,
      варианты: rows.map((r) => ({
        время: new Date(r.starts_at).toLocaleTimeString('ru-RU', {
          hour: '2-digit', minute: '2-digit', timeZone: cfg.tz,
        }),
        starts_at: r.starts_at,
        мастер: r.master_name,
      })),
    },
  };
}

export function snapshotText(rows) {
  if (!rows.length) return 'Действующих записей у неё сейчас нет.';
  const fmt = (r) => {
    const d = new Date(r.starts_at);
    return `${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', weekday: 'long', timeZone: cfg.tz })} ` +
           `в ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: cfg.tz })} — ` +
           `${r.services}, мастер ${r.master}, ${Number(r.price_kzt).toLocaleString('ru-RU')} ₸ (номер записи ${r.id})`;
  };
  return `ОНА УЖЕ ЗАПИСАНА:\n${rows.map(fmt).join('\n')}\n` +
    'Не спрашивай о том, что здесь написано. Если она уточняет время, мастера или цену — отвечай сразу отсюда.';
}

export async function greetingAllowed(clientId) {
  const r = await one(
    `SELECT last_greeted_at,
            (last_greeted_at IS NULL
             OR (last_greeted_at AT TIME ZONE $2)::date < (now() AT TIME ZONE $2)::date)
            AND (last_greeted_at IS NULL OR last_greeted_at < now() - interval '6 hours')
            AS allowed
       FROM clients WHERE id = $1`,
    [clientId, cfg.tz]
  );
  return r?.allowed !== false;
}

export async function markGreeted(clientId) {
  await q(`UPDATE clients SET last_greeted_at = now() WHERE id = $1`, [clientId]);
}

export async function clarifyStreak(clientId) {
  const r = await one(`SELECT clarify_streak FROM clients WHERE id = $1`, [clientId]);
  return r?.clarify_streak ?? 0;
}

export async function bumpClarify(clientId, progressed) {
  await q(
    `UPDATE clients SET clarify_streak = CASE WHEN $2 THEN 0 ELSE clarify_streak + 1 END
      WHERE id = $1`,
    [clientId, progressed]
  );
}
