/**
 * Instance: the reusable scene object every world is built from.
 *
 * Every instance has: id, name, className, parent, children, transform, typed properties, tags.
 * Property writes are validated against the class definition, so scripts cannot put a string into
 * a numeric property or an arbitrary object into a colour.
 */
import { CLASS_DEFS, classDef, defaultProps, isCreatable, propertySpec } from './classes.js';
import { Vector3, Color3, UDim2 } from './math.js';
import { Signal, EventBus } from './events.js';

let instanceCounter = 0;

export function nextInstanceId(className = 'obj') {
  instanceCounter += 1;
  const stamp = Date.now().toString(36).slice(-5);
  const prefix = String(className).slice(0, 3).toLowerCase();
  return `${prefix}_${stamp}${instanceCounter.toString(36)}`;
}

export function resetInstanceCounter() {
  instanceCounter = 0;
}

function coerceValue(spec, value, { property } = {}) {
  if (!spec) return value;
  switch (spec.type) {
    case 'number': {
      const num = Number(value);
      if (!Number.isFinite(num)) throw new TypeError(`Property ${property} expects a number`);
      return clampNumber(num, spec);
    }
    case 'integer': {
      const num = Math.trunc(Number(value));
      if (!Number.isFinite(num)) throw new TypeError(`Property ${property} expects an integer`);
      return clampNumber(num, spec);
    }
    case 'boolean':
      return Boolean(value);
    case 'string':
      return value === null || value === undefined ? '' : String(value).slice(0, 200_000);
    case 'color': {
      if (value instanceof Color3) return value.toHex();
      const str = String(value ?? '').trim();
      if (/^#[0-9a-f]{3,8}$/i.test(str) || /^rgba?\(/i.test(str) || Object.keys(PALETTE_NAMES).includes(str.toLowerCase())) {
        return value instanceof Color3 ? str : str.toLowerCase();
      }
      throw new TypeError(`Property ${property} expects a colour such as "#3d5afe"`);
    }
    case 'vector3': {
      if (value instanceof Vector3) return toPlain(value);
      if (Array.isArray(value)) return { x: Number(value[0]) || 0, y: Number(value[1]) || 0, z: Number(value[2]) || 0 };
      if (value && typeof value === 'object') {
        return { x: Number(value.x) || 0, y: Number(value.y) || 0, z: Number(value.z) || 0 };
      }
      throw new TypeError(`Property ${property} expects a Vector3`);
    }
    case 'enum': {
      const str = String(value);
      if (spec.enum && !spec.enum.includes(str)) {
        throw new TypeError(`Property ${property} must be one of: ${spec.enum.join(', ')}`);
      }
      return str;
    }
    case 'udim2': {
      if (value instanceof UDim2) return value.toArray();
      if (Array.isArray(value)) {
        return [num(value[0]), num(value[1]), num(value[2]), num(value[3])];
      }
      if (value && typeof value === 'object') {
        return [num(value.xScale), num(value.xOffset), num(value.yScale), num(value.yOffset)];
      }
      throw new TypeError(`Property ${property} expects a UDim2 [xScale, xOffset, yScale, yOffset]`);
    }
    case 'array': {
      if (!Array.isArray(value)) throw new TypeError(`Property ${property} expects an array`);
      if (value.length > 10000) throw new TypeError(`Property ${property} is limited to 10000 entries`);
      return value.map((item) => (item && typeof item === 'object' ? structuredClone(item) : item));
    }
    case 'object':
    case 'json': {
      if (value === null || typeof value !== 'object') throw new TypeError(`Property ${property} expects an object`);
      return JSON.parse(JSON.stringify(value));
    }
    default:
      return value;
  }
}

const PALETTE_NAMES = {
  white: 1, black: 1, grey: 1, gray: 1, red: 1, orange: 1, yellow: 1, green: 1, teal: 1,
  blue: 1, purple: 1, pink: 1, brown: 1, skin: 1,
};

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function clampNumber(value, spec) {
  let out = value;
  if (spec.min !== undefined) out = Math.max(spec.min, out);
  if (spec.max !== undefined) out = Math.min(spec.max, out);
  return out;
}

