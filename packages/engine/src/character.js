/**
 * Character + Humanoid controller.
 *
 * A character is a Model containing an invisible collision volume (`rootPart`) plus a visual rig
 * (head, torso, arms, legs). Motion is applied to the collision volume through the physics world,
 * so the same code runs authoritatively on the server and predictively on the client.
 *
 * Original API (not a copy of any other platform):
 *   character.health          number
 *   character.maxHealth       number
 *   character.walkSpeed       number
 *   character.jumpPower       number
 *   character:move(direction) direction is a Vector3 in local space
 *   character:jump()
 *   character.state           idle | walking | running | jumping | falling | climbing | sitting | dead
 */
import { Instance } from './instance.js';
import { Vector3 } from './math.js';
import { ENGINE_LIMITS } from '@kinetiq/shared';

export const HUMANOID_STATES = [
  'idle',
  'walking',
  'running',
  'jumping',
  'falling',
  'climbing',
  'swimming',
  'sitting',
  'stunned',
  'dead',
];

export const DEFAULT_RIG = {
  head: { size: { x: 1.6, y: 1.6, z: 1.6 }, offset: { x: 0, y: 1.55, z: 0 }, color: '#f2c9a0' },
  torso: { size: { x: 2, y: 2, z: 1 }, offset: { x: 0, y: -0.4, z: 0 }, color: '#3d5afe' },
  leftArm: { size: { x: 1, y: 2, z: 1 }, offset: { x: -1.5, y: -0.4, z: 0 }, color: '#f2c9a0' },
  rightArm: { size: { x: 1, y: 2, z: 1 }, offset: { x: 1.5, y: -0.4, z: 0 }, color: '#f2c9a0' },
  leftLeg: { size: { x: 1, y: 2, z: 1 }, offset: { x: -0.55, y: -2.4, z: 0 }, color: '#28304a' },
  rightLeg: { size: { x: 1, y: 2, z: 1 }, offset: { x: 0.55, y: -2.4, z: 0 }, color: '#28304a' },
};

export const DEFAULT_AVATAR = {
  headColor: '#f2c9a0',
  torsoColor: '#3d5afe',
  armColor: '#f2c9a0',
  legColor: '#28304a',
  shirtColor: null,
  pantsColor: null,
  scale: 1,
  items: {}, // category -> item id (visual attachments resolved client-side)
};

export class Character {
  constructor(world, {
    playerId,
    displayName = 'Player',
    spawn = null,
    avatar = {},
    appearance = {},
    isLocal = false,
  }) {
    this.world = world;
    this.playerId = playerId;
    this.displayName = displayName;
    this.isLocal = isLocal;
    this.avatar = { ...DEFAULT_AVATAR, ...avatar };
    this.appearance = appearance;
    this.health = 100;
    this.maxHealth = 100;
    this.walkSpeed = ENGINE_LIMITS.defaultWalkSpeed;
    this.runSpeed = ENGINE_LIMITS.defaultRunSpeed;
    this.jumpPower = ENGINE_LIMITS.defaultJumpPower;
    this.state = 'idle';
    this.facing = 0; // yaw radians
    this.moving = false;
    this.running = false;
    this.sitting = null;
    this.climbing = null;
    this.jumpCooldown = 0;
    this.lastGroundAt = 0;
    this.spawnedAt = Date.now();
    this.id = `char_${playerId}`;

    const rig = this._buildRig();
    this.model = rig.model;
    this.parts = rig.parts;
    this.rootPart = rig.rootPart;
    this.setSpawn(spawn ?? { position: new Vector3(0, 6, 0), rotation: new Vector3(0, 0, 0) });
    world.physics.register(this.rootPart);
    this.body = world.physics.bodies.get(this.rootPart.id);
    if (this.body) this.body.mass = 5;
  }

  _buildRig() {
    const model = new Instance('Model', { name: `${this.displayName}` }, { world: this.world });
    model.setParent(this.world.root);

    const rootPart = new Instance(
      'Part',
      {
        name: 'RootPart',
        size: { x: 2, y: 5, z: 1 },
        color: '#ffffff',
        transparency: 1,
        canCollide: true,
        anchored: false,
        mass: 5,
        friction: 0.1,
        material: 'smoothplastic',
      },
      { world: this.world },
    );
    rootPart.setParent(model);

    const parts = { rootPart, nameTag: null };
    for (const [key, spec] of Object.entries(DEFAULT_RIG)) {
      const part = new Instance(
        'Part',
        {
          name: key[0].toUpperCase() + key.slice(1),
          size: spec.size,
          color: this._rigColor(key, spec.color),
          canCollide: false,
          anchored: true,
          castShadow: true,
          material: 'plastic',
        },
        { world: this.world },
      );
      part.setParent(model);
      parts[key] = part;
    }
    worldRegisterTree(this.world, model);
    return { model, parts, rootPart };
  }

