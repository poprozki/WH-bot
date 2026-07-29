#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -f .env ]]; then
  echo "Файл .env уже существует."
  echo "Если хотите пересоздать — сначала сделайте копию: cp .env .env.backup"
  echo "ВНИМАНИЕ: смена PG_PASSWORD на работающей базе сломает подключение."
  exit 1
fi

gen() { openssl rand -hex "${1:-32}"; }

cat > .env <<EOF

PG_PASSWORD=$(gen 24)
BOT_DB_PASSWORD=$(gen 24)
WAHA_API_KEY=$(gen 32)
WAHA_HMAC_KEY=$(gen 32)
WAHA_DASHBOARD_USER=admin
WAHA_DASHBOARD_PASSWORD=$(gen 16)
SESSION_SECRET=$(gen 32)

LLM_PROVIDER=deepseek
LLM_API_KEY=
LLM_FREE_MODEL=google/gemma-4-31b-it:free

DEV_TELEGRAM_TOKEN=
DEV_TELEGRAM_CHAT_ID=

VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:change@me.example

PANEL_ORIGIN=http://localhost:3001
CF_ACCESS_TEAM_DOMAIN=
CF_ACCESS_AUD=
CF_TUNNEL_TOKEN=
PANEL_DEV_AUTH=0
PANEL_DEV_EMAIL=dev@localhost

GROQ_API_KEY=
LOG_LEVEL=info
EOF

chmod 600 .env

echo "Готово: .env создан, права 600."
echo
echo "Осталось заполнить вручную:"
echo "  LLM_API_KEY          — ключ с platform.deepseek.com"
echo "  DEV_TELEGRAM_TOKEN   — ваш бот для служебных оповещений (@BotFather)"
echo "  DEV_TELEGRAM_CHAT_ID — ваш chat_id (@userinfobot)"
echo
echo "Дальше:"
echo "  docker compose run --rm bot npm run vapid   # ключи для push"
echo "  docker compose up -d"
