/**
 * Math types exposed to game scripts: Vector3, Vector2, Color3, CFrame, UDim2, Ray, Region3.
 * Written from scratch for Kinetiq — these are value objects, immutable unless noted.
 */

export class Vector3 {
  constructor(x = 0, y = 0, z = 0) {
    this.x = Number(x) || 0;
    this.y = Number(y) || 0;
    this.z = Number(z) || 0;
  }
  static new(x = 0, y = 0, z = 0) {
    return new Vector3(x, y, z);
  }
  static fromArray(arr = [0, 0, 0]) {
    return new Vector3(arr[0], arr[1], arr[2]);
  }
  static zero() {
    return new Vector3(0, 0, 0);
  }
  static one() {
    return new Vector3(1, 1, 1);
  }
  add(v) {
    return new Vector3(this.x + (v?.x ?? 0), this.y + (v?.y ?? 0), this.z + (v?.z ?? 0));
  }
  sub(v) {
    return new Vector3(this.x - (v?.x ?? 0), this.y - (v?.y ?? 0), this.z - (v?.z ?? 0));
  }
  mul(s) {
    const k = typeof s === 'number' ? s : 1;
    return new Vector3(this.x * k, this.y * k, this.z * k);
  }
  div(s) {
    const k = typeof s === 'number' && s !== 0 ? s : 1;
    return new Vector3(this.x / k, this.y / k, this.z / k);
  }
  dot(v) {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }
  cross(v) {
    return new Vector3(this.y * v.z - this.z * v.y, this.z * v.x - this.x * v.z, this.x * v.y - this.y * v.x);
  }
  get magnitude() {
    return Math.hypot(this.x, this.y, this.z);
  }
  get unit() {
    const m = this.magnitude;
    return m === 0 ? new Vector3(0, 0, 0) : this.div(m);
  }
  lerp(v, t) {
    return new Vector3(
      this.x + (v.x - this.x) * t,
      this.y + (v.y - this.y) * t,
      this.z + (v.z - this.z) * t,
    );
  }
  distanceTo(v) {
    return this.sub(v).magnitude;
  }
  floor() {
    return new Vector3(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z));
  }
  toArray() {
    return [round(this.x), round(this.y), round(this.z)];
  }
  toString() {
    return `${fmt(this.x)}, ${fmt(this.y)}, ${fmt(this.z)}`;
  }
  clone() {
    return new Vector3(this.x, this.y, this.z);
  }
  applyQuaternion(q) {
    // Quaternion [x, y, z, w]
    const [qx, qy, qz, qw] = q;
    const ix = qw * this.x + qy * this.z - qz * this.y;
    const iy = qw * this.y + qz * this.x - qx * this.z;
    const iz = qw * this.z + qx * this.y - qy * this.x;
    const iw = -qx * this.x - qy * this.y - qz * this.z;
    return new Vector3(
      ix * qw + iw * -qx + iy * -qz - iz * -qy,
      iy * qw + iw * -qy + iz * -qx - ix * -qz,
      iz * qw + iw * -qz + ix * -qy - iy * -qx,
    );
  }
}

export class Vector2 {
  constructor(x = 0, y = 0) {
    this.x = Number(x) || 0;
    this.y = Number(y) || 0;
  }
  add(v) {
    return new Vector2(this.x + v.x, this.y + v.y);
  }
  sub(v) {
    return new Vector2(this.x - v.x, this.y - v.y);
  }
  mul(s) {
    return new Vector2(this.x * s, this.y * s);
  }
  get magnitude() {
    return Math.hypot(this.x, this.y);
  }
  toArray() {
    return [round(this.x), round(this.y)];
  }
}

