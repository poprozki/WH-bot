#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."

PASS=0; FAIL=0
ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

echo "Проверка развёртывания"
echo "─────────────────────────────"

echo "Контейнеры:"
for svc in postgres waha bot; do
  if docker compose ps --status running --format '{{.Service}}' 2>/dev/null | grep -qx "$svc"; then
    ok "$svc работает"
  else
    bad "$svc НЕ работает"
  fi
done

echo "База данных:"
if docker compose exec -T postgres pg_isready -U salon -d salon >/dev/null 2>&1; then
  ok "принимает подключения"
else
  bad "недоступна"
fi

TABLES=$(docker compose exec -T postgres psql -U salon -d salon -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null | tr -d '\r ')
if [[ "${TABLES:-0}" -ge 12 ]]; then ok "схема на месте ($TABLES таблиц)"; else bad "схема неполная ($TABLES таблиц)"; fi

CONSTR=$(docker compose exec -T postgres psql -U salon -d salon -tAc \
  "SELECT count(*) FROM pg_constraint WHERE conname='no_double_booking'" 2>/dev/null | tr -d '\r ')
if [[ "${CONSTR:-0}" == "1" ]]; then ok "защита от двойной записи включена"; else bad "ОГРАНИЧЕНИЕ no_double_booking ОТСУТСТВУЕТ"; fi

OWNER=$(docker compose exec -T postgres psql -U salon -d salon -tAc \
  "SELECT has_table_privilege('bot','appointments_history','INSERT')" 2>/dev/null | tr -d '\r ')
if [[ "$OWNER" == "f" ]]; then ok "роль bot не может править журнал аудита"; else bad "роль bot имеет лишние права на аудит"; fi

SLOTS=$(docker compose exec -T postgres psql -U salon -d salon -tAc \
  "SELECT count(*) FROM free_slots(2, (CURRENT_DATE + 1)::date, NULL)" 2>/dev/null | tr -d '\r ')
if [[ "${SLOTS:-0}" -gt 0 ]]; then ok "свободные слоты считаются ($SLOTS на завтра)"; else bad "free_slots вернула пусто — проверьте график"; fi

echo "Сервисы:"
if docker compose exec -T bot node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
  ok "бот отвечает на /healthz"
else
  bad "бот не отвечает"
fi

STATUS=$(docker compose exec -T bot node -e "
  fetch('http://waha:3000/api/sessions/default',{headers:{'X-Api-Key':process.env.WAHA_API_KEY}})
  .then(r=>r.json()).then(s=>console.log(s.status||'?')).catch(()=>console.log('UNREACHABLE'))" 2>/dev/null | tr -d '\r')
case "$STATUS" in
  WORKING)      ok "сессия WhatsApp активна" ;;
  SCAN_QR_CODE) bad "нужно отсканировать QR: make qr" ;;
  *)            bad "сессия WhatsApp: $STATUS" ;;
esac

echo "Языковая модель:"
LLM=$(docker compose exec -T bot node -e "
import('./src/llm/client.js').then(async ({chat}) => {
  try {
    const r = await chat({messages:[{role:'user',content:'Ответь одним словом: привет'}]});
    const t = r.message?.content || '';
    const cyr = /[А-Яа-я]/.test(t);
    const cjk = /[一-鿿]/.test(t);
    console.log(JSON.stringify({ok:true, cyr, cjk, cached:r.cachedTokens}));
  } catch(e) { console.log(JSON.stringify({ok:false, err:e.message})); }
})" 2>/dev/null | tail -1)

if echo "$LLM" | grep -q '"ok":true'; then
  ok "модель отвечает"
  echo "$LLM" | grep -q '"cyr":true' && ok "отвечает по-русски" || bad "ответ не на русском"
  echo "$LLM" | grep -q '"cjk":true' && bad "в ответе иероглифы" || ok "иероглифов нет"
else
  bad "модель недоступна: $LLM"
fi

echo "Безопасность:"
if grep -q '429683C4C977415CAAFCCE10F7D57E11' .env 2>/dev/null; then
  bad "WAHA_API_KEY остался стандартным из примера!"
else
  ok "ключ WAHA не стандартный"
fi
if [[ "$(stat -c %a .env 2>/dev/null)" == "600" ]]; then ok ".env имеет права 600"; else bad ".env доступен лишним пользователям"; fi
if grep -q '^PANEL_DEV_AUTH=1' .env 2>/dev/null; then bad "ПАНЕЛЬ БЕЗ ЗАЩИТЫ: PANEL_DEV_AUTH=1"; else ok "панель защищена"; fi

echo "─────────────────────────────"
echo "Успешно: $PASS, с ошибками: $FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
