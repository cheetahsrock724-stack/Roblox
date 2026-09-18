#!/usr/bin/env node
/**
 * Seeds (or re-seeds) the platform's demo content from the command line:
 *
 *   npm run seed                 — seed if the database has no games
 *   npm run seed -- --reset      — wipe platform tables, then seed
 *   npm run seed -- --accounts   — run everything through the public HTTP API instead
 *
 * Everything created here goes through the same repositories and creator APIs a normal user
 * would use; there are no privileged shortcuts for demo content.
 */
import * as db from './index.js';
import { createLogger, platformConfig } from '@kinetiq/shared';

const log = createLogger('seed');

async function main() {
  const args = process.argv.slice(2);
  const reset = args.includes('--reset');
  db.runMigrations({ verbose: false });

  if (reset) {
    log.warn('wiping platform content tables');
    db.transaction(() => {
      for (const table of [
        'player_badges',
        'badges',
        'game_scripts',
        'game_versions',
        'game_assets',
        'games',
        'inventory',
        'avatar_items',
        'assets',
        'transactions',
        'servers_joins',
      ]) {
        try {
          db.run(`DELETE FROM ${table}`);
        } catch {
          /* table may not exist in this schema revision */
        }
      }
    });
  }

  const { seedIfEmpty } = await import('../../apps/web/src/services/seed.js');
  const result = seedIfEmpty({ log });
  if (!result.seeded) {
    log.info('database already has games — nothing to seed (use --reset to start over)');
  }
  log.info(`${platformConfig.platformName} demo content ready`);
}

main().catch((error) => {
  log.error('seed failed', { error: error.message });
  process.exit(1);
});
