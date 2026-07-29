export const HUMAN_RE = new RegExp(
  '(?:поз(?:ов|в)|соедин|переключ|дай(?:те)?|нужен|нужна|хочу\\s+(?:говорить|с)|можно)\\s*' +
  '(?:\\S+\\s+){0,2}' +
  '(?:человек|оператор|администратор|менеджер|мастер|хозяйк|директор|владел)' +
  '|жив(?:ой|ого|ым)\\s+человек' +
  '|(?:жалоб|претензи|верните\\s+деньги|отвратительн|ужасн|испортил|хамств)',
  'i'
);

export const MEDICAL_RE = new RegExp(
  '(?:грибок|онихолизис|воспал|гной|нарыв|кров|болит|боль\\s|аллерги|отёк|отек|' +
  'панариций|врастает|вросш|инфекц|зараз|беременн|диабет|псориаз|экзем)',
  'i'
);

export const PAUSE = {
  OWNER_TYPED: 60,
  HUMAN_REQUEST: 120,
  ESCALATION: 120,
  ERROR: 30,
};

export function isOwnerTakeover(payload) {
  return payload?.fromMe === true && payload?.source === 'app';
}

export function isResumeCommand(text) {
  return /^\s*#\s*бот\s*$/i.test(String(text || ''));
}
