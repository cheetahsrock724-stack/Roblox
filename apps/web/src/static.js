/**
 * Static file serving with path-traversal protection, immutable caching for hashed assets, and
 * gzip for text payloads. Vendor code (three.js, wasmoon) is served from node_modules so the
 * browser client and editor can use the exact same modules as the server.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import url from 'node:url';
import { platformConfig, repoRoot } from '@kinetiq/shared';

const here = path.dirname(url.fileURLToPath(import.meta.url));
export const publicDir = path.resolve(here, '..', 'public');
const packagesDir = path.join(repoRoot, 'packages');
const nodeModulesDir = path.join(repoRoot, 'node_modules');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

export function mimeFor(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Resolves a URL path to a file inside an allow-listed root. Rejects anything that escapes the
 * root once resolved (symlink-free, normalised, and prefix-checked).
 */
export function resolveStaticPath(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const roots = [
    { prefix: '/pkg/', root: packagesDir, rewrite: (rest) => resolvePackagePath(rest) },
    { prefix: '/vendor/three/', root: path.join(nodeModulesDir, 'three'), rewrite: (rest) => rest.replace(/^build\//, 'build/') },
    { prefix: '/vendor/wasmoon/', root: path.join(nodeModulesDir, 'wasmoon', 'dist'), rewrite: (rest) => rest },
    { prefix: '/vendor/', root: nodeModulesDir, rewrite: (rest) => rest },
    { prefix: '/', root: publicDir, rewrite: (rest) => rest },
  ];
  for (const entry of roots) {
    if (clean.startsWith(entry.prefix)) {
      const rest = entry.rewrite(clean.slice(entry.prefix.length));
      const candidate = path.resolve(entry.root, rest);
      if (!isInside(entry.root, candidate)) return null;
      return candidate;
    }
  }
  return null;
}

/** Maps `/pkg/engine/index.js` to `packages/engine/src/index.js` (and similar shortcuts). */
function resolvePackagePath(rest) {
  const [packageName, ...tailParts] = rest.split('/');
  if (!packageName) return rest;
  const tail = tailParts.join('/');
  const packageRoot = path.join(packagesDir, packageName);
  if (!tail || tail === 'index.js') return path.join(packageRoot, 'src', 'index.js');
  if (tail === 'browser.js') {
    // Packages may ship a dedicated browser entry at the package root; otherwise fall back to src.
    const browserEntry = path.join(packageRoot, 'browser.js');
    return fs.existsSync(browserEntry) ? browserEntry : path.join(packageRoot, 'src', 'index.js');
  }
  if (tail.startsWith('src/')) return path.join(packageRoot, tail);
  return path.join(packageRoot, 'src', tail);
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function serveStatic(req, res, { headers = {}, immutable = false } = {}) {
  const urlPath = req.url.split('?')[0];
  if (urlPath.includes('\0')) {
    res.writeHead(400).end('Bad request');
    return true;
  }
  let filePath = resolveStaticPath(urlPath);
  if (!filePath) return false;

  // Directory requests fall back to index.html (SPA behaviour).
  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
  } catch {
    return false;
  }

  let data;
  try {
    data = fs.readFileSync(filePath);
  } catch {
    return false;
  }

  const mime = mimeFor(filePath);
  const isText = /text|json|javascript|svg|xml/.test(mime);
  const etag = `W/"${data.length.toString(16)}-${fs.statSync(filePath).mtimeMs.toString(36)}"`;

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, ...headers });
    res.end();
    return true;
  }

  let body = data;
  const acceptEncoding = String(req.headers['accept-encoding'] ?? '');
  const canGzip = isText && data.length > 1024 && acceptEncoding.includes('gzip');
  if (canGzip) body = zlib.gzipSync(data);

  res.writeHead(200, {
    'content-type': mime,
    'content-length': body.length,
    etag,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate',
    ...(canGzip ? { 'content-encoding': 'gzip' } : {}),
    ...headers,
  });
  if (req.method === 'HEAD') res.end();
  else res.end(body);
  return true;
}

/** Injects platform branding into HTML so the name lives in exactly one config value. */
export function renderHtmlTemplate(filePath) {
  const html = fs.readFileSync(filePath, 'utf8');
  return html
    .replaceAll('<!--include:importmap-->', importMapSnippet())
    .replaceAll('{{platformName}}', platformConfig.platformName)
    .replaceAll('{{platformTagline}}', platformConfig.platformTagline)
    .replaceAll('{{currencyName}}', platformConfig.currencyName)
    .replaceAll('{{currencySymbol}}', platformConfig.currencySymbol)
    .replaceAll('{{editorName}}', platformConfig.editorName)
    .replaceAll('{{primary}}', platformConfig.brandColors.primary)
    .replaceAll('{{accent}}', platformConfig.brandColors.accent)
    .replaceAll('{{surface}}', platformConfig.brandColors.surface);
}

/** Shared browser import map (engine/networking/scripting/three/wasmoon) used by every page. */
function importMapSnippet() {
  const snippet = path.join(publicDir, 'shared', 'importmap.html');
  try {
    return fs.readFileSync(snippet, 'utf8').replace(/<!--[\s\S]*?-->\s*/, '');
  } catch {
    return '';
  }
}

/** Page files that need the Lua VM (the editor play-test and the client both do). */
export function needsLuaRuntime(filePath) {
  const name = path.basename(filePath);
  return name === 'client.html' || name === 'editor.html';
}

export { MIME };
export default serveStatic;
