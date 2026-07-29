SET timezone = 'Asia/Almaty';

CREATE OR REPLACE FUNCTION working_spans(p_master_id integer, p_date date)
RETURNS TABLE (span tstzrange)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_tz     text := 'Asia/Almaty';
  v_day    tstzrange;
  v_base   tstzmultirange;
  v_blocks tstzmultirange;
BEGIN
  -- Границы суток в зоне САЛОНА. Сервер стоит в Германии, разница пять часов:
  -- без явной зоны «день» уезжает, и вечерние записи попадают не в те сутки.
  v_day := tstzrange(
    (p_date)::timestamp     AT TIME ZONE v_tz,
    (p_date + 1)::timestamp AT TIME ZONE v_tz, '[)');

  -- Когда мастер в принципе работает: регулярный график плюс разовые выходы
  SELECT COALESCE(range_agg(t.sp), '{}'::tstzmultirange) INTO v_base
  FROM (
    SELECT tstzrange(
             (p_date + s.starts_time) AT TIME ZONE v_tz,
             (p_date + s.ends_time)   AT TIME ZONE v_tz, '[)') AS sp
      FROM shifts s
     WHERE s.master_id = p_master_id
       AND s.weekday = EXTRACT(dow FROM p_date)::smallint

    UNION ALL

    SELECT e.span * v_day
      FROM schedule_exceptions e
     WHERE e.kind = 'work'
       AND e.master_id = p_master_id
       AND e.span && v_day
  ) t
  WHERE NOT isempty(t.sp);

  -- Что вычитаем: личные перерывы мастера и общесалонные (master_id IS NULL —
  -- праздники, ремонт). Интервал обрезается сутками, чтобы многодневный
  -- отпуск не тянул за собой лишнее.
  SELECT COALESCE(range_agg(e.span * v_day), '{}'::tstzmultirange) INTO v_blocks
    FROM schedule_exceptions e
   WHERE e.kind = 'off'
     AND (e.master_id = p_master_id OR e.master_id IS NULL)
     AND e.span && v_day;

  -- НАСТОЯЩЕЕ вычитание диапазонов.
  --
  -- Здесь была ошибка, дорого стоившая бы в бою: раньше смена отбрасывалась
  -- целиком только если перерыв ПОЛНОСТЬЮ её накрывает. Обед 14:00–15:00
  -- внутри смены 10:00–20:00 под это условие не подходил и просто
  -- игнорировался — бот бодро предлагал клиенткам записаться на обед мастера.
  -- Вычитание мультидиапазонов режет смену на куски правильно: 10:00–14:00
  -- и 15:00–20:00.
  RETURN QUERY
  SELECT u FROM unnest(v_base - v_blocks) u WHERE NOT isempty(u);
END $$;

CREATE OR REPLACE FUNCTION free_slots(
  p_service_id integer,
  p_date       date,
  p_master_id  integer DEFAULT NULL
)
RETURNS TABLE (master_id integer, master_name text, starts_at timestamptz, price_kzt integer)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_settings   settings%ROWTYPE;
  v_now        timestamptz := now();
  v_earliest   timestamptz;
  v_horizon    date;
BEGIN
  SELECT * INTO v_settings FROM settings WHERE id;

  v_earliest := v_now + make_interval(mins => v_settings.min_lead_minutes);
  v_horizon  := (v_now AT TIME ZONE 'Asia/Almaty')::date + v_settings.booking_horizon_days;

  IF p_date > v_horizon THEN
    RETURN;  -- слишком далеко вперёд — пусто, бот скажет об этом словами
  END IF;

  RETURN QUERY
  WITH svc AS (
    SELECT s.id, s.duration_min, s.price_kzt
    FROM services s WHERE s.id = p_service_id AND s.active
  ),
  -- мастера, которые эту услугу делают
  ms AS (
    SELECT m.id AS master_id,
           m.name,
           COALESCE(x.duration_min, svc.duration_min) AS duration_min,
           COALESCE(x.price_kzt,   svc.price_kzt)     AS price_kzt
    FROM masters m
    JOIN svc ON true
    LEFT JOIN master_services x ON x.master_id = m.id AND x.service_id = svc.id
    WHERE m.active
      AND (p_master_id IS NULL OR m.id = p_master_id)
      -- если для мастера явно заданы услуги, услуга должна быть среди них
      AND (
        NOT EXISTS (SELECT 1 FROM master_services y WHERE y.master_id = m.id)
        OR x.master_id IS NOT NULL
      )
  ),
  spans AS (
    SELECT ms.master_id, ms.name, ms.duration_min, ms.price_kzt, w.span
    FROM ms, LATERAL working_spans(ms.master_id, p_date) w
  ),
  grid AS (
    SELECT sp.master_id, sp.name, sp.duration_min, sp.price_kzt,
           gs AS candidate
    FROM spans sp,
         LATERAL generate_series(
           lower(sp.span),
           upper(sp.span) - make_interval(mins => sp.duration_min),
           interval '15 minutes'
         ) gs
    -- запись должна целиком помещаться в рабочий интервал
    WHERE gs + make_interval(mins => sp.duration_min) <= upper(sp.span)
      AND gs >= v_earliest
  )
  SELECT g.master_id, g.name, g.candidate, g.price_kzt
  FROM grid g
  WHERE NOT EXISTS (
    SELECT 1 FROM appointments a
    WHERE a.master_id = g.master_id
      AND a.status IN ('pending', 'confirmed')
      AND a.slot && tstzrange(
            g.candidate,
            g.candidate + make_interval(mins => g.duration_min + v_settings.default_buffer_min),
            '[)')
  )
  ORDER BY g.candidate, g.master_id;
