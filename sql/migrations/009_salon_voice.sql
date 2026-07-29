BEGIN;

ALTER TABLE settings ADD COLUMN IF NOT EXISTS bot_name text NOT NULL DEFAULT 'Алина';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS owner_name text NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS owner_phone text NOT NULL DEFAULT '';

ALTER TABLE settings ADD COLUMN IF NOT EXISTS extra_rules text NOT NULL DEFAULT '';

ALTER TABLE settings ADD COLUMN IF NOT EXISTS price_policy_text text NOT NULL DEFAULT
  'Цены у нас фиксированные, скидок нет. Зато качество стабильное и переделывать не приходится.';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS payment_note text NOT NULL DEFAULT
  'Оплата на месте после процедуры.';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS parking_note text NOT NULL DEFAULT '';

COMMENT ON COLUMN settings.extra_rules IS
  'Правила от владелицы. Идут отдельным системным сообщением, чтобы не ломать кеш базового промпта.';

COMMIT;
