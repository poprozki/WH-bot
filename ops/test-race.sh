#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."

echo "Проверка защиты от двойной записи"
echo "──────────────────────────────────"

psql() { docker compose exec -T postgres psql -U salon -d salon -tAc "$1" 2>&1; }

psql "SELECT upsert_client('+77010000001','77010000001@c.us','Тест А')" >/dev/null
psql "SELECT upsert_client('+77010000002','77010000002@c.us','Тест Б')" >/dev/null

A=$(psql "SELECT id FROM clients WHERE phone_e164='+77010000001'" | tr -d '\r ')
B=$(psql "SELECT id FROM clients WHERE phone_e164='+77010000002'" | tr -d '\r ')

SLOT=$(psql "SELECT starts_at FROM free_slots(2, (CURRENT_DATE + 2)::date, 1) LIMIT 1" | tr -d '\r')
if [[ -z "$SLOT" ]]; then
  echo "❌ Не нашлось свободных слотов. Проверьте график: make psql -> SELECT * FROM shifts;"
  exit 1
fi
echo "Слот для теста: $SLOT (мастер 1, услуга 2)"

TMP=$(mktemp -d)
for who in A B; do
  cid=$([[ $who == A ]] && echo "$A" || echo "$B")
  (
    docker compose exec -T postgres psql -U salon -d salon -v ON_ERROR_STOP=1 <<SQL > "$TMP/$who.out" 2>&1
BEGIN;
SELECT pg_sleep(0.3);
SELECT book_appointment($cid, 1, 2, '$SLOT'::timestamptz, 'bot', 'гонка-$who');
COMMIT;
SQL
    echo $? > "$TMP/$who.code"
  ) &
done
wait

CODE_A=$(cat "$TMP/A.code")
CODE_B=$(cat "$TMP/B.code")
OK=0; ERR=0
[[ "$CODE_A" == "0" ]] && OK=$((OK+1)) || ERR=$((ERR+1))
[[ "$CODE_B" == "0" ]] && OK=$((OK+1)) || ERR=$((ERR+1))

echo ""
echo "Результат: прошло $OK, отклонено $ERR"

if [[ "$OK" == "1" && "$ERR" == "1" ]]; then
  if grep -qE '23P01|no_double_booking|conflicting key|exclusion' "$TMP/A.out" "$TMP/B.out"; then
    echo "✅ Ровно одна запись прошла, вторая отклонена ограничением базы."
  else
    echo "⚠️  Одна отклонена, но не ограничением. Причина:"
    grep -i error "$TMP/A.out" "$TMP/B.out" | head -3
  fi
elif [[ "$OK" == "2" ]]; then
  echo "❌ ПРОВАЛ: обе записи прошли. Двойная запись возможна!"
  echo "   Проверьте ограничение:"
  psql "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='no_double_booking'"
  exit 1
else
  echo "❌ Обе транзакции упали — что-то не так с тестом:"
  cat "$TMP/A.out" "$TMP/B.out"
  exit 1
fi

psql "DELETE FROM appointments WHERE comment LIKE 'гонка-%'" >/dev/null
psql "DELETE FROM clients WHERE phone_e164 IN ('+77010000001','+77010000002')" >/dev/null
rm -rf "$TMP"
echo "Тестовые данные удалены."
