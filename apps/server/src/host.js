#!/usr/bin/env node
/**
 * Standalone realm host.
 *
 * Runs game servers in their own OS process and exposes a small control API the platform uses to
 * launch realms when it wants them isolated (CPU-heavy games, horizontal scaling, or a separate
 * machine). The realm logic is identical to the in-process mode used by `npm run dev`.
 *
 *   node apps/server/src/host.js --port 4200 --secret <shared-secret>
 *
 * Control API (all calls require the shared secret header):
 *   POST /internal/realms          { gameId, gameName, versionId, versionNumber, bundle, maxPlayers }
 *   GET  /internal/realms          list running realms
 *   GET  /internal/realms/:id      one realm snapshot
 *   POST /internal/realms/:id/stop { reason }
 *   GET  /internal/health
 *
 * Player traffic still arrives over WebSocket at /realm/:id?token=... so the host is a drop-in
 * replacement for in-process realms.
 */
import http from 'node:http';
import { RealmServer } from './realm.js';
import * as db from '@kinetiq/db';
import {
  createLogger,
  config,
  platformConfig,
  timingSafeEqualString,
  ids,
  verifyJoinToken as verifyJoinTokenSignature,
} from '@kinetiq/shared';
import { PROTOCOL_LIMITS, validateFrame } from '@kinetiq/networking';
import { WebSocketServer } from 'ws';

const log = createLogger('realm-host');

export class RealmHost {
  constructor({ secret = process.env.REALM_HOST_SECRET || '', port = 0 } = {}) {
    this.secret = secret;
    this.port = port;
    /** @type {Map<string, RealmServer>} */
    this.realms = new Map();
    this.server = null;
    this.wss = null;
  }

