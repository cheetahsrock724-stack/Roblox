/**
 * Scene serialization + chunked streaming.
 *
 * `world.scene` files are JSON with a stable shape:
 *   { format: "kinetiq.scene", version: 1, meta, services: [...instances], chunks: {id: {...}} }
 *
 * Large worlds are partitioned into spatial chunks so a client can start playing after
 * downloading only the chunks around the spawn point (world streaming).
 */
import { World } from './world.js';
import { Instance } from './instance.js';

export const SCENE_FORMAT = 'kinetiq.scene';
export const SCENE_VERSION = 1;
export const DEFAULT_CHUNK_SIZE = 128;

/**
 * Converts a property value into something JSON can hold.
 *
 * Object references (a `parent` property, for instance) become `{ __ref: id }` so the tree can be
 * rebuilt on load; functions are dropped. `structuredClone` is deliberately not used here: engine
 * properties can hold live instances, which are not cloneable.
 */
export function serializeValue(value) {
  if (value === null || value === undefined) return null;
  const type = typeof value;
  if (type === 'number' || type === 'string' || type === 'boolean') return value;
  if (type === 'function') return undefined;
  if (Array.isArray(value)) {
    const out = [];
    for (const entry of value) {
      const converted = serializeValue(entry);
      if (converted !== undefined) out.push(converted);
    }
    return out;
  }
  if (type === 'object') {
    if (isInstanceLike(value)) return { __ref: value.id };
    if (typeof value.toJSON === 'function') return value.toJSON();
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      const converted = serializeValue(entry);
      if (converted !== undefined) out[key] = converted;
    }
    return out;
  }
  return undefined;
}

function isInstanceLike(value) {
  return Boolean(value) && typeof value === 'object' && typeof value.id === 'string' && 'className' in value && '_props' in value;
}

export function serializeInstance(instance) {
  const properties = {};
  for (const [key, value] of Object.entries(instance._props)) {
    if (key === 'parent') continue; // parenting is carried by the tree structure
    const converted = serializeValue(value);
    if (converted !== undefined) properties[key] = converted;
  }
  return {
    id: instance.id,
    className: instance.className,
    name: instance.getName(),
    tags: [...instance.tags],
    properties,
    children: instance.children.map(serializeInstance),
  };
}

// Helper kept for callers that want raw (already cloneable) property maps.
Instance.prototype.rawPropertiesWithNoReplicate = function rawPropertiesWithNoReplicate() {
  const out = {};
  for (const [key, value] of Object.entries(this._props)) {
    if (key === 'parent') continue;
    const converted = serializeValue(value);
    if (converted !== undefined) out[key] = converted;
  }
  return out;
};

export function serializeWorld(world, { includeChunks = true, chunkSize = DEFAULT_CHUNK_SIZE } = {}) {
  const services = [];
  const loose = [];
  for (const child of world.root.children) {
    if (child.className === 'ServerScripts' || child.className === 'ClientScripts' || child.className === 'SharedStorage') {
      services.push(serializeInstance(child));
    } else if (child.className === 'Lighting' || child.className === 'Players') {
      services.push(serializeInstance(child));
    } else if (child.className === 'UI') {
      services.push(serializeInstance(child));
    } else if (child.className === 'Audio' || child.className === 'Assets') {
      services.push(serializeInstance(child));
    } else {
      loose.push(child);
    }
  }
  const scene = {
    format: SCENE_FORMAT,
    version: SCENE_VERSION,
    meta: {
      id: world.id,
      name: world.name,
      gravity: world.root.getProperty('gravity'),
      savedAt: new Date().toISOString(),
      stats: world.stats,
    },
    services,
    chunks: includeChunks ? partitionIntoChunks(loose, chunkSize) : {},
    root: includeChunks ? null : serializeInstance(world.root),
  };
  return scene;
}

/** Groups top-level instances (and their subtrees) into spatial chunks for streaming. */
export function partitionIntoChunks(instances, chunkSize = DEFAULT_CHUNK_SIZE) {
  const chunks = {};
  let chunkIndex = 0;
  for (const instance of instances) {
    const { key, payload } = chunkForInstance(instance, chunkSize);
    if (!chunks[key]) {
      chunks[key] = {
        id: key,
        index: chunkIndex++,
        bounds: payload.bounds,
        roots: [],
        sizeBytes: 0,
      };
    }
    const serialized = serializeInstance(instance);
    chunks[key].roots.push(serialized);
    chunks[key].sizeBytes += JSON.stringify(serialized).length;
    chunks[key].bounds = mergeBounds(chunks[key].bounds, payload.bounds);
  }
  return chunks;
}

