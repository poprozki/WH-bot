BEGIN;

ALTER TABLE masters ALTER COLUMN color SET DEFAULT '#8a8a92';

SET LOCAL app.admin = 'on';

UPDATE masters SET color = CASE color
    WHEN '#f472b6' THEN '#f2f2f3'
    WHEN '#a78bfa' THEN '#9a9aa2'
    WHEN '#60a5fa' THEN '#55555c'
    WHEN '#c084fc' THEN '#8a8a92'
  END
 WHERE color IN ('#f472b6', '#a78bfa', '#60a5fa', '#c084fc');

COMMIT;
