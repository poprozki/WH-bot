BEGIN;

CREATE OR REPLACE FUNCTION free_slots_reason(
  p_service_id integer,
  p_date       date,
  p_master_id  integer DEFAULT NULL
)
RETURNS TABLE (code text, detail text)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_settings settings%ROWTYPE;
  v_today    date;
  v_horizon  date;
  v_has_master boolean;
  v_works    boolean;
  v_salon_off text;
  v_master_back date;
BEGIN
  SELECT * INTO v_settings FROM settings LIMIT 1;
  v_today := (now() AT TIME ZONE 'Asia/Almaty')::date;
  v_horizon := v_today + v_settings.booking_horizon_days;

  -- Дата в прошлом
  IF p_date < v_today THEN
    RETURN QUERY SELECT 'PAST'::text, ''::text; RETURN;
  END IF;

  -- Слишком далеко вперёд
  IF p_date > v_horizon THEN
    RETURN QUERY SELECT 'TOO_FAR'::text, to_char(v_horizon, 'DD.MM.YYYY'); RETURN;
  END IF;

  -- Салон закрыт целиком: праздник, ремонт, выходной
  SELECT reason INTO v_salon_off
    FROM schedule_exceptions
   WHERE kind = 'off' AND master_id IS NULL
     AND span && tstzrange((p_date)::timestamp AT TIME ZONE 'Asia/Almaty',
                           (p_date + 1)::timestamp AT TIME ZONE 'Asia/Almaty', '[)')
   LIMIT 1;
  IF v_salon_off IS NOT NULL THEN
    RETURN QUERY SELECT 'CLOSED_SALON'::text, COALESCE(v_salon_off, ''); RETURN;
  END IF;

  -- Указан мастер: работает ли он в этот день вообще
  IF p_master_id IS NOT NULL THEN
    SELECT EXISTS (SELECT 1 FROM working_spans(p_master_id, p_date)) INTO v_works;
    IF NOT v_works THEN
      -- Когда мастер выходит в ближайшие две недели
      SELECT d INTO v_master_back
        FROM generate_series(p_date + 1, p_date + 14, interval '1 day') g(d)
       WHERE EXISTS (SELECT 1 FROM working_spans(p_master_id, g.d::date))
       LIMIT 1;
      RETURN QUERY SELECT 'MASTER_OFF'::text,
        COALESCE(to_char(v_master_back, 'DD.MM'), ''); RETURN;
    END IF;
  ELSE
    -- Никто не работает в этот день
    SELECT EXISTS (
      SELECT 1 FROM masters m WHERE m.active
        AND EXISTS (SELECT 1 FROM working_spans(m.id, p_date))
    ) INTO v_works;
    IF NOT v_works THEN
      RETURN QUERY SELECT 'CLOSED_SALON'::text, 'выходной'::text; RETURN;
    END IF;
  END IF;

  -- Услугу вообще кто-нибудь делает?
  SELECT EXISTS (
    SELECT 1 FROM masters m
     WHERE m.active AND (p_master_id IS NULL OR m.id = p_master_id)
       AND (NOT EXISTS (SELECT 1 FROM master_services y WHERE y.master_id = m.id)
            OR EXISTS (SELECT 1 FROM master_services x
                        WHERE x.master_id = m.id AND x.service_id = p_service_id))
  ) INTO v_has_master;
  IF NOT v_has_master THEN
    RETURN QUERY SELECT 'MASTER_CANT_DO'::text, ''::text; RETURN;
  END IF;

  -- Сегодня, но уже поздно: рабочий день ещё идёт, а времени на подготовку нет
  IF p_date = v_today THEN
    RETURN QUERY SELECT 'TOO_LATE_TODAY'::text,
      to_char(v_settings.min_lead_minutes, 'FM999'); RETURN;
  END IF;

  -- Всё остальное — действительно всё занято
  RETURN QUERY SELECT 'FULLY_BOOKED'::text, ''::text;
END $$;

COMMENT ON FUNCTION free_slots_reason IS
  'Почему на дату нет свободного времени. Вызывается ТОЛЬКО когда free_slots вернула пусто.';

COMMIT;
