import { chat, LlmError } from './llm/client.js';
import { salvageToolCall, LoopBreaker, cyrillicGate, stripMarkdown } from './llm/guards.js';
import { checkReply, correctionFor } from './llm/truth-gate.js';
import {
  bookingsSnapshot, snapshotAsToolResult, snapshotText,
  greetingAllowed, markGreeted, stripGreeting, stripNagging,
  loadDraft, draftMode, slotsAroundBooking,
} from './conversation.js';
import { routeBookingIntent } from './intent.js';
import { SYSTEM_PROMPT, buildVolatileBlock } from './prompt.js';
import { TOOL_SCHEMAS, runTool } from './tools.js';
import { q } from './db.js';
import { cfg } from './config.js';
import { log } from './log.js';

const HISTORY_TURNS = 12;

export const FALLBACK = {
  rate_limit: { text: 'Секунду, у меня всё немного подвисло 🙈 Напишите, пожалуйста, ещё раз через минутку — отвечу.', promisesHuman: false },
  no_balance: { text: 'Извините, у меня техническая заминка. Администратор скоро вам напишет.', promisesHuman: true },
  timeout: { text: 'Что-то я задумалась дольше обычного. Повторите, пожалуйста, последнее сообщение?', promisesHuman: false },
  server: { text: 'У меня небольшой сбой. Администратор уже в курсе и скоро вам ответит.', promisesHuman: true },
  other: { text: 'Извините, у меня техническая заминка. Передала ваше сообщение администратору — с вами свяжутся.', promisesHuman: true },
};

async function degrade(kind, ctx) {
  const f = FALLBACK[kind] || FALLBACK.other;
  if (f.promisesHuman) {
    await runTool('escalate_to_human', {
      reason: `технический сбой: ${kind}`,
      summary: (ctx.userText || '').slice(0, 200),
    }, ctx).catch((e) => log.error('не удалось создать эскалацию при сбое', { err: e.message }));
  }
  return { text: f.text, escalated: f.promisesHuman, degraded: kind };
}

async function loadHistory(clientId) {
  const rows = await q(
    `SELECT role, content FROM messages
      WHERE client_id = $1 AND role IN ('user','assistant')
      ORDER BY at DESC LIMIT $2`,
    [clientId, HISTORY_TURNS]
  );
  return rows.reverse().map((r) => ({ role: r.role, content: r.content }));
}

async function saveMessage(clientId, role, content) {
  await q(`INSERT INTO messages (client_id, role, content) VALUES ($1,$2,$3)`,
    [clientId, role, String(content).slice(0, 4000)]);
}

