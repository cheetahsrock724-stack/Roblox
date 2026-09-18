/**
 * Database connection layer built on Node's built-in `node:sqlite` (SQLite 3, synchronous API).
 *
 * Synchronous access is a deliberate choice: it keeps multi-statement transactions trivially
 * atomic for currency/inventory operations where async interleaving is a correctness hazard.
 * All statements are parameterised — user input is never concatenated into SQL.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { paths, ensureDirs, createLogger } from '@kinetiq/shared';

const log = createLogger('db');

/** @type {DatabaseSync | null} */
let instance = null;
let statementCache = new Map();

export function openDatabase(file = paths.database) {
  if (instance) return instance;
  ensureDirs();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  instance = new DatabaseSync(file);
  instance.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA temp_store = MEMORY;
  `);
  statementCache = new Map();
  log.debug('database opened', { file });
  return instance;
}

export function getDatabase() {
  return instance ?? openDatabase();
}

export function closeDatabase() {
  if (!instance) return;
  statementCache.clear();
  instance.close();
  instance = null;
}

function prepare(sql) {
  const db = getDatabase();
  let stmt = statementCache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    statementCache.set(sql, stmt);
  }
  return stmt;
}

/** All rows matching the query. */
export function all(sql, params = []) {
  return prepare(sql).all(...normaliseParams(params));
}

/** First matching row, or undefined. */
export function get(sql, params = []) {
  return prepare(sql).get(...normaliseParams(params));
}

/** Execute a statement; returns { changes, lastInsertRowid }. */
export function run(sql, params = []) {
  return prepare(sql).run(...normaliseParams(params));
}

export function exec(sql) {
  return getDatabase().exec(sql);
}

export function queryOne(sql, params = []) {
  return get(sql, params);
}

export function count(sql, params = []) {
  const row = get(sql, params);
  if (!row) return 0;
  return Number(Object.values(row)[0] ?? 0);
}

/**
 * node:sqlite accepts only null/number/bigint/string/Uint8Array. Coerce the common JS types so
 * callers can pass booleans, Dates and undefined without thinking about it.
 */
function normaliseParams(params) {
  const list = Array.isArray(params) ? params : [params];
  return list.map((value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'object') return JSON.stringify(value);
    return value;
  });
}

let txDepth = 0;

/**
 * Run `fn` inside a transaction. Nested calls use savepoints, so helpers can be composed safely.
 */
export function transaction(fn) {
  const db = getDatabase();
  const depth = txDepth;
  const savepoint = `sp_${depth}`;
  txDepth += 1;
  if (depth === 0) db.exec('BEGIN IMMEDIATE');
  else db.exec(`SAVEPOINT ${savepoint}`);
  try {
    const result = fn();
    if (depth === 0) db.exec('COMMIT');
    else db.exec(`RELEASE ${savepoint}`);
    return result;
  } catch (error) {
    try {
      if (depth === 0) db.exec('ROLLBACK');
      else db.exec(`ROLLBACK TO ${savepoint}`);
    } catch {
      /* transaction already unwound */
    }
    throw error;
  } finally {
    txDepth = depth;
  }
}

/** async transaction helper — awaits fn inside a synchronous transaction. */
export async function transactionAsync(fn) {
  const db = getDatabase();
  const depth = txDepth;
  const savepoint = `sp_${depth}`;
  txDepth += 1;
  if (depth === 0) db.exec('BEGIN IMMEDIATE');
  else db.exec(`SAVEPOINT ${savepoint}`);
  try {
    const result = await fn();
    if (depth === 0) db.exec('COMMIT');
    else db.exec(`RELEASE ${savepoint}`);
    return result;
  } catch (error) {
    try {
      if (depth === 0) db.exec('ROLLBACK');
      else db.exec(`ROLLBACK TO ${savepoint}`);
    } catch {
      /* already unwound */
    }
    throw error;
  } finally {
    txDepth = depth;
  }
}

/** Convenience wrapper for test databases. */
export function withDatabase(file, fn) {
  closeDatabase();
  const db = openDatabase(file);
  try {
    return fn(db);
  } finally {
    closeDatabase();
  }
}

export default {
  openDatabase,
  getDatabase,
  closeDatabase,
  all,
  get,
  run,
  exec,
  count,
  transaction,
  transactionAsync,
};
