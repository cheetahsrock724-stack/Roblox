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
    world: null,
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
      name: `${script.getName()}.lua`,
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
    world: project.world,
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
