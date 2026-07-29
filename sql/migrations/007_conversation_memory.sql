BEGIN;

CREATE TABLE IF NOT EXISTS booking_drafts (
  client_id    integer PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  tenant_id    integer NOT NULL DEFAULT current_tenant() REFERENCES tenants(id) ON DELETE CASCADE,
  service_ids  integer[] NULL,
  master_id    integer NULL REFERENCES masters(id) ON DELETE SET NULL,
  wanted_date  date    NULL,
  note         text    NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz NULL
);
CREATE INDEX IF NOT EXISTS drafts_tenant_idx ON booking_drafts (tenant_id);
CREATE INDEX IF NOT EXISTS drafts_live_idx ON booking_drafts (updated_at) WHERE archived_at IS NULL;

CREATE OR REPLACE FUNCTION archive_draft_on_booking() RETURNS trigger AS $$
BEGIN
  UPDATE booking_drafts
     SET archived_at = now()
   WHERE client_id = NEW.client_id AND archived_at IS NULL;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_archive_draft ON appointments;
CREATE TRIGGER trg_archive_draft
  AFTER INSERT ON appointments
  FOR EACH ROW WHEN (NEW.status IN ('pending','confirmed'))
  EXECUTE FUNCTION archive_draft_on_booking();

ALTER TABLE clients ADD COLUMN IF NOT EXISTS last_greeted_at timestamptz;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS clarify_streak  smallint NOT NULL DEFAULT 0;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS last_inbound_at timestamptz;

COMMENT ON COLUMN clients.clarify_streak IS
  'Уточняющих вопросов подряд без продвижения. Больше двух — запись превращается в допрос.';

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS group_id uuid NULL;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS guest_name text NULL;

ALTER TABLE appointments DROP CONSTRAINT IF EXISTS client_not_double_booked;
ALTER TABLE appointments ADD CONSTRAINT client_not_double_booked
  EXCLUDE USING gist (
    tenant_id WITH =,
    client_id WITH =,
    slot WITH &&
  ) WHERE (status IN ('pending','confirmed') AND guest_name IS NULL AND group_id IS NULL);

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS cancelled_by text
  CHECK (cancelled_by IS NULL OR cancelled_by IN ('client','owner','system'));
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS late_cancel boolean NOT NULL DEFAULT false;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS reschedule_count smallint NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION mark_cancellation() RETURNS trigger AS $$
DECLARE v_deadline integer;
BEGIN
  IF NEW.status = 'cancelled' AND OLD.status <> 'cancelled' THEN
    SELECT cancel_deadline_hours INTO v_deadline FROM settings LIMIT 1;
    NEW.cancelled_at := now();
    NEW.late_cancel := (NEW.starts_at - now()) < make_interval(hours => COALESCE(v_deadline, 3));
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mark_cancel ON appointments;
CREATE TRIGGER trg_mark_cancel
  BEFORE UPDATE OF status ON appointments
  FOR EACH ROW EXECUTE FUNCTION mark_cancellation();

COMMIT;
