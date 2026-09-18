/**
 * Physics: gravity, AABB collision, swept resolution, raycasts, triggers, moving platforms and
 * simple vehicle motion. Deterministic fixed timestep so the server is authoritative and clients
 * can predict locally without drifting.
 */
import { AABB, Ray, Vector3 } from './math.js';
import { MATERIALS } from '@kinetiq/shared';

const CELL_SIZE = 16;

export class SpatialGrid {
  constructor(cellSize = CELL_SIZE) {
    this.cellSize = cellSize;
    this.cells = new Map();
  }

  key(x, y, z) {
    return `${Math.floor(x / this.cellSize)},${Math.floor(y / this.cellSize)},${Math.floor(z / this.cellSize)}`;
  }

  insert(entry) {
    const box = entry.bounds;
    const minKey = this.key(box.min.x, box.min.y, box.min.z);
    const maxKey = this.key(box.max.x, box.max.y, box.max.z);
    const [minX, minY, minZ] = minKey.split(',').map(Number);
    const [maxX, maxY, maxZ] = maxKey.split(',').map(Number);
    entry._cells = [];
    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        for (let z = minZ; z <= maxZ; z += 1) {
          const key = `${x},${y},${z}`;
          if (!this.cells.has(key)) this.cells.set(key, new Set());
          this.cells.get(key).add(entry);
          entry._cells.push(key);
        }
      }
    }
  }

  remove(entry) {
    for (const key of entry._cells ?? []) {
      const cell = this.cells.get(key);
      if (cell) {
        cell.delete(entry);
        if (cell.size === 0) this.cells.delete(key);
      }
    }
    entry._cells = [];
  }

  /** Entries whose cells overlap the box. May include false positives; callers re-test. */
  query(box, out = new Set()) {
    const minX = Math.floor(box.min.x / this.cellSize);
    const minY = Math.floor(box.min.y / this.cellSize);
    const minZ = Math.floor(box.min.z / this.cellSize);
    const maxX = Math.floor(box.max.x / this.cellSize);
    const maxY = Math.floor(box.max.y / this.cellSize);
    const maxZ = Math.floor(box.max.z / this.cellSize);
    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        for (let z = minZ; z <= maxZ; z += 1) {
          const cell = this.cells.get(`${x},${y},${z}`);
          if (cell) for (const entry of cell) out.add(entry);
        }
      }
    }
    return out;
  }

  clear() {
    this.cells.clear();
  }

  get size() {
    return this.cells.size;
  }
}

export function materialProps(material) {
  return MATERIALS.find((entry) => entry.id === material) ?? MATERIALS[0];
}

/**
 * A physics body wraps an instance (Part/Mesh/VehicleSeat/...) with motion state.
 */
export class Body {
  constructor(instance, { shape = 'box' } = {}) {
    this.instance = instance;
    this.id = instance.id;
    this.shape = shape;
    this.velocity = { x: 0, y: 0, z: 0 };
    this.angularVelocity = { x: 0, y: 0, z: 0 };
    this.force = { x: 0, y: 0, z: 0 };
    this.grounded = false;
    this.groundInstanceId = null;
    this.sleeping = false;
    this.mass = Math.max(0.01, Number(instance.getProperty('mass') ?? 1));
    this.bounds = instance.getBounds();
    this.carrier = null;
  }

  get position() {
    return this.instance.getProperty('position');
  }

  get size() {
    return this.instance.getProperty('size');
  }

  refresh() {
    this.bounds = this.instance.getBounds();
    this.mass = Math.max(0.01, Number(this.instance.getProperty('mass') ?? 1));
    return this.bounds;
  }

  applyImpulse(vector) {
    this.velocity.x += vector.x;
    this.velocity.y += vector.y;
    this.velocity.z += vector.z;
    this.sleeping = false;
  }

  teleport(position) {
    this.instance.setProperty('position', position);
    this.refresh();
  }
}

export class PhysicsWorld {
  constructor(world, { gravity = -90, tickRate = 60 } = {}) {
    this.world = world;
    this.gravity = gravity;
    this.tickRate = tickRate;
    this.fixedDt = 1 / tickRate;
    this.accumulator = 0;
    this.bodies = new Map();
    this.grid = new SpatialGrid();
    this.touching = new Set();
    this.statics = new Map();
    this.stats = { steps: 0, bodies: 0, contacts: 0 };
  }

