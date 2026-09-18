/**
 * Game project format.
 *
 * On disk (and in the editor) a project looks like:
 *
 *   project.json          identity + settings
 *   world.scene           the scene graph (chunked for streaming)
 *   scripts/              *.lua files, one per Script instance (server/client/module)
 *   assets/               asset manifest referencing uploaded asset IDs
 *   config/               gameplay configuration (currency products, permissions, data stores)
 *   metadata.json         creator-owned metadata (thumbnail, description, tags)
 *
 * Publishing builds an immutable *version bundle*: a single JSON document containing the whole
 * project plus a content hash. Older versions are never rewritten.
 */
import { World } from './world.js';
import { serializeWorld, deserializeWorld, SCENE_FORMAT, SCENE_VERSION } from './serialization.js';
import { contentHash, stableStringify } from '@kinetiq/shared';

export const PROJECT_FORMAT = 'kinetiq.project';
export const PROJECT_VERSION = 1;

export function createEmptyProject({ name = 'Untitled Game', ownerId = null, ownerName = null } = {}) {
  const project = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    project: {
      id: null,
      name,
      ownerId,
      ownerName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    world: starterWorld(name),
    scripts: [],
    assets: [],
    config: defaultConfig(),
    metadata: {
      description: '',
      genre: 'Sandbox',
      tags: [],
      iconAssetId: null,
      thumbnailAssetId: null,
      screenshots: [],
      maxPlayers: 12,
      isPublic: false,
      allowPrivateServers: true,
      privateServerPrice: 0,
    },
  };
  return project;
}

/**
 * A brand new project opens on a simple, playable baseplate: a floor, a spawn point and neutral
 * lighting. Creators immediately have somewhere to walk, and publishing an untouched project
 * still produces a valid, joinable game.
 */
export function starterWorld(name = 'Untitled Game') {
  const world = new World({ name });
  world.ensureServices();
  world.create('Part', {
    name: 'Baseplate',
    size: { x: 128, y: 4, z: 128 },
    position: { x: 0, y: -2, z: 0 },
    color: '#3c4a63',
    material: 'concrete',
    anchored: true,
  });
  world.create('Part', {
    name: 'SpawnPad',
    size: { x: 12, y: 1, z: 12 },
    position: { x: 0, y: 0.5, z: 0 },
    color: '#3d5afe',
    material: 'neon',
    anchored: true,
  });
  world.create('SpawnPoint', { name: 'Spawn', position: { x: 0, y: 4, z: 0 } });
  return serializeWorld(world, { includeChunks: true, chunkSize: 128 });
}

export function defaultConfig() {
  return {
    gravity: -90,
    spawnFacing: 0,
    enableChat: true,
    allowClientScripts: true,
    serverTickRate: 60,
    maxServerLifetimeMinutes: 180,
    dataStores: [{ name: 'default', quota: 64 * 1024 }],
    products: [],
    permissions: { whoCanJoin: 'everyone', allowCopying: true },
    streaming: { enabled: true, radiusStuds: 512, chunkSize: 128 },
    environment: { graphics: 'auto' },
  };
}

/** Builds a project object from a live World. */
export function projectFromWorld(world, { name = 'Untitled Game', metadata = {}, config = {}, ownerId = null, ownerName = null } = {}) {
  const project = createEmptyProject({ name, ownerId, ownerName });
  project.world = serializeWorld(world, { includeChunks: true, chunkSize: config?.streaming?.chunkSize ?? 128 });
  project.scripts = collectScripts(world);
  project.config = { ...defaultConfig(), ...config };
  project.metadata = { ...project.metadata, ...metadata, name };
  project.project.name = name;
  project.project.updatedAt = new Date().toISOString();
  if (world.root.getProperty('gravity') !== undefined) project.config.gravity = world.root.getProperty('gravity');
  return project;
}

