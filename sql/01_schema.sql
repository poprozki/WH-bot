SET timezone = 'Asia/Almaty';

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE masters (
  id            serial PRIMARY KEY,
  name          text        NOT NULL,

  active        boolean     NOT NULL DEFAULT true,
  color         text        NOT NULL DEFAULT '#8a8a92',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE services (
  id            serial PRIMARY KEY,
  name          text        NOT NULL,

  aliases       text[]      NOT NULL DEFAULT '{}',
  duration_min  integer     NOT NULL CHECK (duration_min > 0 AND duration_min <= 480),
  price_kzt     integer     NOT NULL CHECK (price_kzt >= 0),
  active        boolean     NOT NULL DEFAULT true,
  sort_order    integer     NOT NULL DEFAULT 100,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE master_services (
  master_id     integer NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  service_id    integer NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  price_kzt     integer NULL CHECK (price_kzt IS NULL OR price_kzt >= 0),
  duration_min  integer NULL CHECK (duration_min IS NULL OR duration_min > 0),
  PRIMARY KEY (master_id, service_id)
);

CREATE TABLE shifts (
  id            serial PRIMARY KEY,
  master_id     integer NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  weekday       smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  starts_time   time    NOT NULL,
  ends_time     time    NOT NULL,
  CHECK (ends_time > starts_time),
  UNIQUE (master_id, weekday, starts_time)
);

CREATE TABLE schedule_exceptions (
  id            serial PRIMARY KEY,

  master_id     integer NULL REFERENCES masters(id) ON DELETE CASCADE,
  kind          text    NOT NULL CHECK (kind IN ('off', 'work')),
  span          tstzrange NOT NULL,
  reason        text    NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  EXCLUDE USING gist (
    coalesce(master_id, -1) WITH =,
    kind WITH =,
    span WITH &&
  )
);
CREATE INDEX ON schedule_exceptions USING gist (span);

CREATE TABLE clients (
  id                serial PRIMARY KEY,

  phone_e164        text        NOT NULL UNIQUE CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),

  jids              text[]      NOT NULL DEFAULT '{}',

  name              text        NULL,

  preferred_master  integer     NULL REFERENCES masters(id) ON DELETE SET NULL,
  usual_service     integer     NULL REFERENCES services(id) ON DELETE SET NULL,

  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_visit_at     timestamptz NULL,
  visits_count      integer     NOT NULL DEFAULT 0,
  no_show_count     integer     NOT NULL DEFAULT 0,

  bot_paused_until  timestamptz NULL,

  opted_out         boolean     NOT NULL DEFAULT false,

  notes             text        NOT NULL DEFAULT '',

  blocked           boolean     NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON clients USING gin (jids);
CREATE INDEX ON clients (last_seen_at DESC);

CREATE TYPE appt_status AS ENUM (
  'pending',
  'confirmed',
  'done',
  'cancelled',
  'no_show'
);

CREATE TABLE appointments (
  id            serial PRIMARY KEY,
  client_id     integer     NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  master_id     integer     NOT NULL REFERENCES masters(id) ON DELETE RESTRICT,
  service_id    integer     NOT NULL REFERENCES services(id) ON DELETE RESTRICT,

  starts_at     timestamptz NOT NULL,
  duration_min  integer     NOT NULL CHECK (duration_min > 0),
  buffer_min    integer     NOT NULL DEFAULT 10 CHECK (buffer_min >= 0),

  ends_at       timestamptz NOT NULL,
  slot          tstzrange   NOT NULL,

  price_kzt     integer     NOT NULL CHECK (price_kzt >= 0),
  status        appt_status NOT NULL DEFAULT 'pending',
  source        text        NOT NULL DEFAULT 'bot' CHECK (source IN ('bot', 'panel', 'walkin')),
  comment       text        NOT NULL DEFAULT '',

  reminded_24h_at timestamptz NULL,
  reminded_2h_at  timestamptz NULL,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT no_double_booking EXCLUDE USING gist (
    master_id WITH =,
    slot WITH &&
  ) WHERE (status IN ('pending', 'confirmed'))
);
CREATE INDEX ON appointments (starts_at);
CREATE INDEX ON appointments (client_id, starts_at DESC);
CREATE INDEX ON appointments USING gist (slot);
CREATE INDEX ON appointments (status, starts_at) WHERE status IN ('pending', 'confirmed');

CREATE OR REPLACE FUNCTION appointments_derive() RETURNS trigger AS $$
BEGIN
  NEW.ends_at := NEW.starts_at + make_interval(mins => NEW.duration_min);
  NEW.slot    := tstzrange(
                   NEW.starts_at,
                   NEW.ends_at + make_interval(mins => NEW.buffer_min),
                   '[)'
                 );
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_appointments_derive
  BEFORE INSERT OR UPDATE OF starts_at, duration_min, buffer_min
  ON appointments
  FOR EACH ROW EXECUTE FUNCTION appointments_derive();

CREATE TABLE appointments_history (
  id            bigserial PRIMARY KEY,
  appointment_id integer   NOT NULL,
  op            text       NOT NULL CHECK (op IN ('INSERT', 'UPDATE', 'DELETE')),
  actor         text       NOT NULL DEFAULT 'system',
  old_row       jsonb      NULL,
  new_row       jsonb      NULL,
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON appointments_history (appointment_id, at DESC);

CREATE OR REPLACE FUNCTION appointments_audit() RETURNS trigger AS $$
BEGIN
  INSERT INTO appointments_history (appointment_id, op, actor, old_row, new_row)
  VALUES (
    coalesce(NEW.id, OLD.id),
    TG_OP,
    coalesce(current_setting('app.actor', true), 'system'),
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END
  );
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_appointments_audit
  AFTER INSERT OR UPDATE OR DELETE ON appointments
  FOR EACH ROW EXECUTE FUNCTION appointments_audit();

CREATE TABLE inbox_buffer (
  id            bigserial PRIMARY KEY,
  channel       text        NOT NULL DEFAULT 'whatsapp',
  chat_id       text        NOT NULL,
  client_id     integer     NULL REFERENCES clients(id) ON DELETE CASCADE,

  msg_id        text        NOT NULL,

  body          text        NOT NULL,
  kind          text        NOT NULL DEFAULT 'text' CHECK (kind IN ('text','voice','image','other')),
  received_at   timestamptz NOT NULL DEFAULT now(),
  claimed_at    timestamptz NULL,

  UNIQUE (channel, msg_id)
);
CREATE INDEX ON inbox_buffer (channel, chat_id) WHERE claimed_at IS NULL;
CREATE INDEX ON inbox_buffer (claimed_at) WHERE claimed_at IS NOT NULL;

CREATE TABLE messages (
  id            bigserial PRIMARY KEY,
  client_id     integer     NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  role          text        NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
  content       text        NOT NULL,
  meta          jsonb       NOT NULL DEFAULT '{}',
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON messages (client_id, at DESC);

CREATE TABLE outbox (
  id            bigserial PRIMARY KEY,
  chat_id       text        NOT NULL,
  client_id     integer     NULL REFERENCES clients(id) ON DELETE SET NULL,
  kind          text        NOT NULL DEFAULT 'text' CHECK (kind IN ('text','image')),
  body          text        NOT NULL,
  media_path    text        NULL,

  send_after    timestamptz NOT NULL DEFAULT now(),
  attempts      integer     NOT NULL DEFAULT 0,
  sent_at       timestamptz NULL,
  wa_message_id text        NULL,
  ack           smallint    NULL,
  last_error    text        NULL,
  dedup_key     text        NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dedup_key)
);
CREATE INDEX ON outbox (send_after) WHERE sent_at IS NULL;

CREATE TABLE panel_identities (
  email         text        PRIMARY KEY,
  display_name  text        NOT NULL DEFAULT '',
  role          text        NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','master')),
  master_id     integer     NULL REFERENCES masters(id) ON DELETE SET NULL,
  last_seen_at  timestamptz NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE push_subscriptions (
  id            serial PRIMARY KEY,
  email         text        NOT NULL REFERENCES panel_identities(email) ON DELETE CASCADE,
  endpoint      text        NOT NULL UNIQUE,
  p256dh        text        NOT NULL,
  auth          text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_ok_at    timestamptz NULL,
  fail_count    integer     NOT NULL DEFAULT 0
);

CREATE TABLE pii_reveals (
  id            bigserial PRIMARY KEY,
  email         text        NOT NULL,
  client_id     integer     NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON pii_reveals (at DESC);

CREATE TABLE settings (
  id                  boolean PRIMARY KEY DEFAULT true CHECK (id),
  salon_name          text    NOT NULL DEFAULT 'Студия маникюра',
  address             text    NOT NULL DEFAULT '',
  quiet_from          time    NOT NULL DEFAULT '21:00',
  quiet_to            time    NOT NULL DEFAULT '09:00',
  booking_horizon_days integer NOT NULL DEFAULT 60 CHECK (booking_horizon_days BETWEEN 1 AND 365),
  min_lead_minutes    integer NOT NULL DEFAULT 90,
  cancel_deadline_hours integer NOT NULL DEFAULT 3,
  default_buffer_min  integer NOT NULL DEFAULT 10,
  bot_enabled         boolean NOT NULL DEFAULT true
);
INSERT INTO settings (id) VALUES (true) ON CONFLICT DO NOTHING;
