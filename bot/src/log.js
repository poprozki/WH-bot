const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[process.env.LOG_LEVEL || 'info'] ?? 20;

export function maskPhone(p) {
  const s = String(p || '');
  if (s.length < 8) return '***';
  return `${s.slice(0, 5)}***${s.slice(-4)}`;
}

export function safeText(t) {
  const s = String(t || '');
  return `<${s.length} симв.>`;
}

function emit(lvl, msg, extra = {}) {
  if (LEVELS[lvl] < MIN) return;
  const rec = { t: new Date().toISOString(), lvl, msg, ...extra };
  const line = JSON.stringify(rec);
  if (lvl === 'error') console.error(line);
  else console.log(line);
}

export const log = {
  debug: (m, e) => emit('debug', m, e),
  info: (m, e) => emit('info', m, e),
  warn: (m, e) => emit('warn', m, e),
  error: (m, e) => emit('error', m, e),
};