  _rigColor(key, fallback) {
    const map = {
      head: this.avatar.headColor,
      torso: this.avatar.shirtColor ?? this.avatar.torsoColor,
      leftArm: this.avatar.shirtColor ?? this.avatar.armColor,
      rightArm: this.avatar.shirtColor ?? this.avatar.armColor,
      leftLeg: this.avatar.pantsColor ?? this.avatar.legColor,
      rightLeg: this.avatar.pantsColor ?? this.avatar.legColor,
    };
    return map[key] ?? fallback;
  }

  /** Re-applies avatar colours (after an inventory change). */
  applyAvatar(avatar) {
    this.avatar = { ...this.avatar, ...avatar };
    for (const [key, spec] of Object.entries(DEFAULT_RIG)) {
      const part = this.parts[key];
      if (part) part.setProperty('color', this._rigColor(key, spec.color));
    }
  }

  setSpawn(spawn) {
    const position = spawn.position ?? new Vector3(0, 6, 0);
    const rotation = spawn.rotation ?? new Vector3(0, 0, 0);
    this.rootPart.setProperty('position', { x: position.x, y: position.y + 2.5, z: position.z });
    this.facing = (rotation.y * Math.PI) / 180;
    if (this.body) this.body.refresh();
    this.world.physics.refreshInstance(this.rootPart);
    this._syncVisuals();
  }

  get position() {
    return this.rootPart.getPosition();
  }

  get velocity() {
    return this.body?.velocity ?? { x: 0, y: 0, z: 0 };
  }

  get grounded() {
    return Boolean(this.body?.grounded);
  }

  /** Apply movement input for one tick. `direction` is in character-local space (-1..1). */
  move(direction, { run = false, deltaSeconds = 1 / 60, facing = null } = {}) {
    if (this.state === 'dead' || this.state === 'sitting') return;
    const body = this.body;
    if (!body) return;
    const speed = run ? this.runSpeed : this.walkSpeed;
    // The controlling authority (server, or the local player when client-authoritative for
    // presentation) may pin the facing angle; otherwise it follows the movement direction.
    const useFacing = facing === null || facing === undefined ? null : Number(facing);
    if (useFacing !== null && Number.isFinite(useFacing)) this.facing = useFacing;
    // Convert local direction to world space using the facing angle.
    const sin = Math.sin(this.facing);
    const cos = Math.cos(this.facing);
    const forward = { x: -sin, z: -cos };
    const right = { x: cos, z: -sin };
    let worldX = forward.x * direction.z + right.x * direction.x;
    let worldZ = forward.z * direction.z + right.z * direction.x;
    const magnitude = Math.hypot(worldX, worldZ);
    if (magnitude > 1) {
      worldX /= magnitude;
      worldZ /= magnitude;
    }
    const targetX = worldX * speed;
    const targetZ = worldZ * speed;
    const accel = this.grounded ? 14 : 4;
    body.velocity.x += (targetX - body.velocity.x) * Math.min(1, accel * deltaSeconds);
    body.velocity.z += (targetZ - body.velocity.z) * Math.min(1, accel * deltaSeconds);
    body.sleeping = false;

    const horizontal = Math.hypot(body.velocity.x, body.velocity.z);
    this.moving = magnitude > 0.05;
    this.running = run && this.moving;
    if (this.moving && useFacing === null) {
      this.facing = Math.atan2(-worldX, -worldZ);
    }
    if (this.state !== 'jumping' && this.state !== 'falling' && this.state !== 'climbing') {
      this.state = this.moving ? (this.running ? 'running' : 'walking') : 'idle';
      void horizontal;
    }
  }

  jump() {
    if (this.state === 'dead' || this.jumpCooldown > 0) return false;
    if (!this.grounded) return false;
    this.body.velocity.y = this.jumpPower * 0.7;
    this.body.sleeping = false;
    this.state = 'jumping';
    this.jumpCooldown = 0.15;
    this.world.events.fire('humanoidStateChanged', { character: this, state: 'jumping' });
    return true;
  }

  sit(seat) {
    this.sitting = seat;
    this.state = 'sitting';
    if (seat) {
      const seatPosition = seat.getPosition();
      this.rootPart.setProperty('position', { x: seatPosition.x, y: seatPosition.y + 1.6, z: seatPosition.z });
      this.body.velocity = { x: 0, y: 0, z: 0 };
      this.body.refresh();
      seat.setProperty('occupiedBy', this.playerId);
    }
    this.world.events.fire('humanoidStateChanged', { character: this, state: 'sitting' });
  }

  stand() {
    if (this.sitting) this.sitting.setProperty('occupiedBy', '');
    this.sitting = null;
    this.state = 'idle';
  }

