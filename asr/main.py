import os
import subprocess
import tempfile
import time
import logging
from pathlib import Path

import numpy as np
import onnxruntime as rt
import onnx_asr
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("asr")

MODEL_NAME = os.getenv("ASR_MODEL", "gigaam-v3-e2e-rnnt")
THREADS = int(os.getenv("ASR_THREADS", "4"))
FILES_MOUNT = os.getenv("WAHA_FILES_MOUNT", "/app/waha-files")

VAD_THRESHOLD_SEC = 25.0

app = FastAPI(title="salon-asr")

_so = rt.SessionOptions()
_so.intra_op_num_threads = THREADS
_so.inter_op_num_threads = 1
_so.graph_optimization_level = rt.GraphOptimizationLevel.ORT_ENABLE_ALL

log.info("загружаю модель %s (потоков: %d)", MODEL_NAME, THREADS)
_t0 = time.time()

MODEL = onnx_asr.load_model(MODEL_NAME, sess_options=_so)
_VAD = None

log.info("модель загружена за %.1f с", time.time() - _t0)

def _warmup():

    silence = np.zeros(16000, dtype=np.float32)
    for i in range(2):
        t = time.time()
        try:
            MODEL.recognize(silence, sample_rate=16000)
        except Exception as e:
            log.warning("прогрев %d не удался: %s", i + 1, e)
        log.info("прогрев %d: %.2f с", i + 1, time.time() - t)

_warmup()
log.info("готов к работе")

class Req(BaseModel):
    path: str | None = None
    url: str | None = None

def _safe_path(p: str) -> Path:

    resolved = Path(p).resolve()
    root = Path(FILES_MOUNT).resolve()
    if not str(resolved).startswith(str(root)):
        raise HTTPException(400, "путь вне разрешённого каталога")
    if not resolved.is_file():
        raise HTTPException(404, "файл не найден")
    return resolved

def _to_wav(src: Path) -> tuple[np.ndarray, float]:

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        out = Path(tmp.name)
    try:

        subprocess.run(
            ["ffmpeg", "-nostdin", "-loglevel", "error", "-y",
             "-i", str(src), "-ar", "16000", "-ac", "1",
             "-c:a", "pcm_s16le", str(out)],
            check=True, timeout=60, capture_output=True,
        )
        import wave
        with wave.open(str(out), "rb") as w:
            frames = w.readframes(w.getnframes())
            duration = w.getnframes() / w.getframerate()

        audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
        return audio, duration
    finally:
        out.unlink(missing_ok=True)

@app.get("/healthz")
def healthz():
    return {"ok": True, "model": MODEL_NAME}

@app.post("/transcribe")
def transcribe(req: Req):
    if not req.path:
        raise HTTPException(400, "ожидается локальный path; скачивание по url отключено намеренно")

    src = _safe_path(req.path)
    started = time.time()

    try:
        audio, duration = _to_wav(src)
    except subprocess.CalledProcessError as e:
        raise HTTPException(422, f"ffmpeg не смог декодировать: {e.stderr[:200]}") from e
    except subprocess.TimeoutExpired as e:
        raise HTTPException(422, "ffmpeg завис") from e

    if duration < 0.3:
        return {"text": "", "duration": duration, "note": "слишком короткое"}

    global _VAD
    if duration > VAD_THRESHOLD_SEC:
        if _VAD is None:
            log.info("инициализирую VAD для длинного аудио")
            _VAD = MODEL.with_vad(onnx_asr.load_vad("silero"))
        segments = _VAD.recognize(audio, sample_rate=16000)
        text = " ".join(s.text if hasattr(s, "text") else str(s) for s in segments).strip()
    else:
        text = MODEL.recognize(audio, sample_rate=16000)
        if isinstance(text, list):
            text = " ".join(str(t) for t in text)

    elapsed = time.time() - started
    log.info(
        "распознано: %.1f с аудио за %.2f с (RTFx %.1f), символов: %d",
        duration, elapsed, duration / elapsed if elapsed else 0, len(text or ""),
    )
    return {"text": (text or "").strip(), "duration": duration, "elapsed": elapsed}
