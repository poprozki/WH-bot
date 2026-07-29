BEGIN;

GRANT INSERT ON settings, services, masters, master_services, shifts TO bot;

GRANT INSERT, UPDATE, DELETE ON schedule_exceptions TO bot;

REVOKE DELETE ON services, masters FROM bot;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO bot;

COMMIT;