  register(instance) {
    const def = instance.className;
    if (!(def === 'Part' || def === 'Mesh' || def === 'VehicleSeat' || def === 'Interactable' || def === 'Terrain')) return;
    const anchored = Boolean(instance.getProperty('anchored') ?? true);
    const canCollide = Boolean(instance.getProperty('canCollide') ?? true);
    const entry = { instance, bounds: instance.getBounds(), canCollide, anchored, id: instance.id };
    this.grid.insert(entry);
    if (anchored || instance.className === 'Terrain') this.statics.set(instance.id, entry);
    else this.bodies.set(instance.id, new Body(instance, { shape: instance.getProperty('shape') ?? 'box' }));
    this.stats.bodies = this.bodies.size;
  }

  unregister(instanceId) {
    const staticEntry = this.statics.get(instanceId);
    if (staticEntry) {
      this.grid.remove(staticEntry);
      this.statics.delete(instanceId);
    }
    const body = this.bodies.get(instanceId);
    if (body) {
      this.bodies.delete(instanceId);
      this.world.events.fire('bodyRemoved', { id: instanceId });
    }
    this.stats.bodies = this.bodies.size;
  }

  refreshInstance(instance) {
    const body = this.bodies.get(instance.id);
    if (body) body.refresh();
    const staticEntry = this.statics.get(instance.id);
    if (staticEntry) {
      const grid = this.grid;
      grid.remove(staticEntry);
      staticEntry.bounds = instance.getBounds();
      grid.insert(staticEntry);
    }
  }

  /** Advances simulation. Steps in fixed increments for determinism. */
  step(deltaSeconds, { hostId = null } = {}) {
    this.accumulator += Math.min(deltaSeconds, 0.25);
    let stepped = 0;
    while (this.accumulator >= this.fixedDt && stepped < 8) {
      this.fixedStep(this.fixedDt);
      this.accumulator -= this.fixedDt;
      stepped += 1;
      this.stats.steps += 1;
    }
    return stepped;
  }

  fixedStep(dt) {
    // 1. Kinematic (anchored) motion: moving platforms carry riders.
    for (const entry of this.statics.values()) {
      const linear = entry.instance.getProperty('linearVelocity');
      if (!linear || (!linear.x && !linear.y && !linear.z)) continue;
      const position = entry.instance.getProperty('position');
      const next = { x: position.x + linear.x * dt, y: position.y + linear.y * dt, z: position.z + linear.z * dt };
      entry.instance.setProperty('position', next);
      // Wrap platforms that travel between two points via `value = "minY:maxY"` style bounds.
      this.refreshInstance(entry.instance);
    }

    // 2. Dynamic bodies: integrate gravity, then resolve against statics and other bodies.
    for (const body of this.bodies.values()) {
      if (body.sleeping) continue;
      const instance = body.instance;
      if (instance.getProperty('anchored')) continue;
      const material = materialProps(instance.getProperty('material') ?? 'plastic');
      const gravityScale = 1;
      body.velocity.y += this.gravity * gravityScale * dt;
      body.velocity.x += (body.force.x / body.mass) * dt;
      body.velocity.y += (body.force.y / body.mass) * dt;
      body.velocity.z += (body.force.z / body.mass) * dt;
      body.force = { x: 0, y: 0, z: 0 };

      // Damping approximates friction/air drag.
      const damping = Math.max(0, 1 - material.friction * dt * 2);
      body.velocity.x *= damping;
      body.velocity.z *= damping;

      this.moveBody(body, dt, material);
      if (body.carrier) {
        const carrier = this.statics.get(body.carrier);
        const linear = carrier?.instance.getProperty('linearVelocity');
        if (linear) {
          const position = instance.getProperty('position');
          instance.setProperty('position', {
            x: position.x + linear.x * dt,
            y: position.y,
            z: position.z + linear.z * dt,
          });
          body.refresh();
        }
      }
      if (Math.hypot(body.velocity.x, body.velocity.y, body.velocity.z) < 0.02 && body.grounded) body.sleeping = true;
    }

    // 3. Trigger volumes (Interactable / non-colliding parts) for objectTouched events.
    this.updateTriggers();
  }

