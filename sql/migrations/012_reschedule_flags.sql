BEGIN;

CREATE OR REPLACE FUNCTION appointments_on_move() RETURNS trigger AS $$
BEGIN
  IF NEW.starts_at IS DISTINCT FROM OLD.starts_at THEN
    -- Про новое время нужно напомнить заново
    NEW.reminded_24h_at := NULL;
    NEW.reminded_2h_at  := NULL;
    NEW.reschedule_count := COALESCE(OLD.reschedule_count, 0) + 1;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_appointments_on_move ON appointments;
CREATE TRIGGER trg_appointments_on_move
  BEFORE UPDATE OF starts_at ON appointments
  FOR EACH ROW EXECUTE FUNCTION appointments_on_move();

CREATE OR REPLACE FUNCTION reschedule_appointment(
  p_appointment_id integer,
  p_starts_at      timestamptz,
  p_master_id      integer DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  a        appointments%ROWTYPE;
  v_master integer;
  v_date   date;
  v_ok     boolean;
  v_lead   integer;
BEGIN
  SELECT * INTO a FROM appointments WHERE id = p_appointment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'APPT_NOT_FOUND'; END IF;
  IF a.status NOT IN ('pending','confirmed') THEN RAISE EXCEPTION 'APPT_NOT_ACTIVE'; END IF;

  SELECT min_lead_minutes INTO v_lead FROM settings LIMIT 1;
  IF p_starts_at < now() + make_interval(mins => COALESCE(v_lead, 0)) THEN
    RAISE EXCEPTION 'TOO_SOON';
  END IF;

  v_master := COALESCE(p_master_id, a.master_id);
  v_date   := (p_starts_at AT TIME ZONE 'Asia/Almaty')::date;

  -- Новый мастер обязан уметь все услуги визита
  IF v_master <> a.master_id AND EXISTS (
    SELECT 1 FROM appointment_services x
     WHERE x.appointment_id = p_appointment_id
       AND EXISTS (SELECT 1 FROM master_services WHERE master_id = v_master)
       AND NOT EXISTS (SELECT 1 FROM master_services ms
                        WHERE ms.master_id = v_master AND ms.service_id = x.service_id)
  ) THEN
    RAISE EXCEPTION 'MASTER_CANT_DO';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM working_spans(v_master, v_date) w
    WHERE w.span @> tstzrange(p_starts_at,
                              p_starts_at + make_interval(mins => a.duration_min), '[)')
  ) INTO v_ok;
  IF NOT v_ok THEN RAISE EXCEPTION 'SLOT_OUTSIDE_HOURS'; END IF;

  -- Триггеры сделают остальное: пересчитают slot, сбросят напоминания,
  -- поднимут счётчик переносов и запишут строку в журнал изменений
  UPDATE appointments
     SET starts_at = p_starts_at,
         master_id = v_master
   WHERE id = p_appointment_id;
END $$;

COMMIT;
