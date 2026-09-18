/**
 * Migration runner. Migrations are plain `.sql` files in `packages/db/migrations`, applied in
 * filename order inside a transaction and recorded in `schema_migrations`.
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { getDatabase, exec, get, run, all } from './db.js';
import { createLogger } from '@kinetiq/shared';

const here = path.dirname(url.fileURLToPath(import.meta.url));
export const migrationsDir = path.resolve(here, '..', 'migrations');
const log = createLogger('db:migrate');

function ensureMigrationsTable() {
  exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      checksum TEXT
    );
  `);
}

export function listMigrationFiles(dir = migrationsDir) {
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort();
}

export function appliedMigrations() {
  ensureMigrationsTable();
  return new Set(all('SELECT name FROM schema_migrations ORDER BY name').map((row) => row.name));
}

export function migrate({ dir = migrationsDir, verbose = true } = {}) {
  getDatabase();
  ensureMigrationsTable();
  const applied = appliedMigrations();
  const files = listMigrationFiles(dir);
  const ran = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const db = getDatabase();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* nothing to roll back */
      }
      throw new Error(`Migration ${file} failed: ${error.message}`);
    }
    run('INSERT INTO schema_migrations (name) VALUES (?)', [file]);
    ran.push(file);
    if (verbose) log.info(`applied ${file}`);
  }
  return ran;
}

export function migrationStatus(dir = migrationsDir) {
  ensureMigrationsTable();
  const applied = appliedMigrations();
  return listMigrationFiles(dir).map((name) => ({
    name,
    applied: applied.has(name),
    appliedAt: get('SELECT applied_at FROM schema_migrations WHERE name = ?', [name])?.applied_at ?? null,
  }));
}

export default migrate;
