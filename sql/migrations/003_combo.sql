BEGIN;

CREATE TABLE IF NOT EXISTS appointment_services (
  appointment_id integer NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  service_id     integer NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  position       smallint NOT NULL DEFAULT 1,

  price_kzt      integer NOT NULL CHECK (price_kzt >= 0),
  duration_min   integer NOT NULL CHECK (duration_min > 0),
  PRIMARY KEY (appointment_id, service_id)
);
CREATE INDEX IF NOT EXISTS appt_services_appt_idx ON appointment_services (appointment_id);

COMMENT ON COLUMN appointments.service_id IS
  'Основная услуга визита. Полный состав — в appointment_services.';

CREATE OR REPLACE FUNCTION recalc_appointment(p_appointment_id integer)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_dur integer;
  v_price integer;
  v_main integer;
BEGIN
  SELECT sum(duration_min), sum(price_kzt)
    INTO v_dur, v_price
    FROM appointment_services WHERE appointment_id = p_appointment_id;

  IF v_dur IS NULL THEN RETURN; END IF;   -- состава нет, ничего не трогаем

  -- Главной считаем самую длительную услугу визита
  SELECT service_id INTO v_main
    FROM appointment_services
   WHERE appointment_id = p_appointment_id
   ORDER BY duration_min DESC, position LIMIT 1;

  -- UPDATE поднимает триггер пересчёта ends_at и slot,
  -- поэтому защита от пересечений остаётся корректной
  UPDATE appointments
     SET duration_min = v_dur,
         price_kzt = v_price,
         service_id = COALESCE(v_main, service_id)
   WHERE id = p_appointment_id;
END $$;

CREATE OR REPLACE FUNCTION book_appointment_multi(
  p_client_id   integer,
  p_master_id   integer,
  p_service_ids integer[],
  p_starts_at   timestamptz,
  p_source      text DEFAULT 'bot',
  p_comment     text DEFAULT ''
)
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_id integer;
  v_sid integer;
  v_pos smallint := 1;
  v_dur integer;
  v_price integer;
  v_total integer := 0;
  v_settings settings%ROWTYPE;
  v_ok boolean;
  v_date date;
BEGIN
  IF array_length(p_service_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'SERVICE_NOT_FOUND';
  END IF;

  SELECT * INTO v_settings FROM settings LIMIT 1;

  IF (SELECT opted_out OR blocked FROM clients WHERE id = p_client_id) THEN
    RAISE EXCEPTION 'CLIENT_BLOCKED';
  END IF;

  -- Суммарная длительность нужна ДО вставки: проверяем, что визит
  -- целиком помещается в рабочий интервал мастера
  SELECT sum(COALESCE(x.duration_min, s.duration_min))
    INTO v_total
    FROM unnest(p_service_ids) AS u(sid)
    JOIN services s ON s.id = u.sid AND s.active
    LEFT JOIN master_services x ON x.service_id = s.id AND x.master_id = p_master_id;

  IF v_total IS NULL OR v_total = 0 THEN RAISE EXCEPTION 'SERVICE_NOT_FOUND'; END IF;

  IF p_starts_at < now() + make_interval(mins => v_settings.min_lead_minutes) THEN
    RAISE EXCEPTION 'TOO_SOON';
  END IF;

  v_date := (p_starts_at AT TIME ZONE 'Asia/Almaty')::date;
  SELECT EXISTS (
    SELECT 1 FROM working_spans(p_master_id, v_date) w
    WHERE w.span @> tstzrange(p_starts_at,
                              p_starts_at + make_interval(mins => v_total), '[)')
  ) INTO v_ok;
  IF NOT v_ok THEN RAISE EXCEPTION 'SLOT_OUTSIDE_HOURS'; END IF;

  INSERT INTO appointments (
    client_id, master_id, service_id, starts_at,
    duration_min, buffer_min, price_kzt, status, source, comment,
    ends_at, slot
  )
  VALUES (
    p_client_id, p_master_id, p_service_ids[1], p_starts_at,
    v_total, v_settings.default_buffer_min, 0, 'pending', p_source, p_comment,
    p_starts_at, tstzrange(p_starts_at, p_starts_at, '[)')
  )
  RETURNING id INTO v_id;

  FOREACH v_sid IN ARRAY p_service_ids LOOP
    SELECT COALESCE(x.duration_min, s.duration_min),
           COALESCE(x.price_kzt, s.price_kzt)
      INTO v_dur, v_price
      FROM services s
      LEFT JOIN master_services x ON x.service_id = s.id AND x.master_id = p_master_id
     WHERE s.id = v_sid AND s.active;

    IF v_dur IS NULL THEN RAISE EXCEPTION 'SERVICE_NOT_FOUND'; END IF;

    INSERT INTO appointment_services (appointment_id, service_id, position, price_kzt, duration_min)
    VALUES (v_id, v_sid, v_pos, v_price, v_dur)
    ON CONFLICT (appointment_id, service_id) DO NOTHING;
    v_pos := v_pos + 1;
  END LOOP;

  PERFORM recalc_appointment(v_id);
  RETURN v_id;
END $$;

INSERT INTO appointment_services (appointment_id, service_id, position, price_kzt, duration_min)
SELECT a.id, a.service_id, 1, a.price_kzt, a.duration_min
  FROM appointments a
 WHERE NOT EXISTS (SELECT 1 FROM appointment_services x WHERE x.appointment_id = a.id)
ON CONFLICT DO NOTHING;

COMMIT;
