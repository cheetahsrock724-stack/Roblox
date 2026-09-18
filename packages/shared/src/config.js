/**
 * Platform configuration.
 *
 * Every user-visible product name lives here so it can be changed in exactly one place:
 *   - `platform.config.json` at the repository root (edit `platformName`)
 *   - any `PLATFORM_*` / `KINETIQ_*` environment variable (highest priority)
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import os from 'node:os';

const here = path.dirname(url.fileURLToPath(import.meta.url));

/** Repository root, resolved from this file (packages/shared/src/config.js -> ../../..). */
export const repoRoot = path.resolve(here, '..', '..', '..');

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function deepMerge(base, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return base ?? extra;
  const out = Array.isArray(base) ? [...base] : { ...(base ?? {}) };
  for (const [key, value] of Object.entries(extra)) {
    if (key.startsWith('$')) continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = deepMerge(base?.[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

const defaults = {
  platformName: 'Kinetiq',
  platformTagline: 'Build worlds. Play together.',
  platformDomain: 'kinetiq.local',
  currencyName: 'Credits',
  currencySymbol: '\u25c8',
  currencyCode: 'KTC',
  editorName: 'Forge',
  clientName: 'Play',
  serverName: 'Realm',
  supportEmail: 'support@kinetiq.local',
  brandColors: {
    primary: '#3d5afe',
    accent: '#00e5c0',
    surface: '#0d1220',
    danger: '#ff4d6d',
  },
  features: {
    emailVerification: false,
    requireEmailVerificationToPlay: false,
    marketplaceEnabled: true,
    groupsEnabled: true,
    chatEnabled: true,
    publicApiEnabled: true,
    registrationEnabled: true,
  },
  economy: {
    signupBonus: 500,
    dailyBonus: 100,
    developerRevenueShare: 0.7,
    minPayout: 1000,
  },
  safety: {
    chatFilterEnabled: true,
    maxMessageLength: 240,
    chatRateLimitPerMinute: 20,
    minAccountAgeMinutesForChat: 0,
    accountLockoutAttempts: 8,
    accountLockoutMinutes: 15,
  },
  games: {
    defaultMaxPlayers: 12,
    maxMaxPlayers: 60,
    defaultGameVersion: 1,
    streamingRadiusStuds: 512,
    serverIdleShutdownSeconds: 300,
  },
};

const fileConfig =
  readJsonIfExists(path.join(repoRoot, 'platform.config.json')) ??
  readJsonIfExists(path.join(repoRoot, 'platform.config.example.json')) ??
  {};

/** Deployment/runtime settings (not user-visible branding). */
const runtime = {
  env: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
  host: process.env.HOST || '0.0.0.0',
  port: Number(process.env.PORT || 3000),
  dataDir: process.env.KINETIQ_DATA_DIR || path.join(repoRoot, 'var'),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
  sessionSecret: process.env.SESSION_SECRET || '',
  joinTokenSecret: process.env.JOIN_TOKEN_SECRET || '',
  assetMaxBytes: Number(process.env.ASSET_MAX_BYTES || 12 * 1024 * 1024),
  realmHostEnabled: process.env.REALM_HOST_ENABLED !== '0',
  realmHostStartPort: Number(process.env.REALM_HOST_START_PORT || 41000),
  realmHostEndPort: Number(process.env.REALM_HOST_END_PORT || 41999),
  /** When true the website proxies realm websockets through the single public port. */
  tunnelRealmTraffic: process.env.TUNNEL_REALM_TRAFFIC !== '0',
  registrationOpen: process.env.REGISTRATION_OPEN !== '0',
  trustProxy: process.env.TRUST_PROXY !== '0',
  cpus: os.cpus().length,
};

const envOverrides = {};
if (process.env.PLATFORM_NAME) envOverrides.platformName = process.env.PLATFORM_NAME;
if (process.env.PLATFORM_TAGLINE) envOverrides.platformTagline = process.env.PLATFORM_TAGLINE;
if (process.env.CURRENCY_NAME) envOverrides.currencyName = process.env.CURRENCY_NAME;

/**
 * Branding/product configuration, merged as: defaults <- platform.config.json <- environment.
 * The runtime/deployment settings are merged in as flat keys too, so a single object exposes both
 * `platformConfig.platformName` (branding) and `platformConfig.port` (deployment). The nested
 * `platform` key is kept for templates that read `config.platform.platformName`.
 */
const branding = deepMerge(deepMerge(defaults, fileConfig), envOverrides);

export const platformConfig = { ...runtime, ...branding, platform: branding };

/** Alias kept for readability at call sites: `import { config } from '@kinetiq/shared'`. */
export const config = platformConfig;

/**
 * Effective data directory.
 *
 * Read through `process.env` on every access (rather than only at import time) so tests and
 * multi-instance deployments can point a process at an isolated directory after modules load.
 */
export function dataDir() {
  return process.env.KINETIQ_DATA_DIR || config.dataDir;
}

/** Derived paths used across the platform. `files` entries are never created as directories. */
export const paths = {
  get data() {
    return dataDir();
  },
  get database() {
    return path.join(dataDir(), 'platform.db');
  },
  get assets() {
    return path.join(dataDir(), 'assets');
  },
  get releases() {
    return path.join(dataDir(), 'releases');
  },
  get clientDist() {
    return path.join(dataDir(), 'client-dist');
  },
  get launcherCache() {
    return path.join(dataDir(), 'launcher-cache');
  },
  get logs() {
    return path.join(dataDir(), 'logs');
  },
  get tmp() {
    return path.join(dataDir(), 'tmp');
  },
  get uploads() {
    return path.join(dataDir(), 'uploads');
  },
  get serverLogs() {
    return path.join(dataDir(), 'logs', 'realms');
  },
};

/** Keys in `paths` that are files rather than directories. */
const FILE_PATHS = new Set(['database']);

export function ensureDirs() {
  for (const [key, dir] of Object.entries(paths)) {
    if (typeof dir !== 'string' || FILE_PATHS.has(key)) continue;
    // Guard against a stale directory left behind where a file belongs.
    if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) continue;
    fs.mkdirSync(dir, { recursive: true });
  }
  const dbFile = paths.database;
  if (fs.existsSync(dbFile) && fs.statSync(dbFile).isDirectory()) {
    // A previous version of this code created the DB path as a directory; remove the empty dir.
    try {
      fs.rmdirSync(dbFile);
    } catch {
      /* leave it in place if it is not empty — the operator must resolve it */
    }
  }
}

/** A stable, per-installation secret, persisted to the data directory so restarts keep sessions. */
export function persistedSecret(name, envValue) {
  if (envValue) return envValue;
  ensureDirs();
  const file = path.join(paths.data, `${name}.key`);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* generate below */
  }
  const secret = `${name}_${Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString('base64url')}`;
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export function sessionSecret() {
  return persistedSecret('session-secret', config.sessionSecret);
}

export function joinTokenSecret() {
  return persistedSecret('join-token-secret', config.joinTokenSecret);
}

export const PRODUCT = {
  get name() {
    return platformConfig.platformName;
  },
  get currency() {
    return platformConfig.currencyName;
  },
  get editor() {
    return `${platformConfig.platformName} ${platformConfig.editorName}`;
  },
  get client() {
    return `${platformConfig.platformName} ${platformConfig.clientName}`;
  },
  get server() {
    return `${platformConfig.platformName} ${platformConfig.serverName}`;
  },
};

export default config;
