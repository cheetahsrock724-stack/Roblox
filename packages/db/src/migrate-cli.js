#!/usr/bin/env node
/** CLI: apply database migrations (`npm run migrate`). */
import { migrate, migrationStatus } from './migrate.js';
import { closeDatabase } from './db.js';
import { createLogger } from '@kinetiq/shared';

const log = createLogger('migrate');

if (process.argv.includes('--status')) {
  for (const row of migrationStatus()) {
    log.info(`${row.applied ? '[x]' : '[ ]'} ${row.name}${row.appliedAt ? ` (${row.appliedAt})` : ''}`);
  }
  closeDatabase();
  process.exit(0);
}

try {
  const applied = migrate();
  log.info(applied.length ? `applied ${applied.length} migration(s)` : 'database already up to date');
  closeDatabase();
} catch (error) {
  log.error('migration failed', { error: error.message });
  process.exitCode = 1;
}
