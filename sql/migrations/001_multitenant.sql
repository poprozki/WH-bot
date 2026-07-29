BEGIN;

CREATE OR REPLACE FUNCTION current_tenant() RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::integer, 0)
$$;

CREATE TABLE IF NOT EXISTS tenants (
  id            serial PRIMARY KEY,

  slug          text        NOT NULL UNIQUE
                CHECK (slug ~ '^[a-z][a-z0-9-]{1,30}[a-z0-9]$'),
  name          text        NOT NULL,
  status        text        NOT NULL DEFAULT 'active'
                CHECK (status IN ('trial', 'active', 'suspended', 'closed')),

  wa_session    text        NOT NULL UNIQUE,
  wa_phone      text        NULL,

  llm_daily_limit_usd  numeric(8,2) NOT NULL DEFAULT 1.00,
  llm_spent_today_usd  numeric(8,4) NOT NULL DEFAULT 0,
  llm_spent_date       date         NOT NULL DEFAULT CURRENT_DATE,
  msg_hourly_limit     integer      NOT NULL DEFAULT 200,

  timezone      text        NOT NULL DEFAULT 'Asia/Almaty',
  created_at    timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz NULL
);

INSERT INTO tenants (id, slug, name, wa_session)
VALUES (1, 'demo', 'Студия маникюра', 'default')
ON CONFLICT (id) DO NOTHING;
SELECT setval('tenants_id_seq', GREATEST((SELECT max(id) FROM tenants), 1));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'clients','services','masters','master_services','shifts',
    'schedule_exceptions','appointments','appointments_history',
    'inbox_buffer','messages','outbox','settings',
    'panel_identities','push_subscriptions','pii_reveals'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_name = t AND column_name = 'tenant_id'
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN tenant_id integer', t);
      EXECUTE format('UPDATE %I SET tenant_id = 1 WHERE tenant_id IS NULL', t);
      EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET NOT NULL', t);
      EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET DEFAULT current_tenant()', t);
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE',
        t, t || '_tenant_fk');
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (tenant_id)', t || '_tenant_idx', t);
    END IF;
  END LOOP;
END $$;

ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_phone_e164_key;
CREATE UNIQUE INDEX IF NOT EXISTS clients_tenant_phone_uq
  ON clients (tenant_id, phone_e164);

ALTER TABLE inbox_buffer DROP CONSTRAINT IF EXISTS inbox_buffer_channel_msg_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS inbox_tenant_msg_uq
  ON inbox_buffer (tenant_id, channel, msg_id);

ALTER TABLE outbox DROP CONSTRAINT IF EXISTS outbox_dedup_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS outbox_tenant_dedup_uq
  ON outbox (tenant_id, dedup_key) WHERE dedup_key IS NOT NULL;

ALTER TABLE push_subscriptions DROP CONSTRAINT IF EXISTS push_subscriptions_email_fkey;
ALTER TABLE panel_identities DROP CONSTRAINT IF EXISTS panel_identities_pkey;
ALTER TABLE panel_identities ADD PRIMARY KEY (tenant_id, email);

ALTER TABLE push_subscriptions
  ADD CONSTRAINT push_subscriptions_identity_fkey
  FOREIGN KEY (tenant_id, email) REFERENCES panel_identities(tenant_id, email) ON DELETE CASCADE;

ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_pkey;
ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_id_check;
ALTER TABLE settings ADD PRIMARY KEY (tenant_id);

ALTER TABLE appointments DROP CONSTRAINT IF EXISTS no_double_booking;
ALTER TABLE appointments ADD CONSTRAINT no_double_booking
  EXCLUDE USING gist (
    tenant_id WITH =,
    master_id WITH =,
    slot WITH &&
  ) WHERE (status IN ('pending', 'confirmed'));

COMMIT;
