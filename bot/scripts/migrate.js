#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function findDir() {
  if (process.env.MIGRATIONS_DIR) return process.env.MIGRATIONS_DIR;
  const candidates = [
    path.resolve(__dirname, '..', 'sql', 'migrations'),
    path.resolve(__dirname, '..', '..', 'sql', 'migrations'),
  ];
  for (const d of candidates) {
    try { await fs.access(d); return d; } catch {  }
  }
  throw new Error(
    `Каталог миграций не найден. Искал: ${candidates.join(', ')}. ` +
    'Задайте MIGRATIONS_DIR явно.'
  );
}

const DRY = process.argv.includes('--dry');

const BASELINE = process.argv.includes('--baseline');

const URL = process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL;
if (!URL) {
  console.error('Не задан MIGRATE_DATABASE_URL или DATABASE_URL');
  process.exit(1);
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

const pool = new pg.Pool({ connectionString: URL, max: 2 });

async function main() {
  const DIR = await findDir();
  console.log(`Миграции из: ${DIR}`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      ms         integer NOT NULL DEFAULT 0
    )`);

  const files = (await fs.readdir(DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows: done } = await pool.query('SELECT name, checksum FROM schema_migrations');
  const applied = new Map(done.map((r) => [r.name, r.checksum]));

  let ran = 0;
  for (const name of files) {
    const sql = await fs.readFile(path.join(DIR, name), 'utf8');
    const sum = sha(sql);

    if (applied.has(name)) {

      if (applied.get(name) !== sum) {
        console.warn(`  ⚠ ${name}: файл изменился после применения ` +
          '(в базе другая версия). Сделайте новую миграцию вместо правки старой.');
      }
      continue;
    }

    if (DRY) { console.log(`  будет применена: ${name}`); ran += 1; continue; }

    if (BASELINE) {
      await pool.query(
        'INSERT INTO schema_migrations (name, checksum, ms) VALUES ($1,$2,0) ON CONFLICT DO NOTHING',
        [name, sum]);
      console.log(`  ⊙ ${name} — отмечена как применённая (baseline)`);
      ran += 1;
      continue;
    }

    const c = await pool.connect();
    const t0 = Date.now();
    try {

      await c.query("SET lock_timeout = '5s'");
      await c.query("SET statement_timeout = '120s'");

      await c.query(sql);
      const ms = Date.now() - t0;
      await c.query(
        'INSERT INTO schema_migrations (name, checksum, ms) VALUES ($1,$2,$3)',
        [name, sum, ms]);
      console.log(`  ✓ ${name} (${ms} мс)`);
      ran += 1;
    } catch (e) {
      console.error(`  ✗ ${name}`);
      console.error(`    ${e.message}`);
      if (e.hint) console.error(`    подсказка: ${e.hint}`);
      if (e.code === '55P03' || /lock timeout/i.test(e.message)) {
        console.error('    Не удалось взять блокировку: таблицу держит работающий бот.');
        console.error('    Остановите бота (docker compose stop bot), примените, запустите обратно.');
      }
      await pool.end();
      process.exit(1);
    } finally {
      c.release();
    }
  }

  if (ran === 0) console.log('  всё уже применено');
  else console.log(`\nПрименено миграций: ${ran}`);
  await pool.end();
}

main().catch(async (e) => {
  console.error('Сбой применения миграций:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