export class Color3 {
  constructor(r = 0, g = 0, b = 0) {
    this.r = clamp01(r);
    this.g = clamp01(g);
    this.b = clamp01(b);
  }
  static new(r = 0, g = 0, b = 0) {
    return new Color3(r, g, b);
  }
  static fromRGB(r, g, b) {
    return new Color3(r / 255, g / 255, b / 255);
  }
  /** Accepts '#rrggbb', 'rgb(r,g,b)', or a named palette entry. */
  static fromHex(hex) {
    const value = String(hex).trim().replace(/^#/, '');
    if (/^[0-9a-f]{6}$/i.test(value)) {
      return new Color3(
        parseInt(value.slice(0, 2), 16) / 255,
        parseInt(value.slice(2, 4), 16) / 255,
        parseInt(value.slice(4, 6), 16) / 255,
      );
    }
    if (/^[0-9a-f]{3}$/i.test(value)) {
      return new Color3(
        parseInt(value[0] + value[0], 16) / 255,
        parseInt(value[1] + value[1], 16) / 255,
        parseInt(value[2] + value[2], 16) / 255,
      );
    }
    const rgb = String(hex).match(/rgba?\(([^)]+)\)/i);
    if (rgb) {
      const [r, g, b] = rgb[1].split(',').map((v) => Number(v.trim()));
      return Color3.fromRGB(r, g, b);
    }
    return PALETTE[String(hex).toLowerCase()]?.clone() ?? new Color3(0.64, 0.64, 0.64);
  }
  static fromColor3(color) {
    return new Color3(color.r, color.g, color.b);
  }
  toHex() {
    return `#${[this.r, this.g, this.b].map((c) => Math.round(clamp01(c) * 255).toString(16).padStart(2, '0')).join('')}`;
  }
  lerp(color, t) {
    return new Color3(
      this.r + (color.r - this.r) * t,
      this.g + (color.g - this.g) * t,
      this.b + (color.b - this.b) * t,
    );
  }
  clone() {
    return new Color3(this.r, this.g, this.b);
  }
}

function clamp01(value) {
  const num = Number(value) || 0;
  return Math.min(1, Math.max(0, num));
}

function round(value) {
  return Math.round(Number(value) * 1e4) / 1e4;
}

function fmt(value) {
  return (Math.round(Number(value) * 100) / 100).toString();
}

/**
 * CFrame: position + rotation (Euler degrees in Kinetiq UI, stored as radians internally).
 * Kept deliberately simple — the renderer converts to a matrix for three.js.
 */
export class CFrame {
  constructor(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
    this.position = new Vector3(x, y, z);
    this.rotation = new Vector3(deg2rad(rx), deg2rad(ry), deg2rad(rz));
  }
  static new(x = 0, y = 0, z = 0) {
    return new CFrame(x, y, z);
  }
  static fromEuler(position, degrees) {
    return new CFrame(position.x, position.y, position.z, degrees.x ?? 0, degrees.y ?? 0, degrees.z ?? 0);
  }
  static identity() {
    return new CFrame(0, 0, 0);
  }
  get x() {
    return this.position.x;
  }
  get y() {
    return this.position.y;
  }
  get z() {
    return this.position.z;
  }
  mul(other) {
    return new CFrame(this.x + other.x, this.y + other.y, this.z + other.z, ...this.eulerDegrees().add(other.eulerDegrees()).toArray());
  }
  eulerDegrees() {
    return new Vector3(rad2deg(this.rotation.x), rad2deg(this.rotation.y), rad2deg(this.rotation.z));
  }
  /** Unit forward vector (-Z convention, matching three.js default camera). */
  get lookVector() {
    const { x: rx, y: ry, z: rz } = this.rotation;
    const cosY = Math.cos(ry);
    return new Vector3(-Math.sin(ry) * cosY, Math.sin(rx), -Math.cos(ry) * cosY).unit;
  }
  toArray() {
    return [...this.position.toArray(), ...this.eulerDegrees().toArray()];
  }
}

export class Ray {
  constructor(origin, direction) {
    this.origin = origin instanceof Vector3 ? origin : Vector3.fromArray(origin);
    this.direction = (direction instanceof Vector3 ? direction : Vector3.fromArray(direction)).unit;
  }
  static new(origin, direction) {
    return new Ray(origin, direction);
  }
  at(distance) {
    return this.origin.add(this.direction.mul(distance));
  }
}

