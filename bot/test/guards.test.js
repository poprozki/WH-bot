import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  salvageToolCall, LoopBreaker, cyrillicGate, stripMarkdown, replyDelayMs,
} from '../src/llm/guards.js';

import { HUMAN_RE, MEDICAL_RE, isOwnerTakeover, isResumeCommand } from '../src/handoff-rules.js';

test('вызов человека: срабатывает на реальных формулировках', () => {
  const yes = [
    'позовите человека',
    'Позовите пожалуйста администратора',
    'можно администратора?',
    'соедините с мастером',
    'дайте живого человека',
    'хочу говорить с человеком',
    'мне нужен менеджер',
    'переключите на оператора',
    'у меня жалоба',
    'верните деньги',
    'это отвратительно',
    'вы мне ногти испортили',
  ];
  for (const s of yes) {
    assert.ok(HUMAN_RE.test(s), `должно срабатывать: "${s}"`);
  }
});

test('вызов человека: НЕ срабатывает на похвале', () => {

  const no = [
    'вы очень приятный человек',
    'спасибо, вы человек с большой буквы',
    'мастер золотые руки',
    'хочу записаться',
    'можно записаться на завтра',
  ];
  for (const s of no) {
    assert.ok(!HUMAN_RE.test(s), `не должно срабатывать: "${s}"`);
  }
});

test('вызов человека: работает на кириллице (ловушка \\b)', () => {

  assert.ok(HUMAN_RE.test('позовите администратора'));
  assert.ok(HUMAN_RE.test('ПОЗОВИТЕ АДМИНИСТРАТОРА'));
  assert.ok(/администратор\b/.test('позовите администратора') === false,
    'демонстрация: \\b с кириллицей не работает');
});

test('медицинские вопросы уходят к человеку', () => {
  for (const s of [
    'у меня грибок на ногте',
    'палец воспалился после прошлого раза',
    'болит ноготь',
    'у меня аллергия на гель',
    'я беременна, можно?',
    'ноготь врастает',
  ]) {
    assert.ok(MEDICAL_RE.test(s), `должно срабатывать: "${s}"`);
  }
  assert.ok(!MEDICAL_RE.test('хочу красный цвет'));
});

test('перехват: реакция только на сообщения из приложения, не на свои же', () => {
  assert.equal(isOwnerTakeover({ fromMe: true, source: 'app' }), true);

  assert.equal(isOwnerTakeover({ fromMe: true, source: 'api' }), false);
  assert.equal(isOwnerTakeover({ fromMe: false, source: 'app' }), false);
});

test('команда возврата бота', () => {
  assert.ok(isResumeCommand('#бот'));
  assert.ok(isResumeCommand('  #бот  '));
  assert.ok(!isResumeCommand('бот'));
  assert.ok(!isResumeCommand('#бот включись'));
});

test('спасатель: достаёт вызов из блока кода', () => {
  const r = salvageToolCall('```json\n{"name":"find_slots","arguments":{"service":"маникюр","date":"2026-08-01"}}\n```');
  assert.equal(r.function.name, 'find_slots');
  assert.equal(JSON.parse(r.function.arguments).date, '2026-08-01');
});

test('спасатель: достаёт вызов после китайского текста', () => {

  const r = salvageToolCall('数据还不够完整\n{"name":"list_services","arguments":{}}');
  assert.equal(r.function.name, 'list_services');
});

test('спасатель: не выдумывает вызов из обычного текста', () => {
  assert.equal(salvageToolCall('Здравствуйте! На какой день вас записать?'), null);
  assert.equal(salvageToolCall(''), null);
  assert.equal(salvageToolCall(null), null);
});

test('ограничитель: ловит три одинаковых вызова подряд', () => {
  const b = new LoopBreaker(3, 8);
  const a = '{"date":"2026-08-01"}';
  assert.equal(b.check('find_slots', a), null);
  assert.equal(b.check('find_slots', a), null);
  assert.equal(b.check('find_slots', a), 'repeat');
});

test('ограничитель: разные аргументы циклом не считает', () => {
  const b = new LoopBreaker(3, 8);
  assert.equal(b.check('find_slots', '{"date":"2026-08-01"}'), null);
  assert.equal(b.check('find_slots', '{"date":"2026-08-02"}'), null);
  assert.equal(b.check('find_slots', '{"date":"2026-08-03"}'), null);
});

test('ограничитель: держит общий предел раундов', () => {
  const b = new LoopBreaker(3, 4);
  for (let i = 0; i < 4; i += 1) b.check('t', `{"i":${i}}`);
  assert.equal(b.check('t', '{"i":99}'), 'rounds');
});

test('языковой фильтр: пропускает русский, режет иероглифы', () => {
  assert.equal(cyrillicGate('Записала вас на четверг в 15:00').ok, true);
  assert.equal(cyrillicGate('Записала вас 好的 на четверг').ok, false);
  assert.equal(cyrillicGate('Sorry, I can help you with that').ok, false);
  assert.equal(cyrillicGate('').ok, false);
});

test('языковой фильтр: не режет допустимую латиницу и цифры', () => {
  assert.equal(cyrillicGate('Ждём вас в SPA-зоне в 15:00').ok, true);
  assert.equal(cyrillicGate('15:00').ok, true, 'только время — не ошибка');
});

test('markdown: переводит в формат WhatsApp', () => {
  assert.equal(stripMarkdown('**Важно**'), '*Важно*');
  assert.equal(stripMarkdown('# Заголовок\nтекст'), 'Заголовок\nтекст');
  assert.equal(stripMarkdown('- пункт'), '• пункт');
  assert.equal(stripMarkdown('[тут](https://x.kz)'), 'тут https://x.kz');
});

test('пауза перед ответом пропорциональна длине', () => {
  assert.ok(replyDelayMs('Да') >= 1800, 'даже на короткий ответ нужна пауза');
  assert.ok(replyDelayMs('а'.repeat(500)) <= 6000, 'но не бесконечная');
});
