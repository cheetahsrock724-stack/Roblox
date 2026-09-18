#!/usr/bin/env node
/**
 * Kinetiq platform server: website + JSON API + asset delivery + gameplay websockets.
 *
 * One process serves everything by default (website, API, realms, assets, the client and the
 * editor). Realms can be moved to dedicated processes with the standalone realm host without any
 * client-visible change.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from './router.js';
import { createContext, limiters } from './context.js';
import { serveStatic, publicDir, renderHtmlTemplate, mimeFor } from './static.js';
import { AuthService, SESSION_COOKIE } from './services/auth.js';
import { RealmManager } from './services/realm-manager.js';
import { registerRoutes as registerAuth } from './api/auth.js';
import { registerRoutes as registerUsers } from './api/users.js';
import { registerRoutes as registerGames } from './api/games.js';
import { registerRoutes as registerServers } from './api/servers.js';
import { registerRoutes as registerSocial } from './api/social.js';
import { registerRoutes as registerAssets } from './api/assets.js';
import { registerRoutes as registerEconomy } from './api/economy.js';
import { registerRoutes as registerModeration } from './api/moderation.js';
import { registerRoutes as registerAdmin } from './api/admin.js';
import { seedIfEmpty } from './services/seed.js';
import * as db from '@kinetiq/db';
import {
  config,
  ensureDirs,
  createLogger,
  platformConfig,
  sendJson,
  sendError,
  isPlatformError,
  NotFoundError,
  paths,
} from '@kinetiq/shared';
import { classCatalog, propertyCatalog, CLASS_DEFS } from '@kinetiq/engine';
import { pageRoutes } from './pages.js';

const log = createLogger('platform');

export async function createPlatform({ port = config.port, host = config.host } = {}) {
  ensureDirs();
  const migrations = db.runMigrations({ verbose: false });
  if (migrations.length) log.info(`applied ${migrations.length} migration(s)`);
  seedIfEmpty({ log });

  const notify = (payload) => {
    try {
      db.notifications.notify(payload.userId, payload);
    } catch (error) {
      log.warn('notification failed', { error: error.message });
    }
  };

  const auth = new AuthService({ notify });
  const realms = new RealmManager({ notify });

  const router = new Router();
  registerAuth(router, { auth, notify });
  registerUsers(router);
  registerGames(router, { realms, notify });
  registerServers(router, { realms, notify });
  registerSocial(router, { notify });
  registerAssets(router, { notify });
  registerEconomy(router, { notify });
  registerModeration(router, { realms, notify });
  registerAdmin(router, { realms, notify });

  // Engine metadata for the editor (class catalogue, property specs, limits).
  router.get('/api/engine/classes', async (ctx) => {
    sendJson(ctx.res, 200, {
      classes: classCatalog(),
      limits: { maxPlayers: platformConfig.games.maxMaxPlayers },
      platform: {
        name: platformConfig.platformName,
        currency: platformConfig.currencyName,
        editor: platformConfig.editorName,
      },
    });
  });

  router.get('/api/engine/properties/:className', async (ctx) => {
    if (!CLASS_DEFS[ctx.params.className]) throw new NotFoundError('Unknown class.');
    sendJson(ctx.res, 200, { properties: propertyCatalog(ctx.params.className) });
  });

  router.get('/api/health', async (ctx) => {
    sendJson(ctx.res, 200, {
      ok: true,
      platform: platformConfig.platformName,
      uptimeSeconds: Math.round(process.uptime()),
      realms: realms.realms.size,
      players: realms.stats.players,
    });
  });

  router.get('/api/meta', async (ctx) => {
    sendJson(ctx.res, 200, {
      platform: {
        name: platformConfig.platformName,
        tagline: platformConfig.platformTagline,
        currencyName: platformConfig.currencyName,
        currencySymbol: platformConfig.currencySymbol,
        editorName: platformConfig.editorName,
        clientName: platformConfig.clientName,
        serverName: platformConfig.serverName,
        supportEmail: platformConfig.supportEmail,
        colors: platformConfig.brandColors,
      },
      features: platformConfig.features,
      economy: platformConfig.economy,
      games: platformConfig.games,
      safety: {
        maxMessageLength: platformConfig.safety.maxMessageLength,
        chatFilterEnabled: platformConfig.safety.chatFilterEnabled,
      },
    });
  });

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

      // Security headers for every response.
      res.setHeader('x-frame-options', 'SAMEORIGIN');
      res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader(
        'permissions-policy',
        'geolocation=(), microphone=(), camera=(), payment=()',
      );

      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
          'access-control-allow-headers': 'content-type,x-csrf-token,authorization,idempotency-key',
          'access-control-max-age': '600',
        });
        res.end();
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        const match = router.match(req.method, url.pathname);
        if (!match) {
          sendJson(res, 404, { error: { code: 'not_found', message: 'Unknown API endpoint' } });
          return;
        }
        let ctx;
        try {
          ctx = await createContext(req, res, { auth });
        } catch (error) {
          // Context creation enforces CSRF and rate limits: those failures are normal API errors.
          if (isPlatformError(error)) {
            sendError(res, error);
            return;
          }
          throw error;
        }
        ctx.params = match.params;
        try {
          await match.route.handler(ctx);
        } catch (error) {
          if (isPlatformError(error)) {
            sendError(res, error);
          } else {
            log.error('api error', {
              path: url.pathname,
              error: error.message,
              stack: (error.stack ?? '').split('\n').slice(1, 4).map((line) => line.trim()).join(' <- '),
            });
            sendJson(res, 500, { error: { code: 'internal_error', message: 'Something went wrong.' } });
          }
        }
        return;
      }

      // HTML pages (with branding injected from configuration).
      const page = pageRoutes[url.pathname];
      if (page) {
        const file = path.join(publicDir, page);
        if (fs.existsSync(file)) {
          const html = renderHtmlTemplate(file);
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
          res.end(html);
          return;
        }
      }

      // Deep links for the SPA shell.
      if (!path.extname(url.pathname) && !url.pathname.startsWith('/api/')) {
        const shell = path.join(publicDir, 'app.html');
        if (fs.existsSync(shell)) {
          const html = renderHtmlTemplate(shell);
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
          res.end(html);
          return;
        }
      }

      if (serveStatic(req, res, { immutable: url.pathname.startsWith('/vendor/') })) return;
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    } catch (error) {
      log.error('request failed', { error: error.message, path: req.url });
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'internal_error', message: 'Something went wrong.' } }));
      } else {
        res.end();
      }
    } finally {
      const duration = Date.now() - started;
      if (duration > 1500) log.warn('slow request', { path: req.url, ms: duration });
    }
  });

  realms.attachWebSocketServer(server);

  const timers = [];
  // Presence + session hygiene.
  timers.push(
    setInterval(() => {
      try {
        db.users.sweepStalePresence(120);
        db.sessions.purgeExpiredSessions();
        realms.reconcile();
      } catch (error) {
        log.warn('maintenance task failed', { error: error.message });
      }
    }, 30_000).unref?.(),
  );
  // Flush realm player data periodically (crash safety).
  timers.push(
    setInterval(() => {
      for (const realm of realms.realms.values()) realm.flushPlayerData().catch(() => {});
    }, 60_000).unref?.(),
  );

  await new Promise((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  log.banner(`${platformConfig.platformName} is running — website, API and realms on port ${address.port}`);
  log.info(`website     http://localhost:${address.port}/`);
  log.info(`creator     http://localhost:${address.port}/editor`);
  log.info(`admin       http://localhost:${address.port}/admin`);
  log.info(`client      http://localhost:${address.port}/client`);
  log.info(`api         http://localhost:${address.port}/api/health`);
  log.info(`data dir    ${paths.data}`);

  return {
    server,
    auth,
    realms,
    router,
    port: address.port,
    async close() {
      for (const timer of timers) clearInterval(timer);
      await realms.shutdownAll();
      await new Promise((resolve) => server.close(resolve));
      db.closeDatabase();
    },
  };
}

export { mimeFor, limiters, SESSION_COOKIE };

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  createPlatform()
    .then((platform) => {
      const shutdown = async (signal) => {
        log.info(`received ${signal}, shutting down`);
        await platform.close();
        process.exit(0);
      };
      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));
    })
    .catch((error) => {
      log.error('platform failed to start', { error: error.message, stack: error.stack?.split('\n')[1] });
      process.exit(1);
    });
}

export default createPlatform;