  moveBody(body, dt, material) {
    const instance = body.instance;
    const size = instance.getProperty('size');
    const position = instance.getProperty('position');
    const next = { x: position.x, y: position.y, z: position.z };
    body.grounded = false;
    let contactCount = 0;

    // Axis-separated swept resolution keeps behaviour predictable and prevents tunnelling at
    // typical speeds because we cap per-step movement below.
    const maxStep = 0.9 * Math.max(0.05, Math.min(size.x, size.y, size.z));
    const totalDx = body.velocity.x * dt;
    const totalDy = body.velocity.y * dt;
    const totalDz = body.velocity.z * dt;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(totalDx), Math.abs(totalDy), Math.abs(totalDz)) / maxStep));
    const dx = totalDx / steps;
    const dy = totalDy / steps;
    const dz = totalDz / steps;

    for (let step = 0; step < steps; step += 1) {
      // X
      next.x += dx;
      let hit = this.collideAxis(instance, next, size, 'x', dx > 0 ? 1 : -1);
      if (hit) {
        hit.body.velocity.x = hit.entry?.instance.getProperty('linearVelocity')?.x ?? 0;
        contactCount += 1;
      }
      // Z
      next.z += dz;
      hit = this.collideAxis(instance, next, size, 'z', dz > 0 ? 1 : -1);
      if (hit) {
        hit.body.velocity.z = hit.entry?.instance.getProperty('linearVelocity')?.z ?? 0;
        contactCount += 1;
      }
      // Y (gravity axis — detect grounding here)
      next.y += dy;
      hit = this.collideAxis(instance, next, size, 'y', dy > 0 ? 1 : -1);
      if (hit) {
        if (dy < 0) {
          body.grounded = true;
          body.groundInstanceId = hit.entry?.instance.id ?? null;
          body.carrier = hit.entry?.anchored ? hit.entry.instance.id : null;
        }
        if (material.restitution > 0.02 && Math.abs(hit.body.velocity.y) > 3) {
          hit.body.velocity.y = -hit.body.velocity.y * material.restitution;
        } else {
          hit.body.velocity.y = 0;
        }
        contactCount += 1;
      }
    }

    instance.setProperty('position', next);
    body.bounds = instance.getBounds();
    this.stats.contacts = contactCount;
    this.emitTouches(body, contactCount);
    return contactCount;
  }

  /**
   * Resolve one axis. Returns { entry, body } when a collision stopped movement on that axis,
   * mutating `body.velocity` and clamping `position`.
   */
  collideAxis(instance, position, size, axis, sign) {
    const body = {
      velocity: { x: 0, y: 0, z: 0 },
      instance,
    };
    // Reuse the live velocity object so the caller can mutate it.
    const liveBody = this.bodies.get(instance.id);
    if (liveBody) body.velocity = liveBody.velocity;
    const box = AABB.fromCenterSize(new Vector3(position.x, position.y, position.z), new Vector3(size.x, size.y, size.z));
    const candidates = this.grid.query(padded(box, 0.001));
    for (const entry of candidates) {
      if (entry.instance.id === instance.id) continue;
      if (!entry.canCollide) continue;
      if (!AABB.overlap(box, entry.bounds)) continue;
      // Penetration resolution along the moving axis only.
      if (axis === 'x') {
        position.x = sign > 0 ? entry.bounds.min.x - size.x / 2 : entry.bounds.max.x + size.x / 2;
        body.velocity.x = 0;
      } else if (axis === 'z') {
        position.z = sign > 0 ? entry.bounds.min.z - size.z / 2 : entry.bounds.max.z + size.z / 2;
        body.velocity.z = 0;
      } else {
        position.y = sign > 0 ? entry.bounds.min.y - size.y / 2 : entry.bounds.max.y + size.y / 2;
      }
      return { entry, body };
    }
    return null;
  }

  emitTouches(body, contactCount) {
    const instance = body.instance;
    const key = `${instance.id}:contact`;
    if (contactCount > 0 && !this.touching.has(key)) {
      this.touching.add(key);
      this.world.events.fire('objectTouched', { instance, body });
    } else if (contactCount === 0 && this.touching.has(key)) {
      this.touching.delete(key);
      this.world.events.fire('touchEnded', { instance, body });
    }
  }

  updateTriggers() {
    for (const [id, body] of this.bodies) {
      const instance = body.instance;
      const canCollide = instance.getProperty('canCollide');
      if (canCollide) continue;
      const box = instance.getBounds();
      const key = `${id}:trigger`;
      const hits = new Set();
      for (const entry of this.grid.query(box)) {
        if (entry.instance.id === id) continue;
        if (AABB.overlap(box, entry.bounds)) hits.add(entry.instance.id);
      }
      const previous = this.triggerState?.get(id) ?? new Set();
      this.triggerState = this.triggerState ?? new Map();
      for (const hitId of hits) {
        if (!previous.has(hitId)) {
          const other = this.world.instances.get(hitId);
          this.world.events.fire('objectTouched', { instance: other, trigger: instance });
          this.world.events.fire('triggerEntered', { trigger: instance, other });
        }
      }
      for (const hitId of previous) {
        if (!hits.has(hitId)) {
          const other = this.world.instances.get(hitId);
          this.world.events.fire('triggerExited', { trigger: instance, other });
        }
      }
      this.triggerState.set(id, hits);
      void key;
    }
  }

  /** Raycast against collidable instances. Returns { instance, position, distance, normal }. */
  raycast(origin, direction, { maxDistance = 500, ignore = [], filter = null, includeNonColliding = false } = {}) {
    const ray = new Ray(origin, direction);
    const ignoreSet = new Set(ignore);
    const delta = new Vector3(ray.direction.x * maxDistance, ray.direction.y * maxDistance, ray.direction.z * maxDistance);
    const box = {
      min: new Vector3(Math.min(origin.x, origin.x + delta.x), Math.min(origin.y, origin.y + delta.y), Math.min(origin.z, origin.z + delta.z)),
      max: new Vector3(Math.max(origin.x, origin.x + delta.x), Math.max(origin.y, origin.y + delta.y), Math.max(origin.z, origin.z + delta.z)),
    };
    let best = null;
    for (const entry of this.grid.query(box)) {
      if (ignoreSet.has(entry.instance.id)) continue;
      if (!includeNonColliding && !entry.canCollide) continue;
      if (filter && !filter(entry.instance)) continue;
      const hit = rayAABB(ray, entry.bounds, maxDistance);
      if (hit && (!best || hit.distance < best.distance)) {
        // NOTE: spread first — later keys win, so `instance` must be assigned after.
        best = { ...hit, instance: entry.instance };
      }
    }
    return best;
  }

  /** All instances overlapping a box (used for explosions and area effects). */
  queryBox(center, size, { filter = null, maxResults = 200 } = {}) {
    const box = AABB.fromCenterSize(center, size);
    const results = [];
    for (const entry of this.grid.query(box)) {
      if (!AABB.overlap(box, entry.bounds)) continue;
      if (filter && !filter(entry.instance)) continue;
      results.push(entry.instance);
      if (results.length >= maxResults) break;
    }
    return results;
  }

  /** Sphere/point check for interaction prompts. */
  nearestWithin(point, radius, filter) {
    let best = null;
    const box = AABB.fromCenterSize(point, new Vector3(radius * 2, radius * 2, radius * 2));
    for (const entry of this.grid.query(box)) {
      if (filter && !filter(entry.instance)) continue;
      const center = AABB.center(entry.bounds);
      const distance = center.sub(point).magnitude;
      if (distance <= radius && (!best || distance < best.distance)) best = { instance: entry.instance, distance };
    }
    return best;
  }

  applyRadialImpulse(center, radius, strength, { includeAnchored = false } = {}) {
    const affected = [];
    for (const body of this.bodies.values()) {
      if (body.instance.getProperty('anchored')) continue;
      const position = body.position;
      const toCenter = new Vector3(center.x - position.x, center.y - position.y, center.z - position.z);
      const distance = toCenter.magnitude;
      if (distance > radius) continue;
      const falloff = 1 - distance / radius;
      const direction = toCenter.unit;
      body.applyImpulse({
        x: direction.x * strength * falloff,
        y: direction.y * strength * falloff + strength * falloff * 0.35,
        z: direction.z * strength * falloff,
      });
      affected.push(body.instance.id);
    }
    if (includeAnchored) {
      for (const entry of this.statics.values()) {
        const center2 = AABB.center(entry.bounds);
        if (new Vector3(center.x - center2.x, center.y - center2.y, center.z - center2.z).magnitude <= radius) {
          entry.instance.setProperty('anchored', false);
          this.register(entry.instance);
          affected.push(entry.instance.id);
        }
      }
    }
    return affected;
  }

  clear() {
    this.bodies.clear();
    this.statics.clear();
    this.grid.clear();
    this.touching.clear();
    this.triggerState = new Map();
  }
}

function padded(box, amount) {
  return {
    min: { x: box.min.x - amount, y: box.min.y - amount, z: box.min.z - amount },
    max: { x: box.max.x + amount, y: box.max.y + amount, z: box.max.z + amount },
  };
}

/** Slab-method ray/AABB intersection. */
export function rayAABB(ray, box, maxDistance) {
  let tmin = 0;
  let tmax = maxDistance;
  let hitAxis = null;
  let hitSign = 0;
  for (const axis of ['x', 'y', 'z']) {
    const origin = ray.origin[axis];
    const direction = ray.direction[axis];
    const min = box.min[axis];
    const max = box.max[axis];
    if (Math.abs(direction) < 1e-9) {
      if (origin < min || origin > max) return null;
      continue;
    }
    const inv = 1 / direction;
    let t1 = (min - origin) * inv;
    let t2 = (max - origin) * inv;
    let sign = -1;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      sign = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      hitAxis = axis;
      hitSign = sign;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  const normal = { x: 0, y: 0, z: 0 };
  if (hitAxis) normal[hitAxis] = hitSign;
  return {
    distance: tmin,
    position: ray.at(tmin),
    normal: new Vector3(normal.x, normal.y, normal.z),
  };
}

export default PhysicsWorld;
