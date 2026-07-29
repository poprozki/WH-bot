#!/usr/bin/env bash
set -euo pipefail

ARCHIVE="${1:-}"
if [[ -z "$ARCHIVE" || ! -f "$ARCHIVE" ]]; then
  echo "Использование: $0 <путь к session_*.tar.gz>"
  echo ""
  echo "Доступные копии:"
  ls -1t /opt/salon-backups/session_*.tar.gz 2>/dev/null | head -10 || echo "  копий не найдено"
  exit 1
fi

cd "$(dirname "$0")/.."

echo "Восстановление сессии WhatsApp из: $ARCHIVE"
echo "Текущая сессия будет ЗАМЕНЕНА."
read -p "Продолжить? Введите 'да': " ok
[[ "$ok" == "да" ]] || { echo "Отменено."; exit 1; }

docker compose stop waha

SAFETY="/tmp/waha_session_before_restore_$(date +%s).tar.gz"
docker run --rm -v salon_waha_sessions:/data:ro -v /tmp:/out alpine:3.21 \
  tar czf "/out/$(basename "$SAFETY")" -C /data . 2>/dev/null || true
echo "Текущая сессия сохранена в $SAFETY"

docker run --rm \
  -v salon_waha_sessions:/data \
  -v "$(dirname "$(realpath "$ARCHIVE")")":/backup:ro \
  alpine:3.21 \
  sh -c "rm -rf /data/* /data/.[!.]* 2>/dev/null; tar xzf /backup/$(basename "$ARCHIVE") -C /data"

docker compose start waha

echo ""
echo "Жду, пока сессия поднимется..."
for i in $(seq 1 30); do
  sleep 3
  STATUS=$(docker compose exec -T bot node -e "
    fetch('http://waha:3000/api/sessions/default',{headers:{'X-Api-Key':process.env.WAHA_API_KEY}})
    .then(r=>r.json()).then(s=>console.log(s.status)).catch(()=>console.log('WAIT'))" 2>/dev/null | tr -d '\r')
  echo "  $i/30: $STATUS"
  if [[ "$STATUS" == "WORKING" ]]; then
    echo ""
    echo "✅ Сессия восстановлена. QR сканировать не нужно."
    exit 0
  fi
  if [[ "$STATUS" == "SCAN_QR_CODE" ]]; then
    echo ""
    echo "❌ Сессия требует QR — копия не подошла."
    echo "   Вернуть прежнее состояние: ./ops/restore-session.sh $SAFETY"
    exit 1
  fi
done

echo "❌ Сессия не поднялась за 90 секунд. Смотрите логи: make logs-all"
exit 1
