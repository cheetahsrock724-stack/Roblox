/** Minimal structured logger with levels, timestamps and redaction of obvious secrets. */
import { platformConfig } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const SECRET_KEY_RE = /(password|token|secret|authorization|cookie|apikey|api_key)/i;

function redact(value, depth = 0) {
  if (depth > 4) return '[deep]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = SECRET_KEY_RE.test(key) ? '[redacted]' : redact(val, depth + 1);
  }
  return out;
}

export function createLogger(scope = 'platform', { level = process.env.LOG_LEVEL || 'info' } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;

  const emit = (levelName, message, meta) => {
    if (LEVELS[levelName] < min) return;
    const line = {
      ts: new Date().toISOString(),
      level: levelName,
      scope,
      msg: String(message),
      ...(meta && Object.keys(meta).length ? { meta: redact(meta) } : {}),
    };
    const text = process.env.LOG_FORMAT === 'json' ? JSON.stringify(line) : formatPretty(line);
    if (levelName === 'error' || levelName === 'warn') process.stderr.write(`${text}\n`);
    else process.stdout.write(`${text}\n`);
  };

  return {
    scope,
    debug: (msg, meta) => emit('debug', msg, meta),
    info: (msg, meta) => emit('info', msg, meta),
    warn: (msg, meta) => emit('warn', msg, meta),
    error: (msg, meta) => emit('error', msg, meta),
    child: (childScope) => createLogger(`${scope}:${childScope}`, { level }),
    banner: (message) => {
      if (min > LEVELS.info) return;
      process.stdout.write(`\n  ${platformConfig.platformName}  \u2014  ${message}\n\n`);
    },
  };
}

function formatPretty(line) {
  const time = line.ts.slice(11, 19);
  const level = line.level.toUpperCase().padEnd(5);
  const meta = line.meta ? ` ${JSON.stringify(line.meta)}` : '';
  return `${time} ${level} [${line.scope}] ${line.msg}${meta}`;
}

export const logger = createLogger('platform');
export default createLogger;
