/** Browser logger: forwards to the console and keeps a ring buffer for the developer console. */
const buffer = [];
const MAX = 500;

function record(level, scope, message, meta) {
  const entry = { ts: new Date().toISOString(), level, scope, message: String(message), meta };
  buffer.push(entry);
  if (buffer.length > MAX) buffer.shift();
  const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  consoleFn(`[${scope}] ${message}`, meta ?? '');
  return entry;
}

export function createLogger(scope = 'client') {
  return {
    scope,
    debug: (msg, meta) => record('debug', scope, msg, meta),
    info: (msg, meta) => record('info', scope, msg, meta),
    warn: (msg, meta) => record('warn', scope, msg, meta),
    error: (msg, meta) => record('error', scope, msg, meta),
    child: (childScope) => createLogger(`${scope}:${childScope}`),
  };
}

export function logEntries() {
  return [...buffer];
}

export function clearLogs() {
  buffer.length = 0;
}