export class UDim2 {
  constructor(xScale = 0, xOffset = 0, yScale = 0, yOffset = 0) {
    this.xScale = xScale;
    this.xOffset = xOffset;
    this.yScale = yScale;
    this.yOffset = yOffset;
  }
  static new(xScale = 0, xOffset = 0, yScale = 0, yOffset = 0) {
    return new UDim2(xScale, xOffset, yScale, yOffset);
  }
  static fromScale(x = 0, y = 0) {
    return new UDim2(x, 0, y, 0);
  }
  static fromOffset(x = 0, y = 0) {
    return new UDim2(0, x, 0, y);
  }
  toArray() {
    return [this.xScale, this.xOffset, this.yScale, this.yOffset];
  }
  static fromArray(arr = [0, 0, 0, 0]) {
    return new UDim2(arr[0] ?? 0, arr[1] ?? 0, arr[2] ?? 0, arr[3] ?? 0);
  }
  resolve(containerWidth, containerHeight) {
    return {
      width: this.xScale * containerWidth + this.xOffset,
      height: this.yScale * containerHeight + this.yOffset,
    };
  }
}

export class Region3 {
  constructor(min, max) {
    this.min = min instanceof Vector3 ? min : Vector3.fromArray(min);
    this.max = max instanceof Vector3 ? max : Vector3.fromArray(max);
  }
  static fromBounds(center, size) {
    const half = size.mul(0.5);
    return new Region3(center.sub(half), center.add(half));
  }
  contains(point) {
    return (
      point.x >= this.min.x &&
      point.x <= this.max.x &&
      point.y >= this.min.y &&
      point.y <= this.max.y &&
      point.z >= this.min.z &&
      point.z <= this.max.z
    );
  }
  intersects(other) {
    return !(
      other.min.x > this.max.x ||
      other.max.x < this.min.x ||
      other.min.y > this.max.y ||
      other.max.y < this.min.y ||
      other.min.z > this.max.z ||
      other.max.z < this.min.z
    );
  }
}

export const deg2rad = (deg) => (Number(deg) || 0) * (Math.PI / 180);
export const rad2deg = (rad) => (Number(rad) || 0) * (180 / Math.PI);

export const PALETTE = {
  white: new Color3(1, 1, 1),
  black: new Color3(0.05, 0.05, 0.05),
  grey: new Color3(0.64, 0.64, 0.64),
  gray: new Color3(0.64, 0.64, 0.64),
  red: new Color3(0.85, 0.2, 0.2),
  orange: new Color3(0.95, 0.55, 0.15),
  yellow: new Color3(0.95, 0.85, 0.2),
  green: new Color3(0.25, 0.75, 0.35),
  teal: new Color3(0.1, 0.8, 0.75),
  blue: new Color3(0.24, 0.35, 1),
  purple: new Color3(0.55, 0.3, 0.85),
  pink: new Color3(0.95, 0.45, 0.65),
  brown: new Color3(0.45, 0.32, 0.2),
  skin: new Color3(0.94, 0.76, 0.62),
};

/** Axis-aligned bounding box helper used by physics and rendering. */
export const AABB = {
  fromCenterSize(center, size) {
    const half = size.mul(0.5);
    return { min: center.sub(half), max: center.add(half) };
  },
  overlap(a, b) {
    return !(
      b.min.x > a.max.x ||
      b.max.x < a.min.x ||
      b.min.y > a.max.y ||
      b.max.y < a.min.y ||
      b.min.z > a.max.z ||
      b.max.z < a.min.z
    );
  },
  center(box) {
    return box.min.add(box.max).mul(0.5);
  },
  size(box) {
    return box.max.sub(box.min);
  },
  contains(box, point) {
    return (
      point.x >= box.min.x && point.x <= box.max.x &&
      point.y >= box.min.y && point.y <= box.max.y &&
      point.z >= box.min.z && point.z <= box.max.z
    );
  },
};

export default { Vector3, Vector2, Color3, CFrame, Ray, UDim2, Region3, AABB };
