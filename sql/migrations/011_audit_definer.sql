BEGIN;

CREATE OR REPLACE FUNCTION appointments_audit() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER

SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO appointments_history (tenant_id, appointment_id, op, actor, old_row, new_row)
  VALUES (
    COALESCE(NEW.tenant_id, OLD.tenant_id),
    COALESCE(NEW.id, OLD.id),
    TG_OP,
    COALESCE(current_setting('app.actor', true), 'system'),
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END
  );
  RETURN NULL;
END $$;

COMMIT;
