BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='appointment_services' AND column_name='tenant_id') THEN
    ALTER TABLE appointment_services ADD COLUMN tenant_id integer;
    UPDATE appointment_services x
       SET tenant_id = a.tenant_id FROM appointments a WHERE a.id = x.appointment_id;
    -- Осиротевшие строки без записи отправляем в первый салон,
    -- иначе NOT NULL не поставится
    UPDATE appointment_services SET tenant_id = 1 WHERE tenant_id IS NULL;
    ALTER TABLE appointment_services ALTER COLUMN tenant_id SET NOT NULL;
    ALTER TABLE appointment_services ALTER COLUMN tenant_id SET DEFAULT current_tenant();
    CREATE INDEX IF NOT EXISTS appt_services_tenant_idx ON appointment_services (tenant_id);
  END IF;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'clients','services','masters','master_services','shifts',
    'schedule_exceptions','appointments','appointment_services',
    'appointments_history','inbox_buffer','messages','outbox','settings',
    'panel_identities','push_subscriptions','pii_reveals'
  ] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema='public' AND table_name=t) THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      -- FORCE обязателен. Без него владелец таблицы обходит собственные
      -- политики — а именно под владельцем обычно идут миграции и отладка,
      -- то есть защита не работала бы ровно там, где её проще всего проверить
      -- и решить, что «всё в порядке».
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) '
        'WITH CHECK (tenant_id = current_tenant())', t);
    END IF;
  END LOOP;
END $$;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_self ON tenants;
CREATE POLICY tenant_self ON tenants
  USING (id = current_tenant() OR current_setting('app.admin', true) = 'on')
  WITH CHECK (current_setting('app.admin', true) = 'on');

COMMIT;
