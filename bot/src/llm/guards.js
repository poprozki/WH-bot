export function salvageToolCall(content) {
  if (!content || typeof content !== 'string') return null;

  for (const raw of extractJsonObjects(content)) {
    try {
      const parsed = JSON.parse(raw);
      const name = parsed.name || parsed.function?.name;
      if (!name || typeof name !== 'string') continue;
      const args = parsed.arguments ?? parsed.parameters ?? parsed.function?.arguments ?? {};
      return {
        id: `salvaged_${Date.now()}`,
        type: 'function',
        function: {
          name,
          arguments: typeof args === 'string' ? args : JSON.stringify(args),
        },
      };
    } catch {

    }
  }
  return null;
}

function extractJsonObjects(text) {
  const out = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') { inString = true; continue; }

    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          out.push(text.slice(start, i + 1));
          start = -1;
          if (out.length >= 5) return out;
        }
      }
    }
  }
  return out;
}

export class LoopBreaker {
  constructor(maxRepeats = 3, maxRounds = 8) {
    this.maxRepeats = maxRepeats;
    this.maxRounds = maxRounds;
    this.history = [];
    this.rounds = 0;
  }

  check(toolName, argsJson) {
    this.rounds += 1;
    if (this.rounds > this.maxRounds) return 'rounds';

    const key = `${toolName}::${argsJson}`;
    this.history.push(key);

    const tail = this.history.slice(-this.maxRepeats);
    if (tail.length === this.maxRepeats && tail.every((k) => k === key)) {
      return 'repeat';
    }
    return null;
  }
}

export function cyrillicGate(text) {
  const s = String(text || '');
  if (!s.trim()) return { ok: false, reason: 'empty' };

  if (/[一-鿿぀-ヿ가-힯]/.test(s)) {
    return { ok: false, reason: 'cjk' };
  }

  const letters = s.replace(/[^\p{L}]/gu, '');
  if (letters.length === 0) return { ok: true };

  const cyr = (s.match(/[Ѐ-ӿ]/g) || []).length;
  const ratio = cyr / letters.length;

  if (ratio < 0.5) return { ok: false, reason: 'low_cyrillic' };
  return { ok: true };
}

export function stripMarkdown(text) {
  let s = String(text || '');
  s = s.replace(/```[\s\S]*?```/g, '');
  s = s.replace(/`([^`]+)`/g, '$1');
  s = s.replace(/^#{1,6}\s+/gm, '');
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '*$1*');
  s = s.replace(/\*\*([^*]+)\*\*/g, '*$1*');
  s = s.replace(/(^|\s)_([^_]+)_(\s|$)/g, '$1$2$3');
  s = s.replace(/~~([^~]+)~~/g, '~$1~');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 $2');
  s = s.replace(/^\s*[-*+]\s+/gm, '• ');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

export function replyDelayMs(text) {
  const len = String(text || '').length;
  return Math.min(6000, Math.max(1800, Math.round((len / 22) * 1000)));
}
