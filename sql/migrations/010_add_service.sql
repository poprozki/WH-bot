BEGIN;

DROP FUNCTION IF EXISTS add_service_to_appointment(integer, integer);

CREATE FUNCTION add_service_to_appointment(
  p_appointment_id integer,
  p_service_id     integer
)

RETURNS TABLE (
  out_appointment_id integer,
  out_duration_min   integer,
  out_price_kzt      integer,
  out_ends_at        timestamptz,
  out_services       text
)
LANGUAGE plpgsql AS $$
DECLARE
  a          appointments%ROWTYPE;
  v_dur      integer;
  v_price    integer;
  v_pos      smallint;
  v_ok       boolean;
  v_date     date;
BEGIN
  -- FOR UPDATE: пока считаем, никто не должен трогать эту запись
  SELECT * INTO a FROM appointments WHERE id = p_appointment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'APPT_NOT_FOUND'; END IF;
  IF a.status NOT IN ('pending','confirmed') THEN RAISE EXCEPTION 'APPT_NOT_ACTIVE'; END IF;

  -- Визит уже начался — менять состав поздно, это решает мастер на месте
  IF a.starts_at < now() THEN RAISE EXCEPTION 'APPT_ALREADY_STARTED'; END IF;

  IF EXISTS (SELECT 1 FROM appointment_services
              WHERE appointment_id = p_appointment_id AND service_id = p_service_id) THEN
    RAISE EXCEPTION 'SERVICE_ALREADY_ADDED';
  END IF;

  -- Цена и длительность берутся с учётом того, что у мастера они могут
  -- отличаться от базовых
  SELECT COALESCE(x.duration_min, s.duration_min),
         COALESCE(x.price_kzt,   s.price_kzt)
    INTO v_dur, v_price
    FROM services s
    LEFT JOIN master_services x ON x.service_id = s.id AND x.master_id = a.master_id
   WHERE s.id = p_service_id AND s.active;

  IF v_dur IS NULL THEN RAISE EXCEPTION 'SERVICE_NOT_FOUND'; END IF;

  -- Мастер обязан уметь эту услугу. Если у него явно задан список —
  -- услуга должна быть в нём.
  IF EXISTS (SELECT 1 FROM master_services WHERE master_id = a.master_id)
     AND NOT EXISTS (SELECT 1 FROM master_services
                      WHERE master_id = a.master_id AND service_id = p_service_id) THEN
    RAISE EXCEPTION 'MASTER_CANT_DO';
  END IF;

  -- Удлинённый визит обязан помещаться в смену мастера целиком
  v_date := (a.starts_at AT TIME ZONE 'Asia/Almaty')::date;
  SELECT EXISTS (
    SELECT 1 FROM working_spans(a.master_id, v_date) w
    WHERE w.span @> tstzrange(a.starts_at,
                              a.starts_at + make_interval(mins => a.duration_min + v_dur), '[)')
  ) INTO v_ok;
  IF NOT v_ok THEN RAISE EXCEPTION 'DOESNT_FIT_SHIFT'; END IF;

  SELECT COALESCE(max(position), 0) + 1 INTO v_pos
    FROM appointment_services WHERE appointment_id = p_appointment_id;

  INSERT INTO appointment_services (appointment_id, service_id, position, price_kzt, duration_min)
  VALUES (p_appointment_id, p_service_id, v_pos, v_price, v_dur);

  -- Пересчёт поднимает триггер appointments_derive, тот обновляет ends_at
  -- и slot, а обновлённый slot упирается в no_double_booking.
  -- Если удлинившийся визит налезает на следующую клиентку, транзакция
  -- откатится с SQLSTATE 23P01 — и это правильный, честный отказ.
  PERFORM recalc_appointment(p_appointment_id);

  RETURN QUERY
  SELECT a2.id, a2.duration_min, a2.price_kzt, a2.ends_at,
         (SELECT string_agg(s.name, ' + ' ORDER BY x.position)
            FROM appointment_services x JOIN services s ON s.id = x.service_id
           WHERE x.appointment_id = a2.id)
    FROM appointments a2 WHERE a2.id = p_appointment_id;
END $$;

COMMENT ON FUNCTION add_service_to_appointment IS
  'Добавить услугу к активной записи. 23P01 = удлинившийся визит налезает на соседнюю запись.';

COMMIT;
