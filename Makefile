.DEFAULT_GOAL := help
SHELL := /bin/bash

help:
	@echo "Студия маникюра — бот записи"
	@echo ""
	@echo "  make setup        Первичная настройка: .env, htmx, иконки"
	@echo "  make up           Запустить бота (без голосовых и панели)"
	@echo "  make up-voice     + распознавание голосовых"
	@echo "  make up-all       + веб-панель наружу через Cloudflare"
	@echo "  make down         Остановить всё"
	@echo "  make logs         Логи бота"
	@echo "  make logs-all     Логи всех сервисов"
	@echo "  make qr           Как подключить телефон (инструкция)"
	@echo "  make status       Состояние сессии WhatsApp и контейнеров"
	@echo "  make psql         Консоль базы данных"
	@echo "  make reset-db     СТЕРЕТЬ базу и залить тестовые данные заново"
	@echo "  make backup       Резервная копия прямо сейчас"
	@echo "  make smoke        Быстрая проверка после развёртывания"
	@echo "  make vapid        Сгенерировать ключи для push-уведомлений"

setup:
	@test -f .env || ./ops/generate-env.sh
	@cd bot && npm install && npm run vendor
	@echo ""
	@echo "Дальше: заполните LLM_API_KEY в .env, потом make up"

up:
	docker compose up -d --build

up-voice:
	docker compose --profile voice up -d --build

up-all:
	docker compose --profile voice --profile web up -d --build

down:
	docker compose down

logs:
	docker compose logs -f --tail=100 bot

logs-all:
	docker compose logs -f --tail=50

status:
	@docker compose ps
	@echo ""
	@echo "Сессия WhatsApp:"
	@docker compose exec -T bot node -e "\
	  fetch('http://waha:3000/api/sessions/default',{headers:{'X-Api-Key':process.env.WAHA_API_KEY}})\
	  .then(r=>r.json()).then(s=>console.log(' ',s.status))\
	  .catch(e=>console.log('  недоступна:',e.message))"

qr:
	@echo "Подключение телефона к боту:"
	@echo ""
	@echo "1. На своей машине откройте туннель к серверу:"
	@echo "     ssh -L 3000:127.0.0.1:3000 salon@<ip-сервера>"
	@echo ""
	@echo "2. В браузере: http://localhost:3000"
	@echo "   Логин и пароль — из .env: WAHA_DASHBOARD_USER / WAHA_DASHBOARD_PASSWORD"
	@echo ""
	@echo "3. Создайте сессию 'default' и отсканируйте QR телефоном,"
	@echo "   с которого будет работать бот."
	@echo ""
	@echo "ВАЖНО: это должен быть ОТДЕЛЬНЫЙ номер, не личный номер владелицы."

psql:
	docker compose exec postgres psql -U salon -d salon

reset-db:
	@echo "Это СОТРЁТ все записи и клиентов. Сессия WhatsApp не пострадает."
	@read -p "Введите 'да' для подтверждения: " ok && [ "$$ok" = "да" ]
	docker compose stop bot
	docker compose exec -T postgres psql -U salon -d salon -c \
	  "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
	docker compose exec -T postgres psql -U salon -d salon -f /docker-entrypoint-initdb.d/01_schema.sql
	docker compose exec -T postgres psql -U salon -d salon -f /docker-entrypoint-initdb.d/02_functions.sql
	docker compose exec -T postgres psql -U salon -d salon -f /docker-entrypoint-initdb.d/03_seed.sql
	docker compose start bot
	@echo "База сброшена к тестовым данным."

backup:
	./ops/backup.sh

smoke:
	./ops/smoke.sh

vapid:
	docker compose run --rm bot npm run vapid

.PHONY: help setup up up-voice up-all down logs logs-all status qr psql reset-db backup smoke vapid
