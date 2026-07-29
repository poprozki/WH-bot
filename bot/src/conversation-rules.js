export function draftMode(nowMs, draft) {
  if (!draft || !draft.updated_at) return 'FRESH';
  const hours = (nowMs - new Date(draft.updated_at).getTime()) / 3_600_000;
  if (hours < 6) return 'CONTINUE';
  if (hours < 36) return 'CONFIRM';
  if (hours < 24 * 7) return 'HINT';
  return 'FRESH';
}

const NAGGING_RE = new RegExp(
  '(?:как я уже (?:говорила|писала|отвечала)|повторюсь|' +
  'вы уже (?:спрашивали|писали|обращались)|' +
  'вы мне (?:писали|говорили)|в прошлый раз вы|' +
  'и снова здравствуйте|как и договаривались ранее|' +
  'напоминаю, что вы)',
  'i'
);

export function stripNagging(text) {
  const m = String(text).match(NAGGING_RE);
  return m ? { clean: false, phrase: m[0] } : { clean: true };
}

export function stripGreeting(text) {
  let s = String(text || '');
  const re = /^\s*(?:здравствуйте|добрый день|доброе утро|добрый вечер|привет|здравствуй)[!,.\s—-]*/i;
  if (re.test(s)) {
    s = s.replace(re, '');
    s = s.charAt(0).toUpperCase() + s.slice(1);
  }
  return s.trim();
}
