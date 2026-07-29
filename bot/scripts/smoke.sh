#!/usr/bin/env bash
set -uo pipefail

BASE="${1:-http://127.0.0.1:3011}"
FAIL=0
PASS=0

ok()   { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s — %s\n' "$1" "$2"; }

check_page() {
  local path="$1" name="$2"
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE$path")
  if [ "$code" = "200" ]; then ok "$name"; else bad "$name" "код $code"; fi
}

echo "Смок-тест: $BASE"
echo ""
echo "Здоровье процесса"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/healthz")
[ "$code" = "200" ] && ok "процесс отвечает" || bad "процесс отвечает" "код $code"

echo ""
echo "Страницы владелицы"
check_page "/panel/"                  "расписание дня"
check_page "/panel/chats"             "чаты"
check_page "/panel/stats"             "статистика"
check_page "/panel/new"               "ручная запись"
check_page "/panel/settings"          "настройки"
check_page "/panel/settings/services" "услуги и цены"
check_page "/panel/settings/masters"  "мастера"
check_page "/panel/settings/schedule" "график"
check_page "/panel/settings/days"     "выходные"
check_page "/panel/settings/voice"    "тон бота"
check_page "/panel/settings/salon"    "правила записи"

echo ""
echo "Страницы разработчика"
check_page "/panel/salons"            "список салонов"
check_page "/panel/salons/new"        "создание салона"
check_page "/panel/console"           "тестовая консоль"
check_page "/panel/ops"               "служебное"

echo ""
echo "Статика"
for f in app.css htmx.min.js app.js; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/panel/static/$f")
  [ "$code" = "200" ] && ok "$f" || bad "$f" "код $code"
done
if curl -s --max-time 5 "$BASE/panel/" | grep -q 'app\.css?v='; then
  ok "версия статики проставлена"
else
  bad "версия статики" "в HTML нет ?v= — кеш не сбросится у пользователей"
fi

echo ""
echo "Содержимое (страница не должна быть пустой обёрткой)"
if curl -s --max-time 5 "$BASE/panel/settings" | grep -q 'card-title\|class="menu"'; then
  ok "настройки отрисованы"
else
  bad "настройки отрисованы" "нет ожидаемой разметки"
fi
if curl -s --max-time 5 "$BASE/panel/settings/services" | grep -qE '₸|price'; then
  ok "прайс отдаётся"
else
  bad "прайс отдаётся" "нет цен на странице услуг"
fi

echo ""
echo "Чистота разметки"
ALL=$(for p in / /chats /stats /settings /settings/voice /settings/days /salons /console /ops; do
        curl -s --max-time 5 "$BASE/panel$p"; done)
n=$(echo "$ALL" | grep -cE 'style="[^"]*" style=' || true)
[ "$n" = "0" ] && ok "нет задвоенных style" || bad "задвоенные style" "$n шт"
n=$(echo "$ALL" | grep -c 'var(--card)' || true)
[ "$n" = "0" ] && ok "нет несуществующих переменных" || bad "переменная --card" "$n шт"
n=$(echo "$ALL" | grep -cE '>(WORKING|confirmed|pending|no_show)<' || true)
[ "$n" = "0" ] && ok "статусы по-русски" || bad "английские статусы" "$n шт"

echo ""
echo "─────────────────────────────"
if [ "$FAIL" = "0" ]; then
  printf '\033[32mВсё зелёное: %d проверок\033[0m\n' "$PASS"
  exit 0
fi
printf '\033[31mПровалов: %d, успешно: %d\033[0m\n' "$FAIL" "$PASS"
exit 1