function chunkForInstance(instance, chunkSize) {
  const bounds = subtreeBounds(instance);
  const centerX = Math.floor((bounds.min[0] + bounds.max[0]) / 2 / chunkSize) * chunkSize;
  const centerZ = Math.floor((bounds.min[2] + bounds.max[2]) / 2 / chunkSize) * chunkSize;
  // Services/scripts have no meaningful position; bucket them into the global chunk.
  const isSpatial = ['Part', 'Mesh', 'Interactable', 'VehicleSeat', 'Terrain', 'Model', 'SpawnPoint', 'NPC', 'Light'].includes(
    instance.className,
  );
  const key = isSpatial ? `c_${centerX}_${centerZ}` : 'c_global';
  return { key, payload: { bounds } };
}

export function subtreeBounds(instance) {
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  const consider = (node) => {
    if (node.className === 'Model' || node.className === 'Folder') return;
    if (typeof node.getBounds !== 'function') return;
    const box = node.getBounds();
    min = [Math.min(min[0], box.min.x), Math.min(min[1], box.min.y), Math.min(min[2], box.min.z)];
    max = [Math.max(max[0], box.max.x), Math.max(max[1], box.max.y), Math.max(max[2], box.max.z)];
  };
  consider(instance);
  for (const descendant of instance.getDescendants()) consider(descendant);
  if (!Number.isFinite(min[0])) {
    min = [0, 0, 0];
    max = [0, 0, 0];
  }
  return {
    min: min.map(round3),
    max: max.map(round3),
    center: [round3((min[0] + max[0]) / 2), round3((min[1] + max[1]) / 2), round3((min[2] + max[2]) / 2)],
  };
}

function mergeBounds(a, b) {
  if (!a) return b;
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
    center: [
      round3((Math.min(a.min[0], b.min[0]) + Math.max(a.max[0], b.max[0])) / 2),
      round3((Math.min(a.min[1], b.min[1]) + Math.max(a.max[1], b.max[1])) / 2),
      round3((Math.min(a.min[2], b.min[2]) + Math.max(a.max[2], b.max[2])) / 2),
    ],
  };
}

function round3(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

/** Rebuilds an instance (and children) from serialized JSON. */
export function deserializeInstance(json, world, parent = null) {
  const InstanceClass = Instance;
  const properties = {};
  for (const [key, value] of Object.entries(json.properties ?? {})) {
    // A property that references another instance is resolved once the whole tree exists.
    if (value && typeof value === 'object' && typeof value.__ref === 'string') continue;
    properties[key] = value;
  }
  const instance = new InstanceClass(json.className, properties, { id: json.id, world });
  if (json.name) instance.setProperty('name', json.name);
  if (Array.isArray(json.tags)) instance.tags = new Set(json.tags);
  for (const [key, value] of Object.entries(json.properties ?? {})) {
    if (!value || typeof value !== 'object' || typeof value.__ref !== 'string') continue;
    if (key === 'parent') continue;
    const target = world.get(value.__ref);
    if (target) instance.setProperty(key, target);
  }
  for (const childJson of json.children ?? []) deserializeInstance(childJson, world, instance);
  if (parent) instance.setParent(parent);
  return instance;
}

export function deserializeWorld(scene, { world = null } = {}) {
  if (scene?.format && scene.format !== SCENE_FORMAT) {
    throw new Error(`Unsupported scene format: ${scene.format}`);
  }
  const target =
    world ?? new World({ id: scene?.meta?.id, name: scene?.meta?.name ?? 'World', gravity: scene?.meta?.gravity ?? -90 });
  target.ensureServices();
  if (scene?.root) {
    for (const childJson of scene.root.children ?? []) deserializeInstance(childJson, target, target.root);
  }
  if (scene?.services) {
    for (const serviceJson of scene.services) {
      const existing = target.root.findFirstChild(serviceJson.name);
      if (existing) {
        for (const childJson of serviceJson.children ?? []) {
          const child = deserializeInstance(childJson, target, existing);
          void child;
        }
      } else {
        deserializeInstance(serviceJson, target, target.root);
      }
    }
  }
  if (scene?.chunks) {
    for (const chunk of Object.values(scene.chunks)) {
      for (const rootJson of chunk.roots ?? []) deserializeInstance(rootJson, target, target.root);
    }
  }
  return target;
}

/** Applies a chunk to an already-running world (client streaming). */
export function applyChunk(scene, chunkId, world) {
  const chunk = scene?.chunks?.[chunkId];
  if (!chunk) return 0;
  let count = 0;
  for (const rootJson of chunk.roots ?? []) {
    if (world.get(rootJson.id)) continue;
    deserializeInstance(rootJson, world, world.root);
    count += 1;
  }
  return count;
}

/** Chunks whose bounds fall inside a radius around a point. */
export function chunksNear(scene, position, radius) {
  const out = [];
  for (const [id, chunk] of Object.entries(scene?.chunks ?? {})) {
    if (id === 'c_global') {
      out.push(id);
      continue;
    }
    const center = chunk.bounds?.center ?? [0, 0, 0];
    const dx = center[0] - position.x;
    const dz = center[2] - position.z;
    if (Math.hypot(dx, dz) <= radius + 64) out.push(id);
  }
  return out;
}