END $$;

CREATE OR REPLACE FUNCTION book_appointment(
  p_client_id  integer,
  p_master_id  integer,
  p_service_id integer,
  p_starts_at  timestamptz,
  p_source     text DEFAULT 'bot',
  p_comment    text DEFAULT ''
)
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_settings settings%ROWTYPE;
  v_duration integer;
  v_price    integer;
  v_id       integer;
  v_date     date;
  v_ok       boolean;
BEGIN
  SELECT * INTO v_settings FROM settings WHERE id;

  IF (SELECT opted_out OR blocked FROM clients WHERE id = p_client_id) THEN
    RAISE EXCEPTION 'CLIENT_BLOCKED';
  END IF;

  SELECT COALESCE(x.duration_min, s.duration_min),
         COALESCE(x.price_kzt,   s.price_kzt)
    INTO v_duration, v_price
  FROM services s
  LEFT JOIN master_services x ON x.service_id = s.id AND x.master_id = p_master_id
  WHERE s.id = p_service_id AND s.active;

  IF v_duration IS NULL THEN
    RAISE EXCEPTION 'SERVICE_NOT_FOUND';
  END IF;

  IF p_starts_at < now() + make_interval(mins => v_settings.min_lead_minutes) THEN
    RAISE EXCEPTION 'TOO_SOON';
  END IF;

  IF (p_starts_at AT TIME ZONE 'Asia/Almaty')::date
     > (now() AT TIME ZONE 'Asia/Almaty')::date + v_settings.booking_horizon_days THEN
    RAISE EXCEPTION 'TOO_FAR';
  END IF;

  -- время должно попадать в рабочий интервал мастера целиком
  v_date := (p_starts_at AT TIME ZONE 'Asia/Almaty')::date;
  SELECT EXISTS (
    SELECT 1 FROM working_spans(p_master_id, v_date) w
    WHERE w.span @> tstzrange(p_starts_at,
                              p_starts_at + make_interval(mins => v_duration), '[)')
  ) INTO v_ok;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'SLOT_OUTSIDE_HOURS';
  END IF;

  -- Само пересечение ловит ограничение no_double_booking (23P01).
  INSERT INTO appointments (
    client_id, master_id, service_id, starts_at,
    duration_min, buffer_min, price_kzt, status, source, comment,
    ends_at, slot
  )
  VALUES (
    p_client_id, p_master_id, p_service_id, p_starts_at,
    v_duration, v_settings.default_buffer_min, v_price, 'pending', p_source, p_comment,
    -- перезапишет триггер, но NOT NULL требует значения
    p_starts_at, tstzrange(p_starts_at, p_starts_at, '[)')
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION reschedule_appointment(
  p_appointment_id integer,
  p_starts_at      timestamptz,
  p_master_id      integer DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  a appointments%ROWTYPE;
  v_master integer;
  v_date date;
  v_ok boolean;
BEGIN
  SELECT * INTO a FROM appointments WHERE id = p_appointment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'APPT_NOT_FOUND'; END IF;
  IF a.status NOT IN ('pending','confirmed') THEN RAISE EXCEPTION 'APPT_NOT_ACTIVE'; END IF;

  v_master := COALESCE(p_master_id, a.master_id);
  v_date   := (p_starts_at AT TIME ZONE 'Asia/Almaty')::date;

  SELECT EXISTS (
    SELECT 1 FROM working_spans(v_master, v_date) w
    WHERE w.span @> tstzrange(p_starts_at,
                              p_starts_at + make_interval(mins => a.duration_min), '[)')
  ) INTO v_ok;
  IF NOT v_ok THEN RAISE EXCEPTION 'SLOT_OUTSIDE_HOURS'; END IF;

  UPDATE appointments
     SET starts_at = p_starts_at,
         master_id = v_master
   WHERE id = p_appointment_id;
END $$;

CREATE OR REPLACE FUNCTION cancel_appointment(
  p_appointment_id integer,
  p_reason text DEFAULT ''
)
RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE appointments
     SET status = 'cancelled',
         comment = CASE WHEN p_reason = '' THEN comment
                        ELSE trim(both from comment || ' | отмена: ' || p_reason) END
   WHERE id = p_appointment_id
     AND status IN ('pending','confirmed');
  IF NOT FOUND THEN RAISE EXCEPTION 'APPT_NOT_ACTIVE'; END IF;
END $$;

CREATE OR REPLACE FUNCTION upsert_client(
  p_phone text,
  p_jid   text,
  p_name  text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE v_id integer;
BEGIN
  INSERT INTO clients (phone_e164, jids, name)
  VALUES (p_phone, ARRAY[p_jid], p_name)
  ON CONFLICT (phone_e164) DO UPDATE
    SET jids = CASE WHEN clients.jids @> ARRAY[p_jid]
                    THEN clients.jids
                    ELSE clients.jids || p_jid END,
        name = COALESCE(clients.name, EXCLUDED.name),
        last_seen_at = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION reap_stale_claims(p_older_than interval DEFAULT '2 minutes')
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  UPDATE inbox_buffer
     SET claimed_at = NULL
   WHERE claimed_at IS NOT NULL
     AND claimed_at < now() - p_older_than;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
