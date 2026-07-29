import { q, tx } from './db.js';
import { enqueueOut } from './outbox.js';
import { cfg } from './config.js';
import { log } from './log.js';

const MAX_PER_RUN = 6;

function inQuietHours(quietFrom, quietTo) {
  const now = new Date();
  const hhmm = now.toLocaleTimeString('ru-RU', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: cfg.tz,
  });
  const cur = hhmm.replace(':', '');
  const from = String(quietFrom).slice(0, 5).replace(':', '');
  const to = String(quietTo).slice(0, 5).replace(':', '');

  return from > to ? (cur >= from || cur < to) : (cur >= from && cur < to);
}

function fmtWhen(iso) {
  const d = new Date(iso);
  return `${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', weekday: 'long', timeZone: cfg.tz })} в ` +
         `${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: cfg.tz })}`;
}

const T24 = [
  (a) => `Напоминаю о записи!\n\n${a.service}\nЗавтра, ${a.when}\nМастер: ${a.master}\n\nВсё в силе? Если планы изменились, напишите — перенесём.`,
  (a) => `Здравствуйте! Ждём вас завтра 💅\n\n${a.service}, ${a.when}\nМастер ${a.master}\n\nЕсли не получается — дайте знать заранее, пожалуйста.`,
  (a) => `Не забудьте: завтра ${a.when} у вас ${a.service.toLowerCase()}, мастер ${a.master}.\n\nПодтвердите, пожалуйста, что придёте 🙂`,
];

const T2 = [
  (a) => `Через пару часов ждём вас — ${a.when.split(' в ')[1]}, мастер ${a.master} 💅`,
  (a) => `Скоро увидимся! Ваша запись сегодня в ${a.when.split(' в ')[1]}.`,
  (a) => `Напоминаю: сегодня в ${a.when.split(' в ')[1]} — ${a.service.toLowerCase()}.`,
];

async function send(kind, rows, templates, column) {
  let sent = 0;
  for (const a of rows) {
    if (sent >= MAX_PER_RUN) break;
    const view = {
      service: a.service,
      master: a.master,
      when: fmtWhen(a.starts_at),
    };
    const tpl = templates[a.id % templates.length];

    try {
      await tx(async (c) => {
        await enqueueOut(c, {
          chatId: a.chat_id,
          clientId: a.client_id,
          body: tpl(view),
          dedupKey: `${kind}:${a.id}`,
        });
        await c.query(`UPDATE appointments SET ${column} = now() WHERE id = $1`, [a.id]);
      }, 'system');
      sent += 1;
    } catch (e) {
      log.error('не удалось поставить напоминание', { apptId: a.id, err: e.message });
    }
  }
  if (sent) log.info('напоминания поставлены в очередь', { kind, count: sent });
  return sent;
}

export async function runReminders() {
  const [settings] = await q(`SELECT quiet_from, quiet_to FROM settings WHERE id`);
  if (!settings) return 0;
  if (inQuietHours(settings.quiet_from, settings.quiet_to)) return 0;

  const base = `
    SELECT a.id, a.starts_at, a.client_id,
           s.name AS service, m.name AS master,
           (SELECT jids[array_length(jids,1)] FROM clients WHERE id = a.client_id) AS chat_id
      FROM appointments a
      JOIN services s ON s.id = a.service_id
      JOIN masters  m ON m.id = a.master_id
      JOIN clients  c ON c.id = a.client_id
     WHERE a.status = 'confirmed'
       AND NOT c.opted_out AND NOT c.blocked`;

  const due24 = await q(
    `${base}
       AND a.reminded_24h_at IS NULL
       AND a.starts_at BETWEEN now() + interval '22 hours' AND now() + interval '26 hours'
     ORDER BY a.starts_at LIMIT $1`,
    [MAX_PER_RUN]
  );

  const due2 = await q(
    `${base}
       AND a.reminded_2h_at IS NULL
       AND a.starts_at BETWEEN now() + interval '90 minutes' AND now() + interval '150 minutes'
     ORDER BY a.starts_at LIMIT $1`,
    [MAX_PER_RUN]
  );

  const n1 = await send('rem24', due24.filter((r) => r.chat_id), T24, 'reminded_24h_at');
  const n2 = await send('rem2', due2.filter((r) => r.chat_id), T2, 'reminded_2h_at');
  return n1 + n2;
}

export async function closeOutPastAppointments() {
  const rows = await q(
    `UPDATE appointments
        SET status = 'done'
      WHERE status = 'confirmed'
        AND ends_at < now() - interval '2 hours'
    RETURNING client_id`
  );
  for (const r of rows) {
    await q(
      `UPDATE clients
          SET visits_count = visits_count + 1, last_visit_at = now()
        WHERE id = $1`,
      [r.client_id]
    );
  }
  return rows.length;
}
