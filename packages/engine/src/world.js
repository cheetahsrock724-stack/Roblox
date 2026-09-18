/**
 * World: the root scene graph plus the systems attached to it (physics, events, services).
 * A World is what a game server simulates and what a client renders.
 */
import { Instance, nextInstanceId } from './instance.js';
import { EventBus } from './events.js';
import { PhysicsWorld } from './physics.js';
import { Vector3 } from './math.js';

export const WORLD_SERVICES = ['Players', 'Lighting', 'SharedStorage', 'ServerScripts', 'ClientScripts', 'UI', 'Audio', 'Assets'];

export class World {
  constructor({ id = nextInstanceId('world'), name = 'World', gravity = -90 } = {}) {
    this.id = id;
    this.name = name;
    this.events = new EventBus();
    this.instances = new Map();
    this.physics = new PhysicsWorld(this, { gravity });
    this.time = 0;
    this.tickCount = 0;
    this.root = new Instance('World', { name, gravity }, { id, world: this });
    this.instances.set(this.root.id, this.root);
    this.root.events.on('childAdded', (child) => this.registerTree(child));
    this.root.events.on('childRemoved', (child) => this.unregisterTree(child));
    this.events.on('objectAdded', ({ instance }) => {
      if (instance.className === 'Lighting') this.lighting = instance;
    });
  }

  /** Creates the standard service containers if they are missing. */
  ensureServices() {
    for (const service of WORLD_SERVICES) {
      if (!this.root.findFirstChild(service)) {
        const instance = new Instance(service, {}, { world: this });
        instance.setParent(this.root);
      }
    }
    this.lighting = this.root.findFirstChild('Lighting');
    this.players = this.root.findFirstChild('Players');
    this.sharedStorage = this.root.findFirstChild('SharedStorage');
    this.serverScripts = this.root.findFirstChild('ServerScripts');
    this.clientScripts = this.root.findFirstChild('ClientScripts');
    this.ui = this.root.findFirstChild('UI');
    this.audio = this.root.findFirstChild('Audio');
    this.assets = this.root.findFirstChild('Assets');
    return this;
  }

  register(instance) {
    this.instances.set(instance.id, instance);
    instance.world = this;
    this.events.fire('objectAdded', { instance });
    if (isPhysicsClass(instance.className)) this.physics.register(instance);
    return instance;
  }

  unregister(instance) {
    this.instances.delete(instance.id);
    this.physics.unregister(instance.id);
    this.events.fire('objectRemoved', { instance });
  }

  registerTree(instance) {
    this.register(instance);
    for (const child of instance.getDescendants()) this.register(child);
  }

  unregisterTree(instance) {
    for (const child of instance.getDescendants()) this.unregister(child);
    this.unregister(instance);
  }

  /** Insert an instance into the tree and register it. */
  add(instance, parent = null) {
    // A `parent` passed inside the property table wins over the default (the root).
    instance.setParent(parent ?? instance.parent ?? this.root);
    if (!this.instances.has(instance.id)) this.registerTree(instance);
    return instance;
  }

  create(className, properties = {}, parent = null) {
    const instance = new Instance(className, properties, { world: this });
    return this.add(instance, parent);
  }

  get(id) {
    return this.instances.get(id) ?? null;
  }

  find(predicate) {
    for (const instance of this.instances.values()) if (predicate(instance)) return instance;
    return null;
  }

  findByClass(className) {
    return [...this.instances.values()].filter((instance) => instance.className === className);
  }

  get spawnPoints() {
    const points = this.findByClass('SpawnPoint').filter((point) => point.getProperty('enabled') !== false);
    if (points.length) return points;
    const fallback = this.root.findFirstChild('SpawnPoint');
    return fallback ? [fallback] : [];
  }

  /** Chooses a spawn transform, avoiding points occupied by other characters. */
  pickSpawn({ occupiedPositions = [] } = {}) {
    const points = this.spawnPoints;
    if (!points.length) return { position: new Vector3(0, 8, 0), rotation: new Vector3(0, 0, 0) };
    const scored = points.map((point) => {
      const position = point.getPosition();
      const nearest = occupiedPositions.reduce(
        (min, other) => Math.min(min, position.distanceTo(other)),
        Number.POSITIVE_INFINITY,
      );
      return { point, position, nearest };
    });
    scored.sort((a, b) => b.nearest - a.nearest);
    const chosen = scored[0];
    const rotation = chosen.point.getProperty('rotation');
    return { position: chosen.position, rotation: new Vector3(rotation.x, rotation.y, rotation.z) };
  }

  tick(deltaSeconds) {
    this.time += deltaSeconds;
    this.tickCount += 1;
    this.physics.step(deltaSeconds);
    this.events.fire('update', { deltaSeconds, time: this.time });
    this.events.fire('heartbeat', { deltaSeconds, time: this.time });
    return this;
  }

  get stats() {
    let parts = 0;
    let scripts = 0;
    let ui = 0;
    for (const instance of this.instances.values()) {
      if (['Part', 'Mesh', 'VehicleSeat', 'Interactable', 'Terrain'].includes(instance.className)) parts += 1;
      else if (instance.className === 'Script') scripts += 1;
      else if (instance.className.startsWith('Text') || instance.className.startsWith('Image') || ['Frame', 'InputField', 'ScrollingList', 'ProgressBar', 'Viewport'].includes(instance.className)) ui += 1;
    }
    return { instances: this.instances.size, parts, scripts, ui, bodies: this.physics.bodies.size, statics: this.physics.statics.size };
  }

  destroy() {
    this.physics.clear();
    this.events.clear();
    this.instances.clear();
  }
}

function isPhysicsClass(className) {
  return ['Part', 'Mesh', 'VehicleSeat', 'Interactable', 'Terrain'].includes(className);
}

export default World;
