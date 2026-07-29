SET timezone = 'Asia/Almaty';

INSERT INTO settings (id, salon_name, address, min_lead_minutes, cancel_deadline_hours)
VALUES (true, 'Студия маникюра', 'г. Алматы, ул. Примерная 1', 90, 3)
ON CONFLICT (id) DO UPDATE
  SET salon_name = EXCLUDED.salon_name, address = EXCLUDED.address;

INSERT INTO masters (id, name, color) VALUES
  (1, 'Айгуль',  '#f472b6'),
  (2, 'Динара',  '#a78bfa'),
  (3, 'Сауле',   '#60a5fa')
ON CONFLICT (id) DO NOTHING;
SELECT setval('masters_id_seq', (SELECT max(id) FROM masters));

INSERT INTO services (id, name, aliases, duration_min, price_kzt, sort_order) VALUES
  (1, 'Маникюр без покрытия',
      ARRAY['маникюр','обычный маникюр','просто маникюр','без покрытия'], 60,  6000, 10),
  (2, 'Маникюр + гель-лак',
      ARRAY['гель','гель-лак','шеллак','покрытие','маникюр с покрытием','однотон'], 90, 11000, 20),
  (3, 'Наращивание ногтей',
      ARRAY['наращивание','нарастить','нарастить ногти','длинные ногти'], 180, 20000, 30),
  (4, 'Коррекция наращивания',
      ARRAY['коррекция','подкорректировать','коррекция ногтей'], 120, 15000, 40),
  (5, 'Снятие покрытия',
      ARRAY['снятие','снять','снять гель','снять лак'], 30,  3000, 50),
  (6, 'Педикюр',
      ARRAY['педикюр','ноги'], 90, 13000, 60),
  (7, 'Педикюр + гель-лак',
      ARRAY['педикюр с покрытием','педикюр гель'], 120, 17000, 70),
  (8, 'Дизайн (1 ноготь)',
      ARRAY['дизайн','рисунок','стразы','втирка'], 10,  1000, 80),
  (9, 'Френч',
      ARRAY['френч','френч покрытие'], 100, 13000, 90),
  (10,'Укрепление базой',
      ARRAY['укрепление','база','укрепить'], 75,  9000, 100)
ON CONFLICT (id) DO NOTHING;
SELECT setval('services_id_seq', (SELECT max(id) FROM services));

INSERT INTO master_services (master_id, service_id, price_kzt, duration_min) VALUES
  (1,1,NULL,NULL), (1,2,NULL,NULL), (1,3,24000,180), (1,4,17000,120),
  (1,5,NULL,NULL), (1,8,NULL,NULL), (1,9,NULL,NULL), (1,10,NULL,NULL),

  (2,1,NULL,NULL), (2,2,NULL,NULL), (2,3,NULL,NULL), (2,4,NULL,NULL),
  (2,5,NULL,NULL), (2,6,NULL,NULL), (2,7,NULL,NULL), (2,8,NULL,NULL),
  (2,9,NULL,NULL), (2,10,NULL,NULL),

  (3,1,NULL,NULL), (3,2,NULL,NULL), (3,5,NULL,NULL), (3,6,NULL,NULL),
  (3,7,NULL,NULL), (3,8,NULL,NULL), (3,9,NULL,NULL), (3,10,NULL,NULL)
ON CONFLICT DO NOTHING;

INSERT INTO shifts (master_id, weekday, starts_time, ends_time)
SELECT m, d, '10:00'::time, '20:00'::time
FROM generate_series(1,2) m, generate_series(1,6) d
ON CONFLICT DO NOTHING;

INSERT INTO shifts (master_id, weekday, starts_time, ends_time)
SELECT 3, d, '12:00'::time, '21:00'::time
FROM generate_series(2,6) d
ON CONFLICT DO NOTHING;

INSERT INTO schedule_exceptions (master_id, kind, span, reason)
SELECT m.id,
       'off',
       tstzrange(
         (d + time '14:00') AT TIME ZONE 'Asia/Almaty',
         (d + time '15:00') AT TIME ZONE 'Asia/Almaty', '[)'),
       'обед'
FROM masters m,
     generate_series(
       (now() AT TIME ZONE 'Asia/Almaty')::date,
       (now() AT TIME ZONE 'Asia/Almaty')::date + 90,
       interval '1 day'
     ) d
ON CONFLICT DO NOTHING;

INSERT INTO schedule_exceptions (master_id, kind, span, reason)
SELECT NULL, 'off',
       tstzrange((d)::timestamp AT TIME ZONE 'Asia/Almaty',
                 (d + 1)::timestamp AT TIME ZONE 'Asia/Almaty', '[)'),
       r
FROM (VALUES
  (make_date(EXTRACT(year FROM now())::int + 1, 1, 1),  'Новый год'),
  (make_date(EXTRACT(year FROM now())::int + 1, 1, 2),  'Новый год'),
  (make_date(EXTRACT(year FROM now())::int,     3, 8),  'Международный женский день'),
  (make_date(EXTRACT(year FROM now())::int,     3, 21), 'Наурыз'),
  (make_date(EXTRACT(year FROM now())::int,     3, 22), 'Наурыз'),
  (make_date(EXTRACT(year FROM now())::int,     3, 23), 'Наурыз'),
  (make_date(EXTRACT(year FROM now())::int,     5, 1),  'Праздник единства народа'),
  (make_date(EXTRACT(year FROM now())::int,     5, 7),  'День защитника Отечества'),
  (make_date(EXTRACT(year FROM now())::int,     5, 9),  'День Победы'),
  (make_date(EXTRACT(year FROM now())::int,     7, 6),  'День столицы'),
  (make_date(EXTRACT(year FROM now())::int,     8, 30), 'День Конституции'),
  (make_date(EXTRACT(year FROM now())::int,    10, 25), 'День Республики'),
  (make_date(EXTRACT(year FROM now())::int,    12, 16), 'День Независимости')
) AS h(d, r)
WHERE d >= (now() AT TIME ZONE 'Asia/Almaty')::date
ON CONFLICT DO NOTHING;
