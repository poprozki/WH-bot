BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'business_shape') THEN
    CREATE TYPE business_shape AS ENUM (
      'booking',   -- запись к ресурсу на время: салон, барбершоп, СТО, врач
      'order',     -- заказ без слота: кофейня, доставка       (пока не реализовано)
      'deal'       -- долгая сделка: надгробия, ателье, торты  (пока не реализовано)
    );
  END IF;
END $$;

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS shape business_shape NOT NULL DEFAULT 'booking';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS vertical text NOT NULL DEFAULT 'salon';

COMMENT ON COLUMN tenants.shape IS
  'Форма бизнеса — определяет доменный модуль. Меняется только миграцией данных.';
COMMENT ON COLUMN tenants.vertical IS
  'Ниша внутри формы: salon, barber, sto, dentist, tutor, restaurant. Задаёт словарь и умолчания.';

CREATE TABLE IF NOT EXISTS verticals (
  code          text PRIMARY KEY,
  shape         business_shape NOT NULL DEFAULT 'booking',
  title         text NOT NULL,

  res_one       text NOT NULL,
  res_gen       text NOT NULL,
  res_dat       text NOT NULL,
  res_acc       text NOT NULL,
  res_many      text NOT NULL,
  res_female    boolean NOT NULL DEFAULT true,

  svc_one       text NOT NULL,
  svc_gen       text NOT NULL,
  svc_acc       text NOT NULL,
  svc_many      text NOT NULL,

  appt_one      text NOT NULL,
  appt_acc      text NOT NULL,
  appt_many     text NOT NULL,

  client_one    text NOT NULL DEFAULT 'клиентка',
  client_many   text NOT NULL DEFAULT 'клиентки',
  client_female boolean NOT NULL DEFAULT true,

  slot_step_min     integer NOT NULL DEFAULT 15,
  buffer_min        integer NOT NULL DEFAULT 10,
  min_lead_min      integer NOT NULL DEFAULT 90,
  horizon_days      integer NOT NULL DEFAULT 60,
  needs_resource    boolean NOT NULL DEFAULT true,
  needs_address     boolean NOT NULL DEFAULT false,
  allows_photos     boolean NOT NULL DEFAULT true,

  prompt_extra  text NOT NULL DEFAULT ''
);

INSERT INTO verticals (
  code, shape, title,
  res_one, res_gen, res_dat, res_acc, res_many, res_female,
  svc_one, svc_gen, svc_acc, svc_many,
  appt_one, appt_acc, appt_many,
  slot_step_min, buffer_min, min_lead_min, horizon_days,
  needs_resource, needs_address, allows_photos, prompt_extra
) VALUES
  ('salon', 'booking', 'Салон красоты',
   'мастер','мастера','мастеру','мастера','мастера', true,
   'услуга','услуги','услугу','услуги',
   'запись','запись','записи',
   15, 10, 90, 60, true, false, true,
   'Клиентки часто присылают фото желаемого дизайна. Скажи, что передала мастеру, и продолжай запись. Цену по фото не называй — это решает мастер.'),

  ('barber', 'booking', 'Барбершоп',
   'барбер','барбера','барберу','барбера','барберы', false,
   'услуга','услуги','услугу','услуги',
   'запись','запись','записи',
   15, 5, 60, 45, true, false, true,
   'Обращайся к клиентам в мужском роде. Тон дружелюбный, но без сюсюканья.'),

  ('sto', 'booking', 'Автосервис',
   'пост','поста','посту','пост','посты', false,
   'работа','работы','работу','работы',
   'запись','запись','записи',
   30, 15, 120, 30, true, false, true,
   'Уточняй марку, модель и год машины — от этого зависит время работ. Точную цену до осмотра не называй: скажи «от такой-то суммы, точнее скажет мастер после осмотра».'),

  ('dentist', 'booking', 'Стоматология',
   'врач','врача','врачу','врача','врачи', false,
   'приём','приёма','приём','приёмы',
   'запись','запись','записи',
   30, 15, 180, 90, true, false, false,
   'НИКОГДА не давай медицинских советов, не ставь диагнозов и не оценивай снимки. Любой вопрос о боли, воспалении или лечении — сразу к живому администратору.'),

  ('tutor', 'booking', 'Репетитор',
   'преподаватель','преподавателя','преподавателю','преподавателя','преподаватели', false,
   'занятие','занятия','занятие','занятия',
   'занятие','занятие','занятия',
   30, 0, 120, 30, true, false, false,
   'Уточняй предмет и класс или курс. Занятия обычно повторяются еженедельно — если ученик ходит регулярно, предлагай то же время.'),

  ('restaurant', 'booking', 'Ресторан',
   'столик','столика','столику','столик','столики', false,
   'бронь','брони','бронь','брони',
   'бронь','бронь','брони',
   30, 0, 60, 30, true, false, false,
   'Уточняй количество гостей — от этого зависит столик. Спрашивай про повод: день рождения меняет подготовку.')
ON CONFLICT (code) DO NOTHING;

UPDATE tenants SET vertical = 'salon', shape = 'booking' WHERE vertical IS NULL OR vertical = '';

ALTER TABLE tenants
  ADD CONSTRAINT tenants_vertical_fk FOREIGN KEY (vertical) REFERENCES verticals(code);

GRANT SELECT ON verticals TO bot;

COMMIT;
