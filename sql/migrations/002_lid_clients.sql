BEGIN;

ALTER TABLE clients ALTER COLUMN phone_e164 DROP NOT NULL;

ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_phone_e164_check;
ALTER TABLE clients ADD CONSTRAINT clients_phone_e164_check
  CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{7,14}$');

ALTER TABLE clients ADD COLUMN IF NOT EXISTS primary_jid text;
UPDATE clients SET primary_jid = jids[1] WHERE primary_jid IS NULL AND array_length(jids,1) > 0;

DROP INDEX IF EXISTS clients_tenant_phone_uq;
CREATE UNIQUE INDEX IF NOT EXISTS clients_phone_uq
  ON clients (phone_e164) WHERE phone_e164 IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS clients_jid_uq
  ON clients (primary_jid) WHERE primary_jid IS NOT NULL;

CREATE OR REPLACE FUNCTION upsert_client(
  p_phone text,
  p_jid   text,
  p_name  text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE v_id integer;
BEGIN
  IF p_jid IS NULL OR p_jid = '' THEN
    RAISE EXCEPTION 'upsert_client: не указан адрес чата';
  END IF;

  -- 1. Ищем по телефону, если он известен
  IF p_phone IS NOT NULL THEN
    SELECT id INTO v_id FROM clients WHERE phone_e164 = p_phone;
  END IF;

  -- 2. Иначе по любому известному адресу чата
  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM clients
     WHERE primary_jid = p_jid OR jids @> ARRAY[p_jid]
     LIMIT 1;
  END IF;

  IF v_id IS NULL THEN
    INSERT INTO clients (phone_e164, primary_jid, jids, name)
    VALUES (p_phone, p_jid, ARRAY[p_jid], p_name)
    RETURNING id INTO v_id;
  ELSE
    UPDATE clients
       SET jids = CASE WHEN jids @> ARRAY[p_jid] THEN jids ELSE jids || p_jid END,
           -- телефон дописываем, если раньше был неизвестен
           phone_e164 = COALESCE(phone_e164, p_phone),
           primary_jid = COALESCE(primary_jid, p_jid),
           name = COALESCE(name, p_name),
           last_seen_at = now()
     WHERE id = v_id;
  END IF;

  RETURN v_id;
END $$;

COMMIT;