/** Scripts live in Script instances; the project stores them as separate files for tooling. */
export function collectScripts(world) {
  return world
    .findByClass('Script')
    .map((script) => ({
      id: script.id,
      // Scripts are addressed by their instance name; the `.lua` suffix is only added when the
      // creator did not include one (avoids `Thing.lua.lua`).
      name: /\.lua$/i.test(script.getName()) ? script.getName() : `${script.getName()}.lua`,
      kind: script.getProperty('kind'),
      source: script.getProperty('source'),
      runOnLoad: script.getProperty('runOnLoad'),
      disabled: script.getProperty('disabled'),
      path: script.getFullName(),
      folder:
        script.parent?.className === 'ServerScripts' || script.parent?.className === 'ClientScripts'
          ? script.parent.className
          : 'Scripts',
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Removes Script instances (and their source) from a serialized scene.
 *
 * Server script sources must never reach a player's machine: the release a client downloads
 * contains the world without scripts plus only the *client* scripts it is allowed to run. The
 * realm re-inserts script instances from the bundle when it loads the game.
 */
export function stripScriptsFromScene(scene) {
  if (!scene) return scene;
  const strip = (nodes) =>
    (nodes ?? [])
      .filter((node) => node.className !== 'Script')
      .map((node) => (node.children?.length ? { ...node, children: strip(node.children) } : node));
  const stripped = { ...scene };
  if (stripped.chunks && typeof stripped.chunks === 'object') {
    stripped.chunks = Object.fromEntries(
      Object.entries(stripped.chunks).map(([id, chunk]) => [id, { ...chunk, roots: strip(chunk.roots) }]),
    );
  }
  if (Array.isArray(stripped.root)) stripped.root = strip(stripped.root);
  return stripped;
}

/** Re-creates Script instances inside a live world from a version bundle's script list. */
export function insertScriptsIntoWorld(world, scripts = []) {
  const folderFor = (kind) => {
    const name = kind === 'client' ? 'ClientScripts' : kind === 'module' ? 'SharedStorage' : 'ServerScripts';
    let folder = world.root.findFirstChild(name);
    if (!folder) folder = world.create('Folder', { name, parent: world.root });
    return folder;
  };
  const created = [];
  for (const entry of scripts) {
    if (!entry?.source) continue;
    const parent = folderFor(entry.kind ?? 'server');
    const existing = world.findByClass('Script').find((script) => script.id === entry.id || script.getName() === entry.name);
    if (existing) continue;
    created.push(
      world.create('Script', {
        id: entry.id,
        name: entry.name,
        source: entry.source,
        kind: entry.kind ?? 'server',
        runOnLoad: entry.runOnLoad !== false,
        disabled: Boolean(entry.disabled),
        parent,
      }),
    );
  }
  return created;
}

export function applyScriptsToWorld(world, scripts = []) {
  // Scripts already exist as instances inside the scene; this syncs edited sources back in.
  const byId = new Map(world.findByClass('Script').map((script) => [script.id, script]));
  const byName = new Map(world.findByClass('Script').map((script) => [`${script.getName()}.lua`, script]));
  let applied = 0;
  for (const entry of scripts) {
    const target = byId.get(entry.id) ?? byName.get(entry.name);
    if (!target) continue;
    if (entry.source !== undefined) target.setProperty('source', entry.source);
    if (entry.kind !== undefined) target.setProperty('kind', entry.kind);
    if (entry.runOnLoad !== undefined) target.setProperty('runOnLoad', entry.runOnLoad);
    if (entry.disabled !== undefined) target.setProperty('disabled', entry.disabled);
    applied += 1;
  }
  return applied;
}

export function worldFromProject(project, { world = null } = {}) {
  const target = deserializeWorld(project.world, { world });
  if (!project.world?.root && !project.world?.chunks) {
    // Brand new project: still give creators the standard services.
    target.ensureServices();
  }
  return target;
}

/** Deterministic hash of everything that affects gameplay. */
export function projectContentHash(project) {
  const relevant = {
    world: project.world,
    scripts: (project.scripts ?? []).map((script) => ({
      name: script.name,
      kind: script.kind,
      source: script.source,
      runOnLoad: script.runOnLoad,
      disabled: script.disabled,
    })),
    config: project.config,
    metadata: {
      name: project.metadata?.name,
      maxPlayers: project.metadata?.maxPlayers,
      genre: project.metadata?.genre,
    },
  };
  return contentHash(stableStringify(relevant));
}

export function projectStats(project) {
  let parts = 0;
  let ui = 0;
  const walk = (node) => {
    if (!node) return;
    if (['Part', 'Mesh', 'Interactable', 'VehicleSeat', 'Terrain'].includes(node.className)) parts += 1;
    if (node.className === 'Script') ui += 0;
    for (const child of node.children ?? []) walk(child);
  };
  if (project.world?.root) walk(project.world.root);
  for (const chunk of Object.values(project.world?.chunks ?? {})) {
    for (const root of chunk.roots ?? []) walk(root);
  }
  for (const service of project.world?.services ?? []) walk(service);
  return {
    parts,
    scripts: (project.scripts ?? []).length,
    chunks: Object.keys(project.world?.chunks ?? {}).length,
    sizeBytes: Buffer.byteLength(JSON.stringify(project)),
  };
}

/**
 * The publishable bundle: what a game server downloads and what a client streams.
 * Kept JSON-only so clients never execute downloaded code as a program.
 */
export function buildVersionBundle(project, {
  gameId,
  versionNumber,
  changelog = '',
  publishedBy = null,
  label = null,
} = {}) {
  const contentHash = projectContentHash(project);
  return {
    format: PROJECT_FORMAT,
    projectVersion: PROJECT_VERSION,
    sceneFormat: SCENE_FORMAT,
    sceneVersion: SCENE_VERSION,
    gameId,
    versionNumber,
    label,
    changelog,
    publishedBy,
    publishedAt: new Date().toISOString(),
    contentHash,
    metadata: project.metadata,
    config: project.config,
    // The scene inside a release never contains script sources (see stripScriptsFromScene).
    world: stripScriptsFromScene(project.world),
    scripts: project.scripts,
    assets: project.assets ?? [],
    stats: projectStats(project),
  };
}

/** Validates a bundle before it is served or loaded (defence against malformed uploads). */
export function validateBundle(bundle) {
  const errors = [];
  if (!bundle || typeof bundle !== 'object') return { ok: false, errors: ['Bundle is not an object'] };
  if (bundle.format !== PROJECT_FORMAT) errors.push(`Unexpected format: ${bundle.format}`);
  if (!bundle.world || typeof bundle.world !== 'object') errors.push('Missing world scene');
  if (!Array.isArray(bundle.scripts)) errors.push('scripts must be an array');
  for (const script of bundle.scripts ?? []) {
    if (typeof script.source !== 'string') errors.push(`Script ${script.name} has no source`);
    if (script.source && script.source.length > 512 * 1024) errors.push(`Script ${script.name} is too large`);
  }
  const size = Buffer.byteLength(JSON.stringify(bundle));
  if (size > 64 * 1024 * 1024) errors.push('Bundle exceeds the 64MB limit');
  return { ok: errors.length === 0, errors, sizeBytes: size };
}

/** Migration hook so old projects keep loading as the format evolves. */
/**
 * The original project file format. A project on disk is a directory:
 *
 *   project.json    identity, version and settings
 *   world.scene     the serialized scene graph (chunked)
 *   scripts/*.lua   one file per script (server / client / module)
 *   assets/manifest.json
 *   config/game.json
 *   metadata.json
 *
 * The same structure is used for the editor's save format, for `.kqproj` export/import and for
 * building immutable version bundles at publish time.
 */
export function createProject({ name = 'Untitled Game', ownerId = null, ownerName = null, config = {}, metadata = {} } = {}) {
  const project = createEmptyProject({ name, ownerId, ownerName });
  project.project.id = `proj_${contentHash({ name, ownerId, at: Date.now() }).slice(0, 12)}`;
  project.config = { ...project.config, ...config };
  project.metadata = { ...project.metadata, ...metadata, name };
  return project;
}

function scriptFileName(script) {
  const base = slugifyName(script.name ?? 'script');
  const hasLua = /\.lua$/i.test(base);
  const kind = script.kind === 'module' ? 'module' : script.kind === 'client' ? 'client' : 'server';
  return `${kind}/${hasLua ? base : `${base}.lua`}`;
}

function slugifyName(value) {
  return String(value)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || 'script';
}

/** Serialises a project into the on-disk file set: [{ path, content }]. */
export function exportProjectFiles(project) {
  const files = [];
  files.push({
    path: 'project.json',
    content: JSON.stringify(
      {
        format: project.format ?? PROJECT_FORMAT,
        version: project.version ?? PROJECT_VERSION,
        project: project.project ?? {},
      },
      null,
      2,
    ),
  });
  files.push({ path: 'world.scene', content: JSON.stringify(project.world ?? starterWorld(), null, 1) });
  files.push({ path: 'metadata.json', content: JSON.stringify(project.metadata ?? {}, null, 2) });
  files.push({ path: 'config/game.json', content: JSON.stringify(project.config ?? defaultConfig(), null, 2) });
  files.push({
    path: 'assets/manifest.json',
    content: JSON.stringify({ assets: project.assets ?? [] }, null, 2),
  });
  for (const script of project.scripts ?? []) {
    files.push({
      path: `scripts/${scriptFileName(script)}`,
      content: `-- ${script.name ?? 'script'} (${script.kind ?? 'server'})\n${script.source ?? ''}`,
    });
  }
  return files;
}

/** Inverse of exportProjectFiles. */
export function importProjectFiles(files = []) {
  const byPath = new Map(files.map((file) => [String(file.path).replace(/^\/+/, ''), file.content]));
  const projectFile = safeParse(byPath.get('project.json'), {});
  const project = createEmptyProject({
    name: projectFile.project?.name ?? 'Untitled Game',
    ownerId: projectFile.project?.ownerId ?? null,
    ownerName: projectFile.project?.ownerName ?? null,
  });
  project.format = projectFile.format ?? PROJECT_FORMAT;
  project.version = projectFile.version ?? PROJECT_VERSION;
  project.project = { ...project.project, ...(projectFile.project ?? {}) };
  project.world = safeParse(byPath.get('world.scene'), null) ?? starterWorld(project.project.name);
  project.metadata = safeParse(byPath.get('metadata.json'), project.metadata) ?? project.metadata;
  project.config = safeParse(byPath.get('config/game.json'), project.config) ?? project.config;
  project.assets = safeParse(byPath.get('assets/manifest.json'), { assets: [] })?.assets ?? [];
  project.scripts = [];
  for (const [filePath, content] of byPath) {
    const match = /^scripts\/(server|client|module)\/(.+?\.lua)$/i.exec(filePath);
    if (!match) continue;
    const [, kind, fileName] = match;
    project.scripts.push({
      id: `scr_${contentHash({ fileName, source: content }).slice(0, 10)}`,
      name: fileName,
      kind,
      source: String(content).replace(/^--[^\n]*\n/, ''),
      runOnLoad: true,
      disabled: false,
      path: kind === 'module' ? 'SharedStorage' : kind === 'server' ? 'ServerScripts' : 'ClientScripts',
      folder: kind === 'module' ? 'SharedStorage' : kind === 'server' ? 'ServerScripts' : 'ClientScripts',
    });
  }
  return project;
}

/** Writes a project directory to disk (used by the CLI, the editor and publishing tools). */
export function saveProject(project, directory) {
  const fs = requireNodeFs();
  const path = requireNodePath();
  const files = exportProjectFiles(project);
  for (const file of files) {
    const target = path.join(directory, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content);
  }
  return { directory, files: files.map((file) => file.path) };
}

/** Reads a project directory from disk. */
export function loadProject(directory) {
  const fs = requireNodeFs();
  const path = requireNodePath();
  const files = [];
  const walk = (dir, prefix = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, relative);
      else files.push({ path: relative, content: fs.readFileSync(full, 'utf8') });
    }
  };
  walk(directory);
  return importProjectFiles(files);
}

/**
 * Builds an immutable release bundle for a project. Content hashes are stable for identical
 * content, and the returned bundle is a deep copy: published versions can never be mutated.
 */
export function publishProject(project, { versionNumber = 1, publishedBy = null, changelog = '' } = {}) {
  const bundle = buildVersionBundle(project, { versionNumber, publishedBy, changelog });
  const contentHash = projectContentHash(project);
  bundle.contentHash = contentHash;
  return {
    versionNumber,
    contentHash,
    changelog,
    publishedBy,
    publishedAt: new Date().toISOString(),
    bundle: JSON.parse(JSON.stringify(bundle)),
    stats: projectStats(project),
  };
}

function safeParse(text, fallback) {
  if (text === undefined || text === null) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

let nodeFs = null;
let nodePath = null;

function requireNodeFs() {
  if (!nodeFs) throw new Error('Project file I/O is only available on the server and in the editor.');
  return nodeFs;
}

function requireNodePath() {
  if (!nodePath) throw new Error('Project file I/O is only available on the server and in the editor.');
  return nodePath;
}

/** Hosts that need disk I/O register Node's fs/path here (keeps this module browser-safe). */
export function installProjectFileSystem(fsModule, pathModule) {
  nodeFs = fsModule;
  nodePath = pathModule;
}

export function migrateProject(project) {
  if (!project?.format) return project;
  if (project.format !== PROJECT_FORMAT) return project;
  if ((project.version ?? 0) < 1) {
    project.version = 1;
  }
  project.config = { ...defaultConfig(), ...(project.config ?? {}) };
  project.metadata = { ...createEmptyProject().metadata, ...(project.metadata ?? {}) };
  project.scripts = project.scripts ?? [];
  project.assets = project.assets ?? [];
  return project;
}

export default {
  PROJECT_FORMAT,
  createEmptyProject,
  projectFromWorld,
  worldFromProject,
  buildVersionBundle,
  validateBundle,
  projectContentHash,
  projectStats,
};

// Wire up disk I/O automatically on Node hosts (the browser never executes this branch).
if (typeof process !== 'undefined' && process.versions?.node) {
  try {
    const [fsModule, pathModule] = await Promise.all([import('node:fs'), import('node:path')]);
    installProjectFileSystem(fsModule, pathModule);
  } catch {
    /* disk I/O unavailable — the in-memory project functions still work */
  }
}