export async function handleTurn({ clientId, chatId, clientName, userText, clientRow }) {
  const volatile = await buildVolatileBlock(clientRow);
  const history = await loadHistory(clientId);

  const active = await bookingsSnapshot(clientId);
  const draft = await loadDraft(clientId);
  const mode = draftMode(Date.now(), draft);
  const canGreet = await greetingAllowed(clientId);

  const intent = routeBookingIntent(userText, active);

  const situation = [snapshotText(active)];
  if (intent.hint) situation.push(intent.hint);
  if (!canGreet) {
    situation.push('Вы уже общались сегодня — НЕ здоровайся заново, отвечай сразу по делу.');
  }
  if (!active.length && draft && (mode === 'CONFIRM' || mode === 'HINT')) {

    const facts = [];
    if (draft.wanted_date) facts.push(`день ${draft.wanted_date}`);
    if (facts.length) {
      situation.push(
        `Ранее она подбирала время (${facts[0]}), но не записалась. ` +
        'Можешь один раз мягко предложить продолжить с этого места. ' +
        'НЕ пиши «вы уже спрашивали», «как я говорила», «в прошлый раз» — это звучит как упрёк.'
      );
    }
  }

  const messages = [

    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: volatile },
    { role: 'system', content: situation.join('\n\n') },
    ...history,
    { role: 'user', content: userText },
  ];

  await saveMessage(clientId, 'user', userText);

  const breaker = new LoopBreaker(3, cfg.llm.maxToolRounds);
  let escalated = false;

  const toolResults = [];

  const snap = snapshotAsToolResult(active);
  if (snap) toolResults.push(snap);

  if (intent.op === 'RESCHEDULE' && active.length) {
    const near = await slotsAroundBooking(active[0]).catch(() => null);
    if (near) {
      toolResults.push(near);
      situation.push(
        'Свободное время для переноса уже найдено и приложено ниже. ' +
        'Предлагай ТОЛЬКО эти варианты и не выдумывай других. ' +
        'Когда клиентка выберет — вызови reschedule_booking с её номером записи.'
      );
      messages.push({ role: 'system', content: JSON.stringify(near) });
    }
  }

  let gateFailures = 0;

  for (;;) {
    let out;
    try {
      out = await chat({ messages, tools: TOOL_SCHEMAS });
    } catch (e) {
      if (e instanceof LlmError) {
        log.error('llm недоступна', { kind: e.kind });
        return degrade(e.kind, { clientId, chatId, clientName, userText });
      }
      throw e;
    }

    const msg = out.message;
    let toolCalls = msg.tool_calls || [];

    if (toolCalls.length === 0 && msg.content) {
      const salvaged = salvageToolCall(msg.content);
      if (salvaged) {
        log.warn('спасён текстовый вызов инструмента', { tool: salvaged.function.name });
        toolCalls = [salvaged];
      }
    }

    if (toolCalls.length === 0) {

      const lang = cyrillicGate(msg.content);
      if (!lang.ok) {
        log.warn('ответ не прошёл языковой фильтр', { reason: lang.reason });
        if (lang.reason === 'empty') {
          return degrade('other', { clientId, chatId, clientName, userText });
        }
        messages.push({ role: 'assistant', content: msg.content || '' });
        messages.push({
          role: 'system',
          content: 'Предыдущий ответ был не на русском. Повтори его полностью на русском языке.',
        });
        const retry = await chat({ messages, tools: [] }).catch(() => null);
        const retryText = retry?.message?.content;
        if (!retryText || !cyrillicGate(retryText).ok) {
          return degrade('other', { clientId, chatId, clientName, userText });
        }
        msg.content = retryText;
      }

      const check = checkReply(stripMarkdown(msg.content), toolResults, userText);
      if (!check.ok) {
        gateFailures += 1;
        log.warn('ответ завёрнут гейтом правды', {
          reason: check.reason, detail: check.detail, attempt: gateFailures,
        });

        if (gateFailures <= 2) {

          messages.push({ role: 'assistant', content: msg.content });
          messages.push({ role: 'system', content: correctionFor(check) });
          continue;
        }

        log.error('гейт правды не пройден трижды, зову человека', { reason: check.reason });
        await runTool('escalate_to_human', {
          reason: `бот не смог ответить без выдумки (${check.reason})`,
          summary: userText.slice(0, 200),
        }, { clientId, chatId, clientName });
        return {
          text: 'Секунду, уточню детали у мастера и вернусь к вам 🙌',
          escalated: true,
          degraded: `gate_${check.reason}`,
        };
      }

      let finalText = check.text;

      if (!canGreet) finalText = stripGreeting(finalText);
      else await markGreeted(clientId);

      const nag = stripNagging(finalText);
      if (!nag.clean) {
        log.warn('в ответе упрёк клиентке, переписываю', { phrase: nag.phrase });
        messages.push({ role: 'assistant', content: finalText });
        messages.push({
          role: 'system',
          content: `Убери из ответа «${nag.phrase}». Не напоминай клиентке, ` +
                   'что она о чём-то уже спрашивала — это звучит как упрёк. ' +
                   'Просто ответь заново, спокойно и по делу.',
        });
        const retry = await chat({ messages, tools: [] }).catch(() => null);
        const rt = retry?.message?.content;
        if (rt && stripNagging(rt).clean) finalText = stripMarkdown(rt);
      }

      await saveMessage(clientId, 'assistant', finalText);
      return { text: finalText, escalated, degraded: null };
    }

    messages.push({
      role: 'assistant',
      content: msg.content ?? null,
      tool_calls: toolCalls,
    });

    for (const tc of toolCalls) {
      const name = tc.function?.name;
      const rawArgs = tc.function?.arguments || '{}';

      const stop = breaker.check(name, rawArgs);
      if (stop) {
        log.warn('сработал ограничитель циклов', { reason: stop, tool: name });
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({
            ошибка: 'слишком много попыток',
            подсказка: 'Хватит вызывать инструменты. Ответь клиентке словами по тому, что уже известно, или позови человека.',
          }),
        });
        continue;
      }

      let args = {};
      try {
        args = JSON.parse(rawArgs);
      } catch {
        messages.push({
          role: 'tool', tool_call_id: tc.id,
          content: JSON.stringify({ ошибка: 'аргументы не разобраны, повтори вызов с корректным JSON' }),
        });
        continue;
      }

      const result = await runTool(name, args, { clientId, chatId, clientName });
      if (name === 'escalate_to_human') escalated = true;

      toolResults.push(result);

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      });
    }
  }
}