function toPlain(vector) {
  return { x: vector.x, y: vector.y, z: vector.z };
}

export class Instance {
  constructor(className, properties = {}, { id = null, world = null } = {}) {
    if (!CLASS_DEFS[className]) throw new Error(`Unknown instance class: ${className}`);
    this.id = id ?? nextInstanceId(className);
    this.className = className;
    this._props = { ...defaultProps(className), ...properties };
    this._parent = null;
    this._children = [];
    this.tags = new Set(properties.tags ?? []);
    this.world = world;
    this.events = new EventBus();
    this.changed = new Signal(`changed:${this.id}`);
    this._destroyed = false;
    if (this._props.tags) delete this._props.tags;
    // `parent` is structural rather than a plain property, so it is applied after construction.
    const initialParent = properties.parent ?? null;
    delete this._props.parent;
    if (initialParent) this.setParent(initialParent);
  }

  get name() {
    return this.getName();
  }
  set name(value) {
    this.setProperty('name', String(value));
  }

  getName() {
    const value = this._props.name;
    return value === undefined || value === null || value === '' ? this.className : String(value);
  }

  /** Set a property, validating against the class spec. Emits `changed`. */
  setProperty(property, value) {
    if (this._destroyed) throw new Error(`Cannot modify a destroyed instance (${this.className})`);
    if (property === 'name') {
      const name = String(value).slice(0, 120);
      const previous = this.getName();
      this._props.name = name;
      this.changed.fire({ property: 'name', value: name, previous });
      this.world?.events.fire('objectChanged', { instance: this, property: 'name', value: name });
      return name;
    }
    if (property === 'parent') {
      this.setParent(value);
      return this._parent;
    }
    if (property === 'tags') {
      this.tags = new Set(Array.isArray(value) ? value.map(String) : []);
      return [...this.tags];
    }
    const spec = propertySpec(this.className, property);
    if (!spec) throw new Error(`${this.className} has no property "${property}"`);
    if (spec.readOnly) throw new Error(`Property ${property} is read-only`);
    const next = coerceValue(spec, value, { property });
    const previous = this._props[property];
    this._props[property] = next;
    this.changed.fire({ property, value: next, previous });
    this.world?.events.fire('objectChanged', { instance: this, property, value: next, previous });
    return next;
  }

  /** Read a property. Returns a live Vector3/Color3/UDim2 wrapper for ergonomic scripts. */
  getProperty(property) {
    if (property === 'name') return this.getName();
    if (property === 'parent') return this._parent;
    if (property === 'tags') return [...this.tags];
    const spec = propertySpec(this.className, property);
    if (!spec) throw new Error(`${this.className} has no property "${property}"`);
    const raw = this._props[property];
    return wrapValue(spec, raw, this, property);
  }

  hasProperty(property) {
    return property === 'name' || property === 'parent' || property === 'tags' || Boolean(propertySpec(this.className, property));
  }

  getPropertyNames() {
    return ['name', ...Object.keys(classDef(this.className).props)];
  }

  /** Plain JSON-safe property bag (used by serialization and replication). */
  rawProperties() {
    const out = {};
    for (const [key, spec] of Object.entries(classDef(this.className).props)) {
      if (spec.noReplicate) continue;
      out[key] = structuredClone(this._props[key]);
    }
    return out;
  }

  /** ---------------------------------------------------------------- hierarchy */
  get parent() {
    return this._parent;
  }

  get children() {
    return this._children;
  }

  setParent(parent) {
    if (parent === this) throw new Error('An instance cannot be its own parent');
    if (parent && !(parent instanceof Instance)) throw new Error('Parent must be an Instance');
    if (parent && isDescendantOf(parent, this)) throw new Error('Cannot parent an instance into its own descendant');
    if (this._parent) {
      const index = this._parent._children.indexOf(this);
      if (index >= 0) this._parent._children.splice(index, 1);
      this._parent.events.fire('childRemoved', this);
    }
    this._parent = parent ?? null;
    if (parent) {
      parent._children.push(this);
      parent.events.fire('childAdded', this);
    }
    // Keep the world's instance index in sync no matter where the parent lives (services are not
    // subscribed to `childAdded`, so registration happens here rather than only in World.add).
    if (this.world && !this.world.instances.has(this.id)) this.world.registerTree(this);
    this.world?.events.fire('objectReparented', { instance: this, parent });
    return this._parent;
  }

