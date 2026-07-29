import path from 'node:path';
import { cfg } from './config.js';
import { log } from './log.js';

function localPath(mediaUrl) {
  if (!mediaUrl) return null;
  const m = String(mediaUrl).match(/\/api\/files\/(.+)$/);
  if (!m) return null;

  const rel = path.normalize(m[1]).replace(/^(\.\.[/\\])+/, '');
  if (rel.includes('..')) return null;
  return path.join(cfg.waha.filesMount, rel);
}

export async function transcribe(media) {
  if (!cfg.asr.url) {
    throw new Error('ASR не настроен (профиль voice не поднят)');
  }

  if (media?.error) {
    throw new Error(`WAHA не смогла скачать медиа: ${media.error}`);
  }
  if (!media?.url) {
    throw new Error('нет ссылки на медиафайл');
  }

  const file = localPath(media.url);
  const body = file
    ? { path: file }
    : { url: media.url };

  const started = Date.now();
  try {
    const res = await fetch(`${cfg.asr.url}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.asr.timeoutMs),
    });
    if (!res.ok) throw new Error(`ASR вернул ${res.status}`);
    const data = await res.json();
    log.info('голосовое распознано', {
      ms: Date.now() - started,
      chars: (data.text || '').length,
      engine: 'gigaam',
    });
    return data.text || '';
  } catch (e) {
    log.warn('локальное распознавание не сработало, пробую Groq', { err: e.message });
    return transcribeGroq(media.url);
  }
}

async function transcribeGroq(url) {
  if (!cfg.asr.groqKey) throw new Error('локальный ASR недоступен, ключ Groq не задан');

  const audio = await fetch(url, {
    headers: { 'X-Api-Key': cfg.waha.apiKey },
    signal: AbortSignal.timeout(15_000),
  });
  if (!audio.ok) throw new Error(`не удалось скачать аудио: ${audio.status}`);
  const buf = Buffer.from(await audio.arrayBuffer());

  const form = new FormData();
  form.append('file', new Blob([buf]), 'voice.ogg');
  form.append('model', 'whisper-large-v3-turbo');
  form.append('language', 'ru');
  form.append('response_format', 'json');

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.asr.groqKey}` },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Groq вернул ${res.status}`);
  const data = await res.json();
  log.info('голосовое распознано резервным путём', { engine: 'groq' });
  return data.text || '';
}
