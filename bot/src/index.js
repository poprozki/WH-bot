import express from 'express';
import { cfg } from './config.js';
import { log, maskPhone, safeText } from './log.js';
import { q, one, healthy } from './db.js';
import { waha, verifyHmac, extractPhone, isGroup } from './waha.js';
import { enqueue, claimReady, release, requeue, reapStale, joinBurst } from './inbox.js';
import { drainOutbox, updateAck, stuckCount } from './outbox.js';
import {
  HUMAN_RE, MEDICAL_RE, PAUSE, pauseBot, resumeBot, isPaused,
  isOwnerTakeover, isResumeCommand,
} from './handoff.js';
import { handleTurn } from './agent.js';
import { replyDelayMs } from './llm/guards.js';
import { devAlert, notifyOwner } from './alerts.js';
import { transcribe } from './asr.js';
import { runReminders, closeOutPastAppointments } from './reminders.js';
import { runInTenant, runAsAdmin } from './tenant-context.js';
import { tenantFromWebhook, sessionStatus } from './waha-sessions.js';
import { listTenants } from './tenants.js';
import { assertIsolation } from './tenant-db.js';
import { mountPanel } from './panel/routes.js';

const app = express();

app.use('/webhook', express.raw({ type: '*/*', limit: '25mb' }));
app.use(express.json({ limit: '2mb' }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.post('/webhook/waha', async (req, res) => {
  const raw = req.body;
  const sig = req.get('X-Webhook-Hmac');

  if (!verifyHmac(raw, sig)) {
    log.warn('вебхук с неверной подписью отброшен');
    return res.status(401).end();
  }

  res.status(200).end();

  let event;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch {
    return;
  }

  try {
    await dispatch(event);
  } catch (e) {
    log.error('ошибка обработки вебхука', { event: event?.event, err: e.message });
    await devAlert(`Ошибка обработки вебхука: ${e.message}`, { key: 'webhook-error' });
  }
});

async function dispatch(event) {

  const tenant = await tenantFromWebhook(event);
  if (!tenant) return;

  return runInTenant(tenant.id, 'bot', async () => {
    switch (event.event) {
      case 'message.any': return onMessage(event.payload, tenant);
      case 'message.ack': return updateAck(event.payload?.id, event.payload?.ack);
      case 'session.status': return onSessionStatus(event.payload, tenant);
      default: return undefined;
    }
  });
}

async function onSessionStatus(p, tenant = null) {
  const status = p?.status;
  log.info('статус сессии WhatsApp', { status });

  if (status === 'WORKING') {
    await devAlert('✅ Сессия WhatsApp восстановлена', { key: 'session-ok' });
    return;
  }

  if (['FAILED', 'STOPPED', 'SCAN_QR_CODE'].includes(status)) {
    await devAlert(
      `🔴 Сессия WhatsApp: ${status}\n` +
      `Бот НЕ отвечает клиенткам.\n` +
      `Нужно зайти по SSH и пересканировать QR:\n` +
      `ssh -L 3000:127.0.0.1:3000 salon@<vps> → http://localhost:3000`,
      { key: `session-${status}`, urgent: true }
    );
  }
}

async function onMessage(p, tenant = null) {
  const chatId = p?.from || p?.chatId;
  if (!chatId) return;

  if (isGroup(chatId)) return;

  if (isOwnerTakeover(p)) {
    const client = await findClientByChat(chatId);
    if (client) {
      if (isResumeCommand(p.body)) {
        await resumeBot(client.id);
        return;
      }

      await pauseBot(client.id, PAUSE.OWNER_TYPED, 'владелица ответила сама');
    }
    return;
  }

  if (p?.fromMe) return;

  const settings = await one(`SELECT bot_enabled FROM settings WHERE id`);
  if (!settings?.bot_enabled) return;

  const phone = extractPhone(p);
  if (!phone) {
    log.info('телефон отправителя неизвестен (LID), работаю по адресу чата', {
      chatId: maskPhone(chatId),
    });
  }

  const clientId = (await one(
    `SELECT upsert_client($1, $2, $3) AS id`,
    [phone, chatId, p?.notifyName || null]
  ))?.id;
  if (!clientId) {
    log.error('не удалось создать клиента', { chatId: maskPhone(chatId) });
    await devAlert(`Не удалось создать клиента для чата ${maskPhone(chatId)}`, { key: 'upsert-fail' });
    return;
  }

  const paused = await isPaused(clientId);
  if (paused) {
    const bodyText = p?.body || (p?.hasMedia ? '[вложение]' : '');
    if (bodyText.trim()) {
      await q(
        `INSERT INTO messages (client_id, role, content, meta)
         VALUES ($1, 'user', $2, '{"while_paused":true}')`,
        [clientId, bodyText.slice(0, 4000)]
      );
    }
    await q(`UPDATE clients SET last_inbound_at = now() WHERE id = $1`, [clientId]);
    log.debug('бот на паузе: сообщение сохранено, ответ не отправляем', { clientId });
    return;
  }

  let text = p?.body || '';
  let kind = 'text';

  if (p?.media?.url || p?.hasMedia) {
    const mime = p?.media?.mimetype || '';
    if (mime.startsWith('audio')) {
      kind = 'voice';
      text = await safeTranscribe(p, clientId, chatId);
      if (text === null) return;
    } else if (mime.startsWith('image')) {
      kind = 'image';
      await handlePhoto(p, clientId, chatId);
      text = p?.media?.caption || p?.body || '';
      if (!text.trim()) return;
    } else {
      kind = 'other';
      text = p?.body || '[файл]';
    }
  }

  if (!text || !text.trim()) return;

  if (HUMAN_RE.test(text)) {
    await pauseBot(clientId, PAUSE.HUMAN_REQUEST, 'клиентка попросила человека');
    await notifyOwner({
      title: '🙋 Клиентка просит человека',
      body: `${p?.notifyName || 'Клиентка'} просит связаться`,
      url: '/chats', urgent: true,
    });
    await waha.sendText(chatId, 'Конечно, сейчас передам администратору — она вам напишет 🙌');
    return;
  }

  if (MEDICAL_RE.test(text)) {
    await pauseBot(clientId, PAUSE.ESCALATION, 'вопрос о здоровье');
    await notifyOwner({
      title: '⚕️ Вопрос о здоровье',
      body: `${p?.notifyName || 'Клиентка'} спрашивает про здоровье ногтей`,
      url: '/chats', urgent: true,
    });
    await waha.sendText(
      chatId,
      'Тут лучше, чтобы ответил мастер лично — я передала ваш вопрос, с вами скоро свяжутся.'
    );
    return;
  }

  await enqueue({ chatId, clientId, msgId: p?.id, body: text, kind });
  log.info('сообщение принято', { clientId, kind, len: safeText(text) });
}

async function safeTranscribe(p, clientId, chatId) {
  try {
    const t = await transcribe(p.media);
    if (!t || !t.trim()) {
      await waha.sendText(chatId, 'Кажется, голосовое не записалось 🙈 Напишите, пожалуйста, текстом?');
      return null;
    }
    return t;
  } catch (e) {
    log.error('распознавание не удалось', { err: e.message });
    await devAlert(`Распознавание голосовых не работает: ${e.message}`, { key: 'asr-down' });
    await waha.sendText(chatId, 'Извините, не получилось прослушать голосовое. Напишите, пожалуйста, текстом 🙏');
    return null;
  }
}

async function handlePhoto(p, clientId, chatId) {
  await notifyOwner({
    title: '📷 Фото от клиентки',
    body: 'Прислала пример дизайна — посмотрите в панели',
    url: '/chats',
  });
  await q(
    `INSERT INTO messages (client_id, role, content, meta)
     VALUES ($1,'user','[фото дизайна]', $2)`,
    [clientId, JSON.stringify({ media: p?.media?.url || null })]
  );
}

async function findClientByChat(chatId) {
  return one(`SELECT id FROM clients WHERE $1 = ANY(jids) LIMIT 1`, [chatId]);
}

async function conversationWorker() {
  for (;;) {
    try {

      const tenants = await runAsAdmin('обход салонов', () => listTenants());
      for (const t of tenants) {
        await runInTenant(t.id, 'bot', () => processTenantBatches(t));
      }
    } catch (e) {
      log.error('сбой воркера диалогов', { err: e.message });
    }
    await sleep(cfg.debounce.tickMs);
  }
}

async function processTenantBatches(tenant) {
  try {
      const batches = await claimReady();

      for (const { chatId, items } of batches) {
        const ids = items.map((i) => i.id);
        const clientId = items[0].client_id;
        const userText = joinBurst(items);

        try {
          const client = await one(
            `SELECT c.*, s.name AS usual_service_name, m.name AS preferred_master_name
               FROM clients c
               LEFT JOIN services s ON s.id = c.usual_service
               LEFT JOIN masters  m ON m.id = c.preferred_master
              WHERE c.id = $1`,
            [clientId]
          );

          await waha.sendSeen(chatId, items.map((i) => i.msg_id).filter(Boolean));
          await waha.startTyping(chatId);

          const keepTyping = setInterval(() => waha.startTyping(chatId).catch(() => {}), 8000);

          let result;
          try {
            result = await handleTurn({
              clientId, chatId,
              clientName: client?.name,
              userText,
              clientRow: client,
            });
          } finally {
            clearInterval(keepTyping);
          }

          if (result.text) {

            await sleep(replyDelayMs(result.text));
            await waha.stopTyping(chatId);
            await waha.sendText(chatId, result.text);
          } else {
            await waha.stopTyping(chatId);
          }

          if (result.degraded) {
            await devAlert(`Деградация ответа: ${result.degraded}`, { key: `degraded-${result.degraded}` });
          }

          await release(ids);
        } catch (e) {
          log.error('ошибка обработки диалога', { clientId, err: e.message });
          await waha.stopTyping(chatId).catch(() => {});

          await requeue(ids);
          await devAlert(`Ошибка в диалоге: ${e.message}`, { key: 'turn-error' });
          await sleep(2000);
        }
      }
  } catch (e) {
    log.error('сбой разбора очереди салона', { tenant: tenant.slug, err: e.message });
  }
}

async function outboxWorker() {
  for (;;) {
    try {
      const tenants = await runAsAdmin('обход салонов', () => listTenants());
      for (const t of tenants) {
        await runInTenant(t.id, 'system', () => drainOutbox());
      }
    } catch (e) {
      log.error('outbox worker', { err: e.message });
    }
    await sleep(3000);
  }
}

async function maintenanceWorker() {
  let lastDailyRun = '';

  for (;;) {
    try {
      const tenants = await runAsAdmin('обход салонов', () => listTenants());

      for (const t of tenants) {
        await runInTenant(t.id, 'system', async () => {
          await reapStale();
          const stuck = await stuckCount();
          if (stuck > 3) {
            await devAlert(`⚠️ ${t.slug}: ${stuck} исходящих зависли`, { key: `outbox-stuck-${t.slug}` });
          }
          await runReminders();
        });

        const st = await sessionStatus(t.wa_session);
        if (st !== 'WORKING') {
          await devAlert(`Сессия ${t.slug}: ${st}`, { key: `poll-${t.slug}-${st}`, urgent: true });
        }
      }

      const today = new Intl.DateTimeFormat('en-CA', { timeZone: cfg.tz }).format(new Date());
      if (today !== lastDailyRun) {
        lastDailyRun = today;
        for (const t of tenants) {
          const n = await runInTenant(t.id, 'system', () => closeOutPastAppointments());
          if (n) log.info('закрыты прошедшие визиты', { salon: t.slug, count: n });
        }
      }
    } catch (e) {
      log.error('сбой обслуживания', { err: e.message });
    }
    await sleep(60_000);
  }
}

app.get('/healthz', async (_req, res) => {
  const db = await healthy();
  res.status(db ? 200 : 503).json({ ok: db });
});

mountPanel(app);

app.listen(cfg.port, async () => {

  try {
    await assertIsolation();
  } catch (e) {
    log.error('ПРОВЕРКА ИЗОЛЯЦИИ НЕ ПРОЙДЕНА', { err: e.message });
    await devAlert(`🔴 Изоляция салонов не работает: ${e.message}`, { urgent: true });
    process.exit(1);
  }

  log.info('бот запущен', {
    port: cfg.port, tz: cfg.tz, provider: cfg.llm.provider,
  });
  conversationWorker();
  outboxWorker();
  maintenanceWorker();
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log.info('получен сигнал остановки', { sig });
    process.exit(0);
  });
}

process.on('unhandledRejection', (e) => {
  log.error('unhandled rejection', { err: String(e) });
  devAlert(`Необработанная ошибка: ${String(e).slice(0, 200)}`, { key: 'unhandled' });
});
