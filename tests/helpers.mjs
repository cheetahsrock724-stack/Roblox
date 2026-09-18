/**
 * Shared test harness: boots a real platform instance on an ephemeral port against a throwaway
 * data directory, plus a cookie-aware HTTP client and a websocket game client helper.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';

process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
// Every test run gets a throwaway data directory. This must happen before any module reads the
// configuration, so it lives at module scope rather than inside startPlatform().
if (!process.env.KINETIQ_DATA_DIR || process.env.KINETIQ_DATA_DIR === path.join(process.cwd(), 'var')) {
  process.env.KINETIQ_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinetiq-test-'));
}

export async function startPlatform(options = {}) {
  const dataDir = process.env.KINETIQ_DATA_DIR;
  const { createPlatform } = await import('../apps/web/src/index.js');
  const platform = await createPlatform({ port: 0, host: '127.0.0.1', logLevel: 'error', ...options });
  return {
    platform,
    dataDir,
    base: `http://127.0.0.1:${platform.port}`,
    async stop() {
      await platform.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Cookie-aware JSON client. Mirrors what the browser does, including CSRF double-submit. */
export function createClient(base) {
  const cookies = new Map();
  let csrfToken = null;

  async function request(method, endpoint, body, { headers = {}, raw = false, form = null } = {}) {
    const finalHeaders = { ...headers };
    if (cookies.size) {
      finalHeaders.cookie = [...cookies].map(([key, value]) => `${key}=${value}`).join('; ');
    }
    if (csrfToken && method !== 'GET') finalHeaders['x-csrf-token'] = csrfToken;
    let payload;
    if (form) payload = form;
    else if (body !== undefined) {
      finalHeaders['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const response = await fetch(`${base}${endpoint}`, { method, headers: finalHeaders, body: payload, redirect: 'manual' });
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const [pair] = cookie.split(';');
      const index = pair.indexOf('=');
      cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
    const text = await response.text();
    if (raw) return { status: response.status, text, headers: response.headers };
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    if (json?.csrfToken) csrfToken = json.csrfToken;
    return { status: response.status, json, headers: response.headers };
  }

  return {
    base,
    get: (endpoint, options) => request('GET', endpoint, undefined, options),
    post: (endpoint, body, options) => request('POST', endpoint, body === undefined ? {} : body, options),
    put: (endpoint, body, options) => request('PUT', endpoint, body, options),
    patch: (endpoint, body, options) => request('PATCH', endpoint, body, options),
    del: (endpoint, options) => request('DELETE', endpoint, undefined, options),
    upload: (form, options) => request('POST', '/api/assets', undefined, { ...options, form }),
    get csrfToken() {
      return csrfToken;
    },
    set csrfToken(value) {
      csrfToken = value;
    },
    cookies,
    async register(username, password = 'Correct-Horse-9!battery') {
      const result = await request('POST', '/api/auth/register', {
        username,
        password,
        displayName: username,
        email: `${username.toLowerCase()}@example.test`,
      });
      return result;
    },
    async login(username, password = 'Correct-Horse-9!battery') {
      return request('POST', '/api/auth/login', { username, password });
    },
    async play(gameId, options = {}) {
      return request('POST', `/api/games/${gameId}/join`, options);
    },
  };
}

/** Two-player websocket helper for gameplay tests. */
export function connectGame(base, connectUrl) {
  const wsUrl = `${base.replace('http://', 'ws://')}${connectUrl}`;
  const socket = new WebSocket(wsUrl);
  const state = {
    frames: [],
    byType: new Map(),
    welcome: null,
    snapshots: [],
    spawns: [],
    despawns: [],
    chat: [],
    logs: [],
    errors: [],
    remotes: [],
    closed: null,
  };

  socket.on('message', (data) => {
    let frame;
    try {
      frame = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    state.frames.push(frame);
    const list = state.byType.get(frame.t) ?? [];
    list.push(frame);
    state.byType.set(frame.t, list);
    switch (frame.t) {
      case 'welcome':
        state.welcome = frame;
        break;
      case 'snap':
        state.snapshots.push(frame);
        break;
      case 'spawn':
        state.spawns.push(frame);
        break;
      case 'despawn':
        state.despawns.push(frame);
        break;
      case 'chat':
        state.chat.push(frame);
        break;
      case 'log':
        state.logs.push(frame);
        if (frame.level === 'error') state.errors.push(frame);
        break;
      case 'remote':
        state.remotes.push(frame);
        break;
      case 'error':
        state.errors.push(frame);
        break;
      default:
        break;
    }
  });

  const connection = {
    socket,
    state,
    send(frame) {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
    },
    async ready() {
      if (socket.readyState === WebSocket.OPEN) return;
      await new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      // Wait for the welcome frame.
      const deadline = Date.now() + 5000;
      while (!state.welcome && Date.now() < deadline) await sleep(10);
    },
    async close() {
      await new Promise((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) return resolve();
        socket.once('close', (code, reason) => {
          state.closed = { code, reason: reason?.toString?.() ?? '' };
          resolve();
        });
        socket.close();
      });
    },
    input({ moveX = 0, moveZ = 0, run = false, jump = false, yaw = 0, sequence = 1 } = {}) {
      connection.send({ t: 'in', i: [moveX, moveZ, run, jump, yaw, sequence] });
    },
    chat(text) {
      connection.send({ t: 'chat', m: text });
    },
    snapshotFor(playerId) {
      for (let index = state.snapshots.length - 1; index >= 0; index -= 1) {
        const entry = (state.snapshots[index].p ?? []).find((row) => row[0] === playerId);
        if (entry) return entry;
      }
      return null;
    },
    /** Log lines seen live plus the ones replayed in the welcome frame. */
    allLogs() {
      return [...(state.welcome?.logs ?? []), ...state.logs];
    },
    async waitFor(predicate, { timeout = 4000, label = 'condition' } = {}) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (predicate(state)) return true;
        await sleep(15);
      }
      throw new Error(`Timed out waiting for ${label}`);
    },
  };
  return connection;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomName(prefix = 'Tester') {
  return `${prefix}${randomBytes(3).toString('hex')}`;
}

export function makePng(width = 8, height = 8) {
  // Minimal valid PNG (greyscale) built by hand so tests do not need image libraries.
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBuffer = Buffer.from(type, 'ascii');
    const crcInput = Buffer.concat([typeBuffer, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(crcInput) >>> 0, 0);
    return Buffer.concat([length, typeBuffer, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width + 1)] = 0;
    for (let x = 0; x < width; x += 1) raw[y * (width + 1) + 1 + x] = (x * 16 + y * 8) % 256;
  }
  const zlib = require('node:zlib');
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let crcTable = null;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return crc ^ -1;
}
