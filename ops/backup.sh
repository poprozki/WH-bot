#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
BACKUP_DIR="${BACKUP_DIR:-/opt/salon-backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP=$(date +%F_%H%M)

mkdir -p "$BACKUP_DIR"

fail() {
  echo "ОШИБКА: $1" >&2
  if [[ -n "${DEV_TELEGRAM_TOKEN:-}" && -n "${DEV_TELEGRAM_CHAT_ID:-}" ]]; then
    curl -s -X POST "https://api.telegram.org/bot${DEV_TELEGRAM_TOKEN}/sendMessage" \
      -d "chat_id=${DEV_TELEGRAM_CHAT_ID}" \
      -d "text=🔴 [salon-bot] Бэкап не выполнен: $1" >/dev/null || true
  fi
  exit 1
}

set -a; [[ -f .env ]] && source .env; set +a

echo "[$(date +%T)] дамп базы..."
docker compose exec -T postgres pg_dump -U salon -d salon --no-owner \
  > "$BACKUP_DIR/db_$STAMP.sql" || fail "pg_dump не отработал"

if [[ ! -s "$BACKUP_DIR/db_$STAMP.sql" ]]; then
  fail "дамп базы получился пустым"
fi

echo "[$(date +%T)] останавливаю waha для снятия сессии..."
docker compose stop waha >/dev/null
trap 'docker compose start waha >/dev/null 2>&1 || true' EXIT

docker run --rm \
  -v salon_waha_sessions:/data:ro \
  -v "$BACKUP_DIR":/backup \
  alpine:3.21 \
  tar czf "/backup/session_$STAMP.tar.gz" -C /data . || fail "не удалось скопировать сессию"

docker compose start waha >/dev/null
trap - EXIT
echo "[$(date +%T)] waha запущена"

tar czf "$BACKUP_DIR/config_$STAMP.tar.gz" .env docker-compose.yml sql/ 2>/dev/null || true
chmod 600 "$BACKUP_DIR/config_$STAMP.tar.gz"

find "$BACKUP_DIR" -type f -name '*.sql'    -mtime "+$KEEP_DAYS" -delete
find "$BACKUP_DIR" -type f -name '*.tar.gz' -mtime "+$KEEP_DAYS" -delete

SIZE=$(du -sh "$BACKUP_DIR" | cut -f1)
echo "[$(date +%T)] готово. Всего копий занимают: $SIZE"

LATEST=$(find "$BACKUP_DIR" -name 'db_*.sql' -mtime -2 | wc -l)
if [[ "$LATEST" -eq 0 ]]; then
  fail "за последние двое суток нет ни одной копии базы"
fi
