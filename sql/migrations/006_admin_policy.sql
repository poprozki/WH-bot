BEGIN;

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
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I '
        'USING (tenant_id = current_tenant() OR current_setting(''app.admin'', true) = ''on'') '
        'WITH CHECK (tenant_id = current_tenant() OR current_setting(''app.admin'', true) = ''on'')',
        t);
    END IF;
  END LOOP;
END $$;

COMMIT;