  takeDamage(amount, { sourceId = null } = {}) {
    const damage = Math.max(0, Number(amount) || 0);
    this.health = Math.max(0, this.health - damage);
    this.world.events.fire('characterDamaged', { character: this, amount: damage, sourceId });
    if (this.health <= 0) this.die({ sourceId });
    return this.health;
  }

  heal(amount) {
    this.health = Math.min(this.maxHealth, this.health + Math.max(0, Number(amount) || 0));
    return this.health;
  }

  die({ sourceId = null } = {}) {
    if (this.state === 'dead') return;
    this.state = 'dead';
    this.world.events.fire('characterDied', { character: this, sourceId });
  }

  respawn(spawn = null) {
    this.health = this.maxHealth;
    this.state = 'idle';
    this.body.velocity = { x: 0, y: 0, z: 0 };
    if (spawn) this.setSpawn(spawn);
    this.world.events.fire('characterSpawned', { character: this, respawn: true });
  }

  /** Called every tick by the simulation. */
  update(deltaSeconds) {
    if (this.jumpCooldown > 0) this.jumpCooldown = Math.max(0, this.jumpCooldown - deltaSeconds);
    const body = this.body;
    if (!body) return;
    if (this.state !== 'dead' && this.state !== 'sitting') {
      if (this.grounded) {
        this.lastGroundAt = this.world.time;
        if (body.velocity.y < -0.5 && this.state === 'falling') this.state = 'idle';
        if (body.velocity.y >= -0.5 && (this.state === 'falling' || this.state === 'jumping') && Math.abs(body.velocity.y) < 1) {
          this.state = this.moving ? 'walking' : 'idle';
        }
      } else if (body.velocity.y < -0.5 && this.state !== 'jumping') {
        this.state = 'falling';
      }
      // Fall damage after a long drop.
      if (this.grounded && this.fallStartHeight !== null && this.fallStartHeight !== undefined) {
        const drop = this.fallStartHeight - this.position.y;
        if (drop > 40) this.takeDamage(Math.floor((drop - 40) * 1.5));
        this.fallStartHeight = null;
      }
      if (!this.grounded && this.fallStartHeight === null) this.fallStartHeight = this.position.y;
      // Out-of-world safety net.
      if (this.position.y < -900) {
        this.world.events.fire('characterFellOutOfWorld', { character: this });
        this.respawn();
      }
    }
    this._syncVisuals();
  }

  _syncVisuals() {
    const root = this.rootPart.getProperty('position');
    const scale = this.avatar.scale ?? 1;
    for (const [key, spec] of Object.entries(DEFAULT_RIG)) {
      const part = this.parts[key];
      if (!part) continue;
      const offset = spec.offset;
      const rotated = rotateY(offset, this.facing);
      part.setProperty('position', {
        x: root.x + rotated.x * scale,
        y: root.y + rotated.y * scale,
        z: root.z + rotated.z * scale,
      });
      part.setProperty('rotation', { x: 0, y: (this.facing * 180) / Math.PI, z: 0 });
      part.setProperty('size', { x: spec.size.x * scale, y: spec.size.y * scale, z: spec.size.z * scale });
    }
  }

  /** Compact state for replication (sent ~20x/second). */
  snapshot() {
    const position = this.position;
    const velocity = this.velocity;
    return {
      id: this.playerId,
      position: { x: round(position.x), y: round(position.y), z: round(position.z) },
      facing: round(this.facing),
      velocity: { x: round(velocity.x ?? 0), y: round(velocity.y ?? 0), z: round(velocity.z ?? 0) },
      state: this.state,
      health: this.health,
      moving: this.moving,
      running: this.running,
    };
  }

  destroy() {
    this.world.events.fire('characterRemoved', { character: this });
    this.model.destroy();
  }

  // Script-friendly aliases
  get Health() {
    return this.health;
  }
  set Health(value) {
    this.health = Math.max(0, Number(value) || 0);
  }
  get WalkSpeed() {
    return this.walkSpeed;
  }
  set WalkSpeed(value) {
    this.walkSpeed = Math.max(0, Math.min(500, Number(value) || 0));
  }
  get JumpPower() {
    return this.jumpPower;
  }
  set JumpPower(value) {
    this.jumpPower = Math.max(0, Math.min(500, Number(value) || 0));
  }
  Move(direction) {
    return this.move(direction);
  }
  Jump() {
    return this.jump();
  }
  TakeDamage(amount) {
    return this.takeDamage(amount);
  }
  GetState() {
    return this.state;
  }
}

function rotateY(offset, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: offset.x * cos + offset.z * sin,
    y: offset.y,
    z: -offset.x * sin + offset.z * cos,
  };
}

function round(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function worldRegisterTree(world, instance) {
  for (const descendant of instance.getDescendants()) {
    if (!world.instances.has(descendant.id)) world.register(descendant);
  }
  if (!world.instances.has(instance.id)) world.register(instance);
}

export default Character;