  findFirstChild(name, recursive = false) {
    for (const child of this._children) {
      if (child.getName() === name || child.id === name) return child;
    }
    if (recursive) {
      for (const child of this._children) {
        const found = child.findFirstChild(name, true);
        if (found) return found;
      }
    }
    return null;
  }

  findFirstChildOfClass(className) {
    return this._children.find((child) => child.className === className) ?? null;
  }

  findFirstChildOfClassRecursive(className) {
    for (const child of this._children) {
      if (child.className === className) return child;
      const found = child.findFirstChildOfClassRecursive(className);
      if (found) return found;
    }
    return null;
  }

  findChildrenOfClass(className, out = []) {
    for (const child of this._children) {
      if (child.className === className) out.push(child);
      child.findChildrenOfClass(className, out);
    }
    return out;
  }

  findFirstDescendant(predicate) {
    for (const child of this._children) {
      if (predicate(child)) return child;
      const found = child.findFirstDescendant(predicate);
      if (found) return found;
    }
    return null;
  }

  getDescendants(out = []) {
    for (const child of this._children) {
      out.push(child);
      child.getDescendants(out);
    }
    return out;
  }

  getFullName() {
    const parts = [];
    let cursor = this;
    while (cursor && cursor.className !== 'World') {
      parts.unshift(cursor.getName());
      cursor = cursor.parent;
    }
    return parts.join('.');
  }

  isDescendantOf(possiblyAncestor) {
    return isDescendantOf(this, possiblyAncestor);
  }

  isA(className) {
    if (this.className === className) return true;
    // minimal inheritance chain for UI + Part-like classes
    if (className === 'UIElement') return Boolean(CLASS_DEFS[this.className]?.ui);
    if (className === 'BasePart') {
      return ['Part', 'Mesh', 'VehicleSeat', 'Interactable', 'Terrain'].includes(this.className);
    }
    if (className === 'Instance') return true;
    return false;
  }

  /** ---------------------------------------------------------------- mutation */
  clone({ newIds = true, deep = true, parent = null } = {}) {
    const copy = new Instance(this.className, structuredClone(this._props), {
      id: newIds ? nextInstanceId(this.className) : this.id,
      world: this.world,
    });
    copy.tags = new Set(this.tags);
    if (deep) for (const child of this._children) copy.addChild(child.clone({ newIds, deep }));
    if (parent) copy.setParent(parent);
    return copy;
  }

  addChild(child) {
    child.setParent(this);
    return child;
  }

  removeChild(child) {
    if (child._parent === this) child.setParent(null);
  }

  destroy() {
    if (this._destroyed) return;
    for (const child of [...this._children]) child.destroy();
    const parent = this._parent;
    this._destroyed = true;
    this.world?.events.fire('objectRemoved', { instance: this, parent });
    if (parent) {
      const index = parent._children.indexOf(this);
      if (index >= 0) parent._children.splice(index, 1);
      parent.events.fire('childRemoved', this);
    }
    this._parent = null;
    this.world?.unregister(this);
    this.events.clear();
    this.changed.disconnectAll();
    if (this.world && this.world.instances.get(this.id) === this) this.world.instances.delete(this.id);
  }

  /**
   * Deep equality of a subtree, used by the editor for dirty tracking and by publishing
   * to detect "already published" states.
   */
  equals(other) {
    return JSON.stringify(this.toJSON()) === JSON.stringify(other?.toJSON());
  }

  /** ---------------------------------------------------------------- helpers */
  get transform() {
    return {
      position: this._props.position ? { ...this._props.position } : { x: 0, y: 0, z: 0 },
      rotation: this._props.rotation ? { ...this._props.rotation } : { x: 0, y: 0, z: 0 },
      size: this._props.size ? { ...this._props.size } : { x: 1, y: 1, z: 1 },
    };
  }

