FROM python:3.12-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

ENV HF_HOME=/models
RUN mkdir -p /models

ARG ASR_MODEL=gigaam-v3-e2e-rnnt
RUN python -c "import onnx_asr; onnx_asr.load_model('${ASR_MODEL}')" || \
    echo "предзагрузка не удалась, модель скачается при первом запуске"

COPY main.py .

EXPOSE 9000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "9000", "--workers", "1"]
