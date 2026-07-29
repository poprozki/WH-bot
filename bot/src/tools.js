import { q, one, tx, isSlotTaken, appError } from './db.js';
import { cfg } from './config.js';
import { enqueueOut } from './outbox.js';
import { pauseBot, PAUSE } from './handoff.js';
import { notifyOwner } from './alerts.js';
import { log } from './log.js';

const fmtMoney = (kzt) => `${Number(kzt).toLocaleString('ru-RU')} ₸`;

function fmtDuration(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m} мин`;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

function fmtHours(n) {
  const x = Math.abs(Number(n)) % 100;
  const d = x % 10;
  if (x > 10 && x < 20) return `${n} часов`;
  if (d === 1) return `${n} час`;
  if (d >= 2 && d <= 4) return `${n} часа`;
  return `${n} часов`;
}

function fmtWhen(iso) {
  const d = new Date(iso);
  const date = d.toLocaleDateString('ru-RU', {
    day: 'numeric', month: 'long', weekday: 'short', timeZone: cfg.tz,
  });
  const time = d.toLocaleTimeString('ru-RU', {
    hour: '2-digit', minute: '2-digit', timeZone: cfg.tz,
  });
  return `${date} в ${time}`;
}

export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'list_services',
      description: 'Прайс-лист студии: услуги, длительность и цены. Вызывать, когда спрашивают цену или что есть.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_slots',
      description:
        'Свободное время для записи. Возвращает реальные слоты из расписания. ' +
        'Если вернулся пустой список — свободного времени НЕТ, придумывать нельзя.',
      parameters: {
        type: 'object',
        properties: {
          service: { type: 'string', description: 'Название услуги как её назвала клиентка' },
          date: { type: 'string', description: 'Дата в формате ГГГГ-ММ-ДД' },
          master: { type: 'string', description: 'Имя мастера, если клиентка назвала конкретного. Иначе не указывать.' },
        },
        required: ['service', 'date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_booking',
      description:
        'Записать клиентку. Вызывать сразу, как только она подтвердила время. ' +
        'Подтверждение клиентке отправится автоматически — своё писать не нужно.',
      parameters: {
        type: 'object',
        properties: {
          services: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Все услуги за этот визит, как их назвала клиентка. ' +
              'Если она просит несколько процедур подряд — перечисли все, ' +
              'время и цена сложатся автоматически.',
          },
          master: { type: 'string', description: 'Имя мастера из результата find_slots' },
          starts_at: { type: 'string', description: 'Точное время начала в формате ISO из find_slots' },
          client_name: { type: 'string', description: 'Имя клиентки — ТОЛЬКО если она сама его назвала' },
        },
        required: ['services', 'master', 'starts_at'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'my_bookings',
      description: 'Действующие записи этой клиентки. Вызывать при вопросах «когда я записана», переносе и отмене.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_booking',
      description: 'Отменить запись клиентки. Перед вызовом обязательно уточнить, какую именно, если их несколько.',
      parameters: {
        type: 'object',
        properties: {
          appointment_id: { type: 'integer', description: 'id из my_bookings' },
        },
        required: ['appointment_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reschedule_booking',
      description: 'Перенести запись на другое время. Новое время брать только из find_slots.',
      parameters: {
        type: 'object',
        properties: {
          appointment_id: { type: 'integer' },
          starts_at: { type: 'string', description: 'Новое время в формате ISO' },
        },
        required: ['appointment_id', 'starts_at'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_service',
      description:
        'Добавить услугу к УЖЕ СУЩЕСТВУЮЩЕЙ записи клиентки — например «а можно ещё педикюр». ' +
        'Не создаёт новую запись: клиентка придёт один раз. ' +
        'Подтверждение с новым временем и суммой отправится автоматически.',
      parameters: {
        type: 'object',
        properties: {
          service: { type: 'string', description: 'Какую услугу добавить' },
          appointment_id: {
            type: 'integer',
            description: 'Номер записи. Если запись одна — можно не указывать.',
          },
        },
        required: ['service'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'escalate_to_human',
      description:
        'Позвать живого администратора. Вызывать при жалобах, вопросах о здоровье ногтей, ' +
        'нестандартных просьбах, скидках, и всегда когда клиентка недовольна.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Коротко: почему нужен человек' },
          summary: { type: 'string', description: 'Суть обращения в одном предложении' },
        },
        required: ['reason'],
      },
    },
  },
];

async function resolveService(text) {
  if (!text) return null;
  const s = String(text).toLowerCase().trim();
  return one(
    `WITH cand AS (
       SELECT s.id, s.name, s.duration_min, s.price_kzt, s.sort_order,
              CASE
                -- точное совпадение названия
                WHEN lower(s.name) = $1 THEN 1000
                -- точное совпадение синонима
                WHEN $1 = ANY(SELECT lower(a) FROM unnest(s.aliases) a) THEN 900
                ELSE 0
              END
              + COALESCE((
                  -- длина самого длинного синонима, встреченного во фразе
                  SELECT max(length(a)) FROM unnest(s.aliases) a
                   WHERE $1 LIKE '%' || lower(a) || '%'
                ), 0)
              + CASE WHEN lower(s.name) LIKE '%' || $1 || '%' THEN 50 ELSE 0 END
              AS score
         FROM services s
        WHERE s.active
     )
     SELECT id, name, duration_min, price_kzt
       FROM cand
      WHERE score > 0
      ORDER BY score DESC, sort_order
      LIMIT 1`,
    [s]
  );
}

async function resolveMaster(text) {
  if (!text) return null;
  return one(
    `SELECT id, name FROM masters
      WHERE active AND lower(name) LIKE '%' || lower($1) || '%'
      LIMIT 1`,
    [String(text).trim()]
  );
}

export async function runTool(name, args, ctx) {
  switch (name) {
    case 'list_services': {
      const rows = await q(
        `SELECT name, duration_min, price_kzt FROM services WHERE active ORDER BY sort_order`
      );
      return {
        services: rows.map((r) => ({
          название: r.name,
          длительность_мин: r.duration_min,
          цена: fmtMoney(r.price_kzt),
        })),
      };
    }

    case 'find_slots': {
      const svc = await resolveService(args.service);
      if (!svc) {
        const all = await q(`SELECT name FROM services WHERE active ORDER BY sort_order`);
        return {
          ошибка: 'услуга не найдена',
          подсказка: 'Уточни у клиентки, что именно она хочет.',
          доступные_услуги: all.map((r) => r.name),
        };
      }

      const master = args.master ? await resolveMaster(args.master) : null;
      if (args.master && !master) {
        const ms = await q(`SELECT name FROM masters WHERE active ORDER BY id`);
        return {
          ошибка: 'мастер не найден',
          подсказка: 'Такого мастера в студии нет. Назови клиентке тех, кто работает.',
          мастера: ms.map((r) => r.name),
        };
      }

      const date = String(args.date || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return { ошибка: 'некорректная дата', подсказка: 'Нужен формат ГГГГ-ММ-ДД.' };
      }

      const slots = await q(
        `SELECT master_id, master_name, starts_at, price_kzt
           FROM free_slots($1, $2::date, $3)`,
        [svc.id, date, master?.id ?? null]
      );

      if (slots.length === 0) {

        const r = await one(
          `SELECT code, detail FROM free_slots_reason($1, $2::date, $3)`,
          [svc.id, date, master?.id ?? null]
        );
        const code = r?.code || 'FULLY_BOOKED';
        const d = r?.detail || '';

        const say = {
          PAST: 'Эта дата уже прошла. Мягко уточни, на какой день она хочет.',
          TOO_FAR: `Так далеко запись пока не открыта — только до ${d}. Предложи выбрать день пораньше.`,
          CLOSED_SALON: d
            ? `Студия в этот день не работает (${d}). Скажи об этом прямо и предложи соседние дни — это НЕ «всё занято».`
            : 'Студия в этот день не работает. Скажи об этом прямо и предложи соседние дни.',
          MASTER_OFF: d
            ? `Этот мастер в этот день не работает, ближайший её рабочий день — ${d}. Предложи либо этот день, либо другого мастера.`
            : 'Этот мастер в этот день не работает. Предложи другого мастера или другой день.',
          MASTER_CANT_DO: 'Эту услугу выбранный мастер не делает. Назови тех, кто делает.',
          TOO_LATE_TODAY: `На сегодня записаться уже поздно — мастеру нужно минимум ${d} минут на подготовку. Предложи завтра.`,
          FULLY_BOOKED: 'В этот день всё занято. Проверь соседние дни через find_slots и предложи их.',
        }[code];

        return {
          услуга: svc.name,
          дата: date,
          свободные_слоты: [],
          причина: code,
          подсказка: say || 'Свободного времени нет. Проверь соседние дни через find_slots.',
        };
      }

      const trimmed = slots.slice(0, 12);
      return {
        услуга: svc.name,
        длительность_мин: svc.duration_min,
        дата: date,
        свободные_слоты: trimmed.map((s) => ({
          время: new Date(s.starts_at).toLocaleTimeString('ru-RU', {
            hour: '2-digit', minute: '2-digit', timeZone: cfg.tz,
          }),
          мастер: s.master_name,
          цена: fmtMoney(s.price_kzt),
          starts_at: s.starts_at,
        })),
        всего_найдено: slots.length,
      };
    }

    case 'create_booking': {

      const raw = Array.isArray(args.services)
        ? args.services
        : [args.services || args.service].filter(Boolean);

      const resolved = [];
      for (const nameRaw of raw) {
        const s = await resolveService(nameRaw);
        if (!s) {
          const all = await q(`SELECT name FROM services WHERE active ORDER BY sort_order`);
          return {
            ошибка: 'услуга не найдена',
            не_найдено: nameRaw,
            доступные_услуги: all.map((r) => r.name),
            подсказка: 'Уточни у клиентки, какая именно из этих услуг ей нужна.',
          };
        }
        if (!resolved.find((x) => x.id === s.id)) resolved.push(s);
      }
      if (!resolved.length) return { ошибка: 'не указаны услуги' };

      const master = await resolveMaster(args.master);
      if (!master) return { ошибка: 'мастер не найден' };
      if (!args.starts_at) return { ошибка: 'не указано время' };

      const sameDay = await one(
        `SELECT id, starts_at FROM appointments
          WHERE client_id = $1
            AND status IN ('pending','confirmed')
            AND (starts_at AT TIME ZONE $3)::date = ($2::timestamptz AT TIME ZONE $3)::date
          LIMIT 1`,
        [ctx.clientId, args.starts_at, cfg.tz]
      );
      if (sameDay) {
        return {
          ошибка: 'на этот день запись уже есть',
          номер_записи: sameDay.id,
          текущее_время: fmtWhen(sameDay.starts_at),
          подсказка:
            'У неё уже есть запись на этот день. Вторую создавать НЕЛЬЗЯ — ' +
            'она придёт один раз. Если она хочет другое время, вызови ' +
            `reschedule_booking с номером ${sameDay.id}. Если хочет добавить ` +
            'услугу к тому же визиту — вызови add_service.',
        };
      }

      try {
        const result = await tx(async (c) => {
          const { rows } = await c.query(
            `SELECT book_appointment_multi($1, $2, $3::int[], $4::timestamptz, 'bot', '') AS id`,
            [ctx.clientId, master.id, resolved.map((s) => s.id), args.starts_at]
          );
          const apptId = rows[0].id;

          await c.query(`UPDATE appointments SET status = 'confirmed' WHERE id = $1`, [apptId]);

          if (args.client_name && String(args.client_name).trim().length > 1) {
            await c.query(
              `UPDATE clients SET name = COALESCE(name, $2) WHERE id = $1`,
              [ctx.clientId, String(args.client_name).trim().slice(0, 80)]
            );
          }

          const { rows: appt } = await c.query(
            `SELECT a.starts_at, a.price_kzt, a.duration_min, m.name AS master,
                    (SELECT string_agg(s.name, ' + ' ORDER BY x.position)
                       FROM appointment_services x
                       JOIN services s ON s.id = x.service_id
                      WHERE x.appointment_id = a.id) AS services
               FROM appointments a
               JOIN masters m ON m.id = a.master_id
              WHERE a.id = $1`,
            [apptId]
          );
          const a = appt[0];

          const { rows: st } = await c.query(
            `SELECT cancel_deadline_hours, salon_name, address FROM settings LIMIT 1`);
          const s = st[0] || {};

          const lines = [
            'Записала вас!',
            '',
            a.services,
            fmtWhen(a.starts_at),
            `Мастер: ${a.master}`,
            `Продолжительность: ${fmtDuration(a.duration_min)}`,
            `Стоимость: ${fmtMoney(a.price_kzt)}`,
          ];
          if (s.address) lines.push('', `Адрес: ${s.address}`);
          lines.push(
            '',
            s.cancel_deadline_hours
              ? `Если планы поменяются, предупредите, пожалуйста, не позже чем за ${fmtHours(s.cancel_deadline_hours)} — перенесём на удобное время.`
              : 'Если планы поменяются — напишите, перенесём.'
          );

          await enqueueOut(c, {
            chatId: ctx.chatId,
            clientId: ctx.clientId,
            dedupKey: `confirm:${apptId}`,
            body: lines.join('\n'),
          });

          return { apptId, ...a };
        }, 'bot');

        await notifyOwner({
          title: 'Новая запись',
          body: `${result.services} — ${fmtWhen(result.starts_at)}, мастер ${result.master}`,
          url: '/',
        });

        return {
          успешно: true,
          номер_записи: result.apptId,
          подсказка:
            'Запись создана. Подтверждение со всеми деталями и условиями отмены ' +
            'уже отправлено клиентке автоматически. НЕ дублируй его и НЕ перечисляй ' +
            'детали заново — ответь одной короткой тёплой фразой, например ' +
            '«Всё, жду вас!». Ничего больше не спрашивай.',
        };
      } catch (e) {
        if (isSlotTaken(e)) {
          return {
            ошибка: 'время только что заняли',
            подсказка: 'Пока вы разговаривали, этот слот занял кто-то другой. Извинись и предложи другое время — вызови find_slots заново.',
          };
        }
        const code = appError(e);
        const messages = {
          TOO_SOON: 'Слишком близко к текущему времени, так быстро мастер не успеет. Предложи время попозже.',
          TOO_FAR: 'Слишком далеко вперёд, так далеко запись не ведётся.',
          SLOT_OUTSIDE_HOURS: 'Это время вне рабочего графика мастера. Возьми время из find_slots.',
          CLIENT_BLOCKED: 'Запись этой клиентке недоступна, позови администратора.',
          SERVICE_NOT_FOUND: 'Услуга не найдена.',
        };
        if (code) return { ошибка: code, подсказка: messages[code] };
        log.error('create_booking failed', { err: e.message });
        return { ошибка: 'техническая ошибка', подсказка: 'Извинись и предложи, что администратор свяжется с ней.' };
      }
    }

    case 'my_bookings': {
      const rows = await q(
        `SELECT a.id, a.starts_at, a.price_kzt, s.name AS service, m.name AS master
           FROM appointments a
           JOIN services s ON s.id = a.service_id
           JOIN masters  m ON m.id = a.master_id
          WHERE a.client_id = $1                      -- ← привязка к отправителю
            AND a.status IN ('pending','confirmed')
            AND a.starts_at > now() - interval '2 hours'
          ORDER BY a.starts_at
          LIMIT 10`,
        [ctx.clientId]
      );
      return {
        записи: rows.map((r) => ({
          id: r.id,
          услуга: r.service,
          когда: fmtWhen(r.starts_at),
          мастер: r.master,
          цена: fmtMoney(r.price_kzt),
          starts_at: r.starts_at,
        })),
      };
    }

    case 'cancel_booking': {
      const id = Number(args.appointment_id);

      const owned = await one(
        `SELECT a.id, a.starts_at, s.name AS service
           FROM appointments a JOIN services s ON s.id = a.service_id
          WHERE a.id = $1 AND a.client_id = $2 AND a.status IN ('pending','confirmed')`,
        [id, ctx.clientId]
      );
      if (!owned) {
        return {
          ошибка: 'запись не найдена',
          подсказка: 'У этой клиентки нет такой активной записи. Не обсуждай чужие записи вообще.',
        };
      }

      const settings = await one(`SELECT cancel_deadline_hours FROM settings WHERE id`);
      const hoursLeft = (new Date(owned.starts_at) - Date.now()) / 3_600_000;
      const late = hoursLeft < settings.cancel_deadline_hours;

      await tx(async (c) => {
        await c.query(`SELECT cancel_appointment($1, 'клиентка отменила в переписке')`, [id]);

        await enqueueOut(c, {
          chatId: ctx.chatId,
          clientId: ctx.clientId,
          dedupKey: `cancel:${id}`,
          body: [
            'Отменила вашу запись.',
            '',
            `${owned.service} — ${fmtWhen(owned.starts_at)}`,
            '',
            'Будет удобно — напишите, подберём новое время.',
          ].join('\n'),
        });
      }, 'bot');

      await notifyOwner({
        title: late ? 'Поздняя отмена' : 'Отмена записи',
        body: `${owned.service} — ${fmtWhen(owned.starts_at)}`,
        url: '/',
        urgent: late,
      });

      return {
        успешно: true,
        подсказка:
          'Отменила, подтверждение клиентке уже отправлено. Не дублируй его. ' +
          'Ответь одной короткой доброжелательной фразой. ' +
          'НИ СЛОВА про то, что отмена поздняя, и никаких намёков на правила — ' +
          'у человека что-то случилось, а не он вас подводит.',
      };
    }

    case 'reschedule_booking': {
      const id = Number(args.appointment_id);
      const owned = await one(
        `SELECT id FROM appointments
          WHERE id = $1 AND client_id = $2 AND status IN ('pending','confirmed')`,
        [id, ctx.clientId]
      );
      if (!owned) return { ошибка: 'запись не найдена' };

      try {
        const res = await tx(async (c) => {
          const { rows: was } = await c.query(
            `SELECT starts_at FROM appointments WHERE id = $1`, [id]);

          await c.query(`SELECT reschedule_appointment($1, $2::timestamptz, NULL)`, [id, args.starts_at]);

          const { rows } = await c.query(
            `SELECT a.starts_at, a.duration_min, a.price_kzt, m.name AS master,
                    (SELECT string_agg(s.name, ' + ' ORDER BY x.position)
                       FROM appointment_services x JOIN services s ON s.id = x.service_id
                      WHERE x.appointment_id = a.id) AS services
               FROM appointments a
               JOIN masters m ON m.id = a.master_id
              WHERE a.id = $1`,
            [id]
          );
          const a = rows[0];

          await enqueueOut(c, {
            chatId: ctx.chatId,
            clientId: ctx.clientId,
            dedupKey: `resched:${id}:${args.starts_at}`,
            body: [
              'Перенесла вашу запись.',
              '',
              `Было: ${fmtWhen(was[0].starts_at)}`,
              `Стало: ${fmtWhen(a.starts_at)}`,
              '',
              a.services,
              `Мастер: ${a.master}`,
              `Продолжительность: ${fmtDuration(a.duration_min)}`,
              `Стоимость: ${fmtMoney(a.price_kzt)}`,
            ].join('\n'),
          });
          return a;
        }, 'bot');

        await notifyOwner({
          title: 'Перенос записи',
          body: `${res.services} — теперь ${fmtWhen(res.starts_at)}`,
          url: '/',
        });
        return {
          успешно: true,
          подсказка:
            'Перенесла. Подтверждение со старым и новым временем уже отправлено — ' +
            'не дублируй его, ответь одной короткой фразой.',
        };
      } catch (e) {
        if (isSlotTaken(e)) {
          return {
            ошибка: 'время занято',
            подсказка: 'Это время уже заняли, пока вы говорили. Извинись одной фразой, ' +
              'вызови find_slots и предложи 2-3 свежих варианта. Прежняя запись цела.',
          };
        }
        const code = appError(e);
        const known = {
          SLOT_OUTSIDE_HOURS: 'Это время вне графика мастера. Возьми время только из find_slots.',
          TOO_SOON: 'Слишком близко к текущему моменту — мастеру нужно время на подготовку. ' +
                    'Предложи более позднее время.',
          MASTER_CANT_DO: 'Этот мастер не делает нужные услуги. Предложи другого.',
          APPT_NOT_ACTIVE: 'Эта запись уже отменена. Уточни, что именно она хочет перенести.',
        }[code];
        if (known) return { ошибка: code, подсказка: known };

        log.error('ошибка переноса', { err: String(e.message).slice(0, 200) });
        return { ошибка: 'техническая ошибка', подсказка: 'Позови человека через escalate_to_human.' };
      }
    }

    case 'add_service': {
      const svc = await resolveService(args.service);
      if (!svc) {
        const all = await q(`SELECT name FROM services WHERE active ORDER BY sort_order`);
        return {
          ошибка: 'услуга не найдена',
          доступные_услуги: all.map((r) => r.name),
          подсказка: 'Уточни у клиентки, какую именно услугу добавить.',
        };
      }

      const mine = await q(
        `SELECT id, starts_at FROM appointments
          WHERE client_id = $1 AND status IN ('pending','confirmed') AND starts_at > now()
          ORDER BY starts_at LIMIT 5`, [ctx.clientId]);

      if (!mine.length) return { ошибка: 'нет активных записей' };
      let target = mine[0];
      if (args.appointment_id) {
        const found = mine.find((r) => r.id === Number(args.appointment_id));
        if (!found) return { ошибка: 'такой записи у неё нет' };
        target = found;
      } else if (mine.length > 1) {
        return {
          нужно_уточнить: true,
          записи: mine.map((r) => ({
            id: r.id,
            когда: fmtWhen(r.starts_at),
          })),
          подсказка: 'У неё несколько записей. Спроси, к какой добавить услугу.',
        };
      }

      try {
        const result = await tx(async (c) => {
          const { rows } = await c.query(
            `SELECT out_duration_min AS duration_min, out_price_kzt AS price_kzt,
                    out_ends_at AS ends_at, out_services AS services
               FROM add_service_to_appointment($1, $2)`, [target.id, svc.id]);
          const r = rows[0];

          await c.query(`UPDATE appointments SET status = 'confirmed' WHERE id = $1`, [target.id]);

          const { rows: extra } = await c.query(
            `SELECT a.starts_at, m.name AS master, s.cancel_deadline_hours
               FROM appointments a
               JOIN masters m ON m.id = a.master_id
               CROSS JOIN (SELECT cancel_deadline_hours FROM settings LIMIT 1) s
              WHERE a.id = $1`, [target.id]);
          const e = extra[0];

          await enqueueOut(c, {
            chatId: ctx.chatId,
            clientId: ctx.clientId,
            dedupKey: `addsvc:${target.id}:${svc.id}`,
            body: [
              'Добавила!',
              '',
              r.services,
              `${fmtWhen(e.starts_at)} — до ${new Date(r.ends_at).toLocaleTimeString('ru-RU', {
                hour: '2-digit', minute: '2-digit', timeZone: cfg.tz,
              })}`,
              `Мастер: ${e.master}`,
              `Продолжительность: ${fmtDuration(r.duration_min)}`,
              `Стоимость: ${fmtMoney(r.price_kzt)}`,
            ].join('\n'),
          });

          return r;
        }, 'bot');

        await notifyOwner({
          title: 'Услуга добавлена к записи',
          body: `${result.services} — теперь ${fmtDuration(result.duration_min)}`,
          url: '/',
        });

        return {
          успешно: true,
          подсказка:
            'Услуга добавлена, подтверждение с новым временем и суммой уже отправлено. ' +
            'Не дублируй его — ответь одной короткой фразой.',
        };
      } catch (e) {
        const msg = String(e.message || '');
        if (e.code === '23P01' || msg.includes('23P01')) {
          return {
            ошибка: 'не помещается',
            подсказка:
              'Визит станет длиннее и налезет на следующую клиентку. ' +
              'Предложи либо перенести запись на время, где хватит места, ' +
              'либо записаться на эту услугу отдельно в другой день.',
          };
        }
        if (msg.includes('DOESNT_FIT_SHIFT')) {
          return {
            ошибка: 'не помещается в смену',
            подсказка: 'Мастер заканчивает работу раньше. Предложи другой день или другое время.',
          };
        }
        if (msg.includes('SERVICE_ALREADY_ADDED')) {
          return { ошибка: 'эта услуга уже есть в записи', подсказка: 'Скажи об этом мягко.' };
        }
        if (msg.includes('MASTER_CANT_DO')) {
          return {
            ошибка: 'мастер не делает эту услугу',
            подсказка: 'Предложи записаться на неё отдельно к другому мастеру.',
          };
        }
        if (msg.includes('APPT_ALREADY_STARTED')) {
          return {
            ошибка: 'визит уже начался',
            подсказка: 'Скажи, что об этом лучше договориться с мастером на месте.',
          };
        }
        log.error('ошибка добавления услуги', { err: msg });
        return { ошибка: 'не получилось', подсказка: 'Позови человека через escalate_to_human.' };
      }
    }

    case 'escalate_to_human': {
      await pauseBot(ctx.clientId, PAUSE.ESCALATION, args.reason || 'эскалация');
      await notifyOwner({
        title: '🙋 Клиентка просит человека',
        body: `${ctx.clientName || 'Клиентка'}: ${args.summary || args.reason || ''}`,
        url: '/chats',
        urgent: true,
      });
      return {
        успешно: true,
        подсказка: 'Администратор получил уведомление. Скажи клиентке, что человек скоро напишет, и БОЛЬШЕ НИЧЕГО не предлагай.',
      };
    }

    default:
      return { ошибка: `неизвестный инструмент: ${name}` };
  }
}
