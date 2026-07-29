#!/bin/bash
set -euo pipefail

: "${BOT_DB_PASSWORD:?BOT_DB_PASSWORD is required}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bot') THEN
      CREATE ROLE bot LOGIN;
    END IF;
  END \$\$;

  ALTER ROLE bot PASSWORD '${BOT_DB_PASSWORD}';

  -- Никакого CREATE в public
  REVOKE CREATE ON SCHEMA public FROM PUBLIC;
  GRANT USAGE ON SCHEMA public TO bot;

  -- Чтение — везде
  GRANT SELECT ON ALL TABLES IN SCHEMA public TO bot;

  -- Запись — только там, где она реально нужна
  GRANT INSERT, UPDATE ON
    clients, appointments, inbox_buffer, messages, outbox,
    panel_identities, push_subscriptions
    TO bot;

  GRANT INSERT ON pii_reveals TO bot;

  -- Владелица правит справочники и график из панели
  GRANT INSERT, UPDATE, DELETE ON
    services, masters, master_services, shifts, schedule_exceptions
    TO bot;
  GRANT UPDATE ON settings TO bot;

  -- Удаление разрешено ровно в двух местах: разбор буфера входящих
  -- и отписка от push. Записи и клиенты не удаляются никогда — только
  -- помечаются отменёнными, иначе разваливается история.
  GRANT DELETE ON inbox_buffer, push_subscriptions TO bot;

  -- НЕТ прав на appointments_history: аудит дописывается триггером
  -- от имени владельца схемы, а приложение не может его подчистить.
  REVOKE INSERT, UPDATE, DELETE ON appointments_history FROM bot;

  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO bot;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO bot;
EOSQL

echo "role 'bot' configured"
