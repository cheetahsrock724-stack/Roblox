#!/usr/bin/env node
/**
 * One-command local development entry point: `npm run dev`.
 *
 * Boots the whole platform — website, JSON API, asset service, matchmaking and the in-process
 * game realms — on a single port with development defaults (SQLite file under ./var, no external
 * services, demo content seeded on first run).
 */
import { createPlatform } from '../apps/web/src/index.js';
import { config, ensureDirs, platformConfig, paths } from '@kinetiq/shared';

ensureDirs();

const port = Number(process.env.PORT ?? config.port);
const host = process.env.HOST ?? '0.0.0.0';

const platform = await createPlatform({ port, host });

const url = `http://localhost:${platform.port}`;
console.log('');
console.log(`  ${platformConfig.platformName} — ${platformConfig.platformTagline}`);
console.log('');
console.log(`  website      ${url}/`);
console.log(`  discover     ${url}/#/discover`);
console.log(`  creator      ${url}/#/creator`);
console.log(`  {editor}      ${url}/editor`.replace('{editor}', platformConfig.editorName));
console.log(`  {client}      ${url}/client`.replace('{client}', platformConfig.clientName));
console.log(`  admin        ${url}/admin`);
console.log(`  api health   ${url}/api/health`);
console.log(`  data         ${paths.data}`);
console.log('');
console.log('  Demo accounts (seeded on first run):');
console.log('    AriDev / demo-Password1!        (creator)');
console.log('    NiaPlays / demo-Password1!      (player)');
console.log('    PlatformAdmin / demo-Password1! (administrator)');
console.log('    ModTeam / demo-Password1!       (moderator)');
console.log('');

const shutdown = async (signal) => {
  console.log(`\n  received ${signal}, shutting down…`);
  await platform.close();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