  getPosition() {
    const p = this._props.position ?? { x: 0, y: 0, z: 0 };
    return new Vector3(p.x, p.y, p.z);
  }

  setPosition(vector) {
    this.setProperty('position', vector);
    return this.getPosition();
  }

  getSize() {
    const s = this._props.size ?? { x: 1, y: 1, z: 1 };
    return new Vector3(s.x, s.y, s.z);
  }

  getColor() {
    return Color3.fromHex(this._props.color ?? '#ffffff');
  }

  /** World-space bounds for physics/render culling (terrain exposes its own box). */
  getBounds() {
    const position = this._props.position ?? { x: 0, y: 0, z: 0 };
    const size = this._props.size ?? this._props.scale ?? { x: 1, y: 1, z: 1 };
    const half = { x: size.x / 2, y: size.y / 2, z: size.z / 2 };
    return {
      min: { x: position.x - half.x, y: position.y - half.y, z: position.z - half.z },
      max: { x: position.x + half.x, y: position.y + half.y, z: position.z + half.z },
    };
  }

  toJSON() {
    return {
      id: this.id,
      className: this.className,
      name: this.getName(),
      tags: [...this.tags],
      properties: structuredClone(this._props),
      children: this._children.map((child) => child.toJSON()),
    };
  }

  toString() {
    return `${this.className}(${this.getName()})`;
  }

  /** PascalCase aliases so scripts read naturally: part.Name, part.Position. */
  get Name() {
    return this.getName();
  }
  set Name(value) {
    this.setProperty('name', value);
  }
  get ClassName() {
    return this.className;
  }
  get Parent() {
    return this._parent;
  }
  set Parent(value) {
    this.setParent(value);
  }
  get Children() {
    return [...this._children];
  }
  get Id() {
    return this.id;
  }

  FindFirstChild(name, recursive = false) {
    return this.findFirstChild(name, recursive);
  }
  WaitForChild(name, timeoutSeconds = 5) {
    const existing = this.findFirstChild(name);
    if (existing) return existing;
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutSeconds * 1000;
      const tick = () => {
        const found = this.findFirstChild(name);
        if (found) return resolve(found);
        if (Date.now() > deadline) return resolve(null);
        const connection = this.events.on('childAdded', (child) => {
          if (child.getName() === name) {
            connection.disconnect();
            resolve(child);
          }
        });
      };
      tick();
    });
  }
  FindFirstChildOfClass(className) {
    return this.findFirstChildOfClass(className);
  }
  GetChildren() {
    return [...this._children];
  }
  GetDescendants() {
    return this.getDescendants();
  }
  IsA(className) {
    return this.isA(className);
  }
  Destroy() {
    return this.destroy();
  }
  Clone() {
    return this.clone();
  }
  GetFullName() {
    return this.getFullName();
  }
  GetPivot() {
    return this.transform;
  }
}

function isDescendantOf(instance, ancestor) {
  let cursor = instance._parent;
  while (cursor) {
    if (cursor === ancestor) return true;
    cursor = cursor._parent;
  }
  return false;
}

function wrapValue(spec, raw, instance, property) {
  if (raw === undefined || raw === null) return raw;
  switch (spec.type) {
    case 'vector3':
      return new Vector3(raw.x, raw.y, raw.z);
    case 'color':
      return Color3.fromHex(raw);
    case 'udim2':
      return UDim2.fromArray(raw);
    default:
      return raw;
  }
}

/** Convenience constructors used in code and by the `World:create` script API. */
export function createInstance(className, properties = {}, world = null) {
  if (!CLASS_DEFS[className]) throw new Error(`Unknown instance class: ${className}`);
  if (!isCreatable(className) && !CLASS_DEFS[className].system && !CLASS_DEFS[className].root) {
    throw new Error(`${className} cannot be created directly`);
  }
  return new Instance(className, properties, { world });
}

export function findInstanceById(root, id) {
  return root.findFirstDescendant((instance) => instance.id === id) ?? (root.id === id ? root : null);
}

export default Instance;