  async start() {
    this.server = http.createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: { threshold: 1024 } });
    this.server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
      const match = /^\/realm\/([a-z0-9_]+)/.exec(url.pathname);
      const realm = match ? this.realms.get(match[1]) : null;
      if (!realm) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }
      const tokenValue = url.searchParams.get('token') ?? '';
      const payload = this.verifyJoinToken(tokenValue, realm.id);
      if (!payload) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.attachPlayer(ws, realm, payload).catch((error) => {
          log.error('attach failed', { error: error.message });
          ws.close(1011, 'server error');
        });
      });
    });

    await new Promise((resolve) => this.server.listen(this.port, config.host, resolve));
    this.port = this.server.address().port;
    log.info(`realm host listening on ${config.host}:${this.port}`);
    return this;
  }

  /**
   * Join tokens are signed by the platform (same secret on both sides) and are verified here
   * before any player state exists — clients cannot invent a realm membership.
   */
  verifyJoinToken(tokenValue, realmId) {
    const payload = verifyJoinTokenSignature(tokenValue);
    if (!payload || payload.realmId !== realmId) return null;
    return payload;
  }

  async attachPlayer(ws, realm, payload) {
    const user = db.users.findById(payload.userId);
    if (!user) {
      ws.close(4001, 'unknown user');
      return;
    }
    const result = await realm.addPlayer({
      userId: user.id,
      username: user.username,
      displayName: user.display_name,
      avatar: user.avatar_item_ids ? JSON.parse(user.avatar_item_ids) : {},
      socket: ws,
    });
    if (!result.ok) {
      ws.close(4004, result.reason);
      return;
    }
    realm.send(ws, {
      t: 'welcome',
      protocol: 1,
      realm: realm.snapshot,
      game: { id: realm.gameId, name: realm.gameName, version: realm.versionNumber },
      player: { id: user.id, username: user.username, displayName: user.display_name },
      spawn: { position: result.character.position, rotation: { x: 0, y: 0, z: 0 } },
      config: realm.bundle.config,
      chunks: Object.keys(realm.bundle.world?.chunks ?? {}),
      clientScripts: realm.clientScripts ?? [],
      serverTime: Math.floor(Date.now() / 1000),
      host: 'standalone',
    });
    ws.on('message', (data) => {
      if (data.length > PROTOCOL_LIMITS.maxFrameBytes) {
        ws.close(4009, 'frame too large');
        return;
      }
      const text = data.toString('utf8');
      const validation = validateFrame(text);
      if (!validation.ok) return;
      realm.handleMessage(result.player, text).catch(() => {});
    });
    ws.on('close', () => {
      realm.removePlayer(user.id, { reason: 'disconnected' }).catch(() => {});
    });
  }

  async handleHttp(req, res) {
    const send = (status, payload) => {
      const body = JSON.stringify(payload);
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    };
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname === '/internal/health') {
      send(200, { ok: true, realms: this.realms.size, platform: platformConfig.platformName });
      return;
    }
    if (this.secret && !timingSafeEqualString(req.headers['x-realm-secret'] ?? '', this.secret)) {
      send(401, { error: { code: 'unauthorized', message: 'Bad realm host secret' } });
      return;
    }
    const body = await readJsonBody(req);
    if (url.pathname === '/internal/realms' && req.method === 'POST') {
      try {
        const realm = await this.createRealm(body);
        send(201, realm.snapshot);
      } catch (error) {
        send(400, { error: { code: 'realm_failed', message: error.message } });
      }
      return;
    }
    if (url.pathname === '/internal/realms' && req.method === 'GET') {
      send(200, { realms: [...this.realms.values()].map((realm) => realm.snapshot) });
      return;
    }
    const stopMatch = /^\/internal\/realms\/([a-z0-9_]+)\/stop$/.exec(url.pathname);
    if (stopMatch && req.method === 'POST') {
      const realm = this.realms.get(stopMatch[1]);
      if (!realm) {
        send(404, { error: { code: 'not_found', message: 'Unknown realm' } });
        return;
      }
      const snapshot = await realm.shutdown({ reason: body?.reason ?? 'control_api' });
      send(200, snapshot);
      return;
    }
    send(404, { error: { code: 'not_found', message: 'Unknown endpoint' } });
  }

  async createRealm({ gameId, gameName, versionId, versionNumber, bundle, maxPlayers, region = 'local', id = null }) {
    const realm = new RealmServer({
      id: id ?? ids.realm(),
      gameId,
      gameName: gameName ?? 'Game',
      versionId,
      versionNumber: versionNumber ?? 1,
      bundle,
      maxPlayers: maxPlayers ?? platformConfig.games.defaultMaxPlayers,
      region,
      services: {
        playerData: {
          load: async ({ gameId: gid, userId }) => db.data.readStore(gid, userId, 'default'),
          save: async ({ gameId: gid, userId, values }) => db.data.writeStore(gid, userId, 'default', values ?? {}),
        },
        onHeartbeat: (snapshot) => {
          try {
            if (db.servers.getServer(snapshot.id)) {
              db.servers.heartbeat(snapshot.id, { currentPlayers: snapshot.playerCount, status: 'running' });
            }
          } catch {
            /* heartbeat is best-effort */
          }
        },
        onRealmEvent: (event) => {
          if (event.type === 'stopped') this.realms.delete(event.realmId);
        },
      },
      logger: log.child(realmShort(id)),
    });
    this.realms.set(realm.id, realm);
    await realm.start();
    return realm;
  }

  async stop() {
    for (const realm of this.realms.values()) await realm.shutdown({ reason: 'host_stop' }).catch(() => {});
    await new Promise((resolve) => this.server?.close(resolve));
  }
}

function realmShort(id) {
  return id ? String(id).slice(-6) : 'new';
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const portArg = args.indexOf('--port');
  const secretArg = args.indexOf('--secret');
  const host = new RealmHost({
    port: portArg >= 0 ? Number(args[portArg + 1]) : Number(process.env.REALM_HOST_PORT ?? config.realmHostStartPort),
    secret: secretArg >= 0 ? args[secretArg + 1] : process.env.REALM_HOST_SECRET ?? '',
  });
  host
    .start()
    .then(() => log.info(`${platformConfig.platformName} realm host ready`))
    .catch((error) => {
      log.error('realm host failed to start', { error: error.message });
      process.exit(1);
    });
  const shutdown = async () => {
    log.info('realm host shutting down');
    await host.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
