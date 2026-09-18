/**
 * Test helpers: boot the real platform on an ephemeral port with an isolated data directory and
 * give the tests an HTTP client with cookie/CSRF handling plus a websocket game client.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { encodeInput, ClientMessage, ServerMessage } from '@kinetiq/networking';

let counter = 0;
const nextPort = () => 21000 + (counter += 1) + Math.floor(Math.random() * 400);

export async function startPlatform() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinetiq-test-'));
  process.env.KINETIQ_DATA_DIR = dataDir;
  process.env.SESSION_SECRET = 'test-session-secret-test-session-secret';
  process.env.JOIN_TOKEN_SECRET = 'test-join-secret';
  process.env.NODE_ENV = 'test';
  process.env.PORT = String(nextPort());
  const { createPlatform } = await import('../apps/web/src/index.js');
  const platform = await createPlatform({ port: Number(process.env.PORT), host: '127.0.0.1' });
  const port = platform.server.address().port;
  return {
    ...platform,
    port,
    base: `http://127.0.0.1:${port}`,
    dataDir,
    async stop() {
      await platform.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Minimal cookie-aware HTTP client. */
export function createClient(base) {
  const cookies = new Map();
  let csrf = null;

  function cookieHeader() {
    return [...cookies.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
  }

  function absorb(response) {
    const raw = response.headers.getSetCookie?.() ?? [];
    for (const entry of raw) {
      const [pair] = entry.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (value === '') cookies.delete(name);
      else cookies.set(name, value);
    }
    const token = cookies.get('kq_csrf');
    if (token) csrf = decodeURIComponent(token);
  }

  async function request(method, route, body, { headers = {}, form = null } = {}) {
    const init = { method, headers: { cookie: cookieHeader(), ...headers } };
    if (csrf && method !== 'GET') init.headers['x-csrf-token'] = csrf;
    if (form) {
      init.body = form;
    } else if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetch(`${base}${route}`, init);
    absorb(response);
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    return { status: response.status, headers: response.headers, json, text };
  }

  return {
    cookies,
    get: (route, options) => request('GET', route, undefined, options),
    post: (route, body, options) => request('POST', route, body, options),
    put: (route, body, options) => request('PUT', route, body, options),
    patch: (route, body, options) => request('PATCH', route, body, options),
    del: (route, body, options) => request('DELETE', route, body, options),
    /** Registers and returns the created session user. */
    async register(username, password = 'Kx7-Test-Passw0rd!9') {
      const response = await request('POST', '/api/auth/register', { username, password });
      if (response.status !== 201 && response.status !== 200) {
        throw new Error(`register failed: ${response.status} ${response.text.slice(0, 300)}`);
      }
      return response.json.user;
    },
    async login(username, password) {
      const response = await request('POST', '/api/auth/login', { username, password });
      if (response.status !== 200) throw new Error(`login failed: ${response.status} ${response.text.slice(0, 200)}`);
      return response.json.user;
    },
    async raw(method, route, body, headers = {}) {
      const response = await fetch(`${base}${route}`, {
        method,
        headers: { cookie: cookieHeader(), ...headers },
        body,
      });
      absorb(response);
      return response;
    },
  };
}

/** A headless game client speaking the realm protocol. */
export function createGameClient(base) {
  const state = {
    welcome: null,
    snapshots: [],
    logs: [],
    notifications: [],
    chat: [],
    closed: null,
    errors: [],
    stop: null,
    spawns: [],
    despawns: [],
    other: [],
    seq: 0,
  };
  let socket = null;
  const waiters = new Set();

  function notify() {
    for (const waiter of [...waiters]) {
      if (waiter.predicate(state)) {
        waiters.delete(waiter);
        waiter.resolve(state);
      }
    }
  }

  return {
    state,
    get socket() {
      return socket;
    },
    async connect(connectUrl) {
      const url = connectUrl.startsWith('ws') ? connectUrl : `${base.replace('http', 'ws')}${connectUrl}`;
      socket = new WebSocket(url, { headers: { origin: base } });
      socket.on('message', (buffer) => {
        let frame = null;
        try {
          frame = JSON.parse(buffer.toString());
        } catch {
          return;
        }
        switch (frame.t) {
          case ServerMessage.WELCOME:
            state.welcome = frame;
            break;
          case ServerMessage.SNAPSHOT:
            state.snapshots.push(frame);
            break;
          case ServerMessage.LOG:
            state.logs.push(frame);
            break;
          case ServerMessage.NOTIFY:
            state.notifications.push(frame);
            break;
          case ServerMessage.CHAT:
            state.chat.push(frame);
            break;
          case ServerMessage.ERROR:
            state.errors.push(frame);
            break;
          case ServerMessage.STOP:
            state.stop = frame;
            break;
          case ServerMessage.SPAWN:
            state.spawns.push(frame);
            break;
          case ServerMessage.DESPAWN:
            state.despawns.push(frame);
            break;
          default:
            state.other.push(frame);
            break;
        }
        notify();
      });
      socket.on('close', (code, reason) => {
        state.closed = { code, reason: reason?.toString?.() ?? '' };
        notify();
      });
      await once(socket, 'open');
      return state;
    },
    send(frame) {
      socket.send(JSON.stringify(frame));
    },
    input(input) {
      state.seq += 1;
      // Input frames use the compact array payload from the protocol module.
      const frame = encodeInput({ ...input, sequence: state.seq });
      socket.send(JSON.stringify({ t: ClientMessage.INPUT, i: frame }));
    },
    chat(message) {
      socket.send(JSON.stringify({ t: ClientMessage.CHAT, m: message }));
    },
    remote(name, payload) {
      socket.send(JSON.stringify({ t: ClientMessage.REMOTE, n: name, a: [payload] }));
    },
    ready() {
      socket.send(JSON.stringify({ t: ClientMessage.READY }));
    },
    waitFor(predicate, { timeout = 6000, label = 'condition' } = {}) {
      if (predicate(state)) return Promise.resolve(state);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve };
        waiters.add(waiter);
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`Timed out waiting for ${label}`));
        }, timeout);
        const wrapped = waiter.resolve;
        waiter.resolve = (value) => {
          clearTimeout(timer);
          wrapped(value);
        };
      });
    },
    latestSnapshot() {
      return state.snapshots[state.snapshots.length - 1] ?? null;
    },
    async close() {
      if (!socket) return;
      if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'test done');
      if (socket.readyState !== WebSocket.CLOSED) await once(socket, 'close').catch(() => {});
    },
  };
}

export async function waitForHttp(url, { timeout = 8000, interval = 60 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return false;
}

export function freePort() {
  return nextPort();
}

export { http, path, fs };
