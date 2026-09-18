/**
 * The scripting API surface exposed to creator scripts.
 *
 * Server scripts receive authoritative services (World, Players, Data, Economy, Badges, Remote).
 * Client scripts receive presentation services (UI, Input, Camera, Sound) plus a read-only view
 * of the replicated world and the Remote client endpoints.
 *
 * Nothing here exposes Node APIs, the filesystem, the network stack, database handles, or
 * secrets. Everything a script can do is mediated by these objects.
 */
import { Vector3, Vector2, Color3, CFrame, UDim2, Region3, Ray } from '@kinetiq/engine';

/**
 * IMPORTANT: a JS function called from Lua must return `undefined` (never `null`) to express a
 * Lua nil — the embedding layer cannot push a JS null. Every optional return in this file uses
 * `undefined` for that reason.
 */

/**
 * Wraps an engine Instance with a validating, script-friendly facade.
 * Internal references are non-enumerable so they never leak into the Lua view of the object.
 */
export class ScriptInstance {
  constructor(instance, host) {
    Object.defineProperty(this, '__instance', { value: instance, enumerable: false, writable: false });
    Object.defineProperty(this, '__host', { value: host, enumerable: false, writable: false });
  }

  get name_() {
    return this.__instance.getName();
  }

  set(name, value) {
    return this.__host.setInstanceProperty(this.__instance, name, value);
  }

  get(name) {
    return this.__host.getInstanceProperty(this.__instance, name);
  }

  setProperty(name, value) {
    return this.set(name, value);
  }

  getProperty(name) {
    return this.get(name);
  }

  destroy() {
    this.__instance.destroy();
  }

  isA(className) {
    return this.__instance.isA(className);
  }

  children() {
    return this.__instance.children.map((child) => this.__host.wrap(child));
  }

  getChildren() {
    return this.children();
  }

  findChild(name, recursive = false) {
    const found = this.__instance.findFirstChild(name, Boolean(recursive));
    return found ? this.__host.wrap(found) : undefined;
  }

  findFirstChild(name) {
    return this.findChild(name);
  }

  descendants() {
    return this.__instance.getDescendants().map((child) => this.__host.wrap(child));
  }

  /** part:on("touched", function(other) ... end) */
  on(event, fn) {
    return this.__host.connectInstanceEvent(this.__instance, event, fn);
  }

  get id() {
    return this.__instance.id;
  }

  get className() {
    return this.__instance.className;
  }

  // Direct property accessors for the most common properties (reads are cheap; writes validate).
  get name() {
    return this.__instance.getName();
  }
  set name(value) {
    this.__instance.setProperty('name', value);
  }
  get position() {
    return this.__instance.getPosition();
  }
  set position(value) {
    this.__instance.setProperty('position', value);
  }
  get size() {
    return this.__instance.getSize();
  }
  set size(value) {
    this.__instance.setProperty('size', value);
  }
  get color() {
    return this.__instance.getColor().toHex();
  }
  set color(value) {
    this.__instance.setProperty('color', value);
  }
  get transparency() {
    return this.__instance.getProperty('transparency');
  }
  set transparency(value) {
    this.__instance.setProperty('transparency', value);
  }
  get anchored() {
    return this.__instance.getProperty('anchored');
  }
  set anchored(value) {
    this.__instance.setProperty('anchored', value);
  }
  get canCollide() {
    return this.__instance.getProperty('canCollide');
  }
  set canCollide(value) {
    this.__instance.setProperty('canCollide', value);
  }
  get parent() {
    return this.__instance.parent ? this.__host.wrap(this.__instance.parent) : undefined;
  }
  set parent(handle) {
    const target = handle?.__instance ?? handle;
    if (!target) return;
    this.__instance.setParent(target);
    if (!this.__instance.world.instances.has(this.__instance.id)) {
      this.__instance.world.registerTree(this.__instance);
    }
  }
  toString() {
    return `${this.__instance.className}(${this.__instance.getName()})`;
  }
}

/** A player as seen by scripts. */
export class ScriptPlayer {
  constructor(player, host) {
    Object.defineProperty(this, '__player', { value: player, enumerable: false, writable: false });
    Object.defineProperty(this, '__host', { value: host, enumerable: false, writable: false });
  }
  get id() {
    return this.__player.id;
  }
  get name() {
    return this.__player.username;
  }
  get displayName() {
    return this.__player.displayName;
  }
  get character() {
    const character = this.__host.characterFor(this.__player.id);
    return character ? this.__host.wrapCharacter(character) : undefined;
  }
  get userId() {
    return this.__player.id;
  }
  isFriendOf(otherId) {
    return this.__host.areFriends(this.__player.id, otherId);
  }
  sendMessage(text) {
    return this.__host.sendGameMessage(this.__player.id, text);
  }
  kick(reason = 'Kicked by game logic') {
    return this.__host.kickPlayer(this.__player.id, reason);
  }
  toString() {
    return `Player(${this.__player.username})`;
  }
}

/** A character/humanoid as seen by scripts. */
export class ScriptCharacter {
  constructor(character, host) {
    Object.defineProperty(this, '__character', { value: character, enumerable: false, writable: false });
    Object.defineProperty(this, '__host', { value: host, enumerable: false, writable: false });
  }
  get health() {
    return this.__character.health;
  }
  set health(value) {
    this.__character.health = Math.max(0, Number(value) || 0);
    if (this.__character.health === 0) this.__character.die();
  }
  get maxHealth() {
    return this.__character.maxHealth;
  }
  set maxHealth(value) {
    this.__character.maxHealth = Math.max(1, Number(value) || 1);
  }
  get walkSpeed() {
    return this.__character.walkSpeed;
  }
  set walkSpeed(value) {
    this.__character.walkSpeed = value;
  }
  get jumpPower() {
    return this.__character.jumpPower;
  }
  set jumpPower(value) {
    this.__character.jumpPower = value;
  }
  get state() {
    return this.__character.state;
  }
  get position() {
    return this.__character.position;
  }
  get playerId() {
    return this.__character.playerId;
  }
  get model() {
    return this.__host.wrap(this.__character.model);
  }
  move(direction, run = false) {
    return this.__character.move(direction, { run });
  }
  jump() {
    return this.__character.jump();
  }
  takeDamage(amount) {
    return this.__character.takeDamage(amount);
  }
  heal(amount) {
    return this.__character.heal(amount);
  }
  respawn() {
    return this.__character.respawn();
  }
  sit(seat) {
    const target = seat?.__instance ?? seat;
    return this.__character.sit(target);
  }
  toString() {
    return `Character(${this.__character.displayName})`;
  }
}

/** Result of World:raycast — a stable object shape rather than an ad-hoc literal. */
export class ScriptRaycastResult {
  constructor(instance, hit) {
    Object.defineProperty(this, '_instance', { value: instance, enumerable: true });
    Object.defineProperty(this, '_hit', { value: hit, enumerable: false });
  }
  get instance() {
    return this._instance;
  }
  get position() {
    return this._hit.position;
  }
  get normal() {
    return this._hit.normal;
  }
  get distance() {
    return this._hit.distance;
  }
  toString() {
    return `RaycastResult(distance=${this._hit.distance.toFixed(2)})`;
  }
}

/**
 * Builds the runtime table (the object exposed to Lua as the script environment).
 *
 * `context` is provided by whichever host is running the scripts:
 *   { mode, world, physics, characters, players, host callbacks... }
 */
export function buildRuntimeApi(context) {
  const { mode = 'server' } = context;
  const isServer = mode === 'server';

  const api = {
    Vector3,
    Vector2,
    Color: Color3,
    Color3,
    CFrame,
    UDim2,
    Region3,
    Ray,
    Math: {
      floor: Math.floor,
      ceil: Math.ceil,
      abs: Math.abs,
      min: Math.min,
      max: Math.max,
      sqrt: Math.sqrt,
      sin: Math.sin,
      cos: Math.cos,
      atan2: Math.atan2,
      random: (...args) => {
        if (!args.length) return Math.random();
        if (args.length === 1) return Math.floor(Math.random() * Number(args[0])) + 1;
        const [low, high] = args.map(Number);
        return low + Math.floor(Math.random() * (high - low + 1));
      },
      clamp: (value, min, max) => Math.min(max, Math.max(min, value)),
      lerp: (a, b, t) => a + (b - a) * t,
      deg: (rad) => (rad * 180) / Math.PI,
      rad: (deg) => (deg * Math.PI) / 180,
    },
    mode,
    isServer,
  };

  // ---------------------------------------------------------------- World service
  api.World = {
    create(className, props) {
      return context.createInstance(className, props ?? {});
    },
    destroy(handle) {
      const target = handle?.__instance ?? handle;
      if (!target) throw new Error('World:destroy expects an instance');
      target.destroy();
    },
    find(id) {
      const instance = context.world.get(String(id));
      return instance ? context.wrap(instance) : undefined;
    },
    findByName(name) {
      const instance =
        context.world.root.findFirstChild(String(name), true) ?? context.world.find((node) => node.getName() === String(name));
      return instance ? context.wrap(instance) : undefined;
    },
    getParts(filter) {
      return context.world
        .findByClass('Part')
        .filter((part) => (typeof filter === 'function' ? filter(context.wrap(part)) : true))
        .map((part) => context.wrap(part));
    },
    getPlayers() {
      return context.getPlayers().map((player) => context.wrapPlayer(player));
    },
    getSpawnPoint() {
      const spawn = context.world.pickSpawn();
      return { position: spawn.position, rotation: spawn.rotation };
    },
    raycast(origin, direction, options = {}) {
      const hit = context.physics.raycast(origin, direction, {
        maxDistance: Number(options.maxDistance ?? options.distance ?? 500),
        ignore: (options.ignore ?? []).map((handle) => (handle?.__instance ?? handle).id),
        includeNonColliding: Boolean(options.includeNonColliding),
      });
      if (!hit) return undefined;
      return new ScriptRaycastResult(context.wrap(hit.instance), hit);
    },
    getPartsInRegion(center, size) {
      return context.physics.queryBox(center, size, {}).map((instance) => context.wrap(instance));
    },
    applyRadialImpulse(center, radius, strength) {
      return context.physics.applyRadialImpulse(center, Number(radius), Number(strength));
    },
    getTime() {
      return context.world.time;
    },
    get stats() {
      return context.world.stats;
    },
    get gravity() {
      return context.world.root.getProperty('gravity');
    },
    setGravity(value) {
      context.world.root.setProperty('gravity', value);
      context.physics.gravity = value;
    },
  };

  // ---------------------------------------------------------------- Players service
  api.Players = {
    getPlayers() {
      return api.World.getPlayers();
    },
    getById(playerId) {
      const player = context.getPlayers().find((entry) => entry.id === String(playerId) || entry.username === String(playerId));
      return player ? context.wrapPlayer(player) : undefined;
    },
    get localPlayer() {
      return context.localPlayer ? context.wrapPlayer(context.localPlayer) : undefined;
    },
    get count() {
      return context.getPlayers().length;
    },
    get playerJoined() {
      return context.signalFor('playerJoined');
    },
    get playerLeft() {
      return context.signalFor('playerLeft');
    },
  };

  // ---------------------------------------------------------------- Remote events
  api.Remote = {
    get(name) {
      return context.getRemote(String(name));
    },
    create(name) {
      return context.createRemote(String(name));
    },
  };

  // ---------------------------------------------------------------- Worlds / data (server)
  if (isServer) {
    api.Data = {
      open(storeName) {
        return context.openDataStore(String(storeName ?? 'default'));
      },
      get(playerId, key) {
        const store = context.openDataStore('default');
        const values = store.get(String(playerId));
        return key === undefined ? values : values[String(key)];
      },
      set(playerId, key, value) {
        const store = context.openDataStore('default');
        if (typeof key === 'object' && key !== null) {
          return store.set(String(playerId), key);
        }
        const current = store.get(String(playerId));
        current[String(key)] = value;
        return store.set(String(playerId), current);
      },
      increment(playerId, key, amount = 1) {
        const store = context.openDataStore('default');
        const values = store.get(String(playerId));
        values[String(key)] = (Number(values[String(key)]) || 0) + Number(amount);
        store.set(String(playerId), values);
        return values[String(key)];
      },
    };

    api.Economy = {
      getBalance(playerId) {
        return context.economy.getBalance(String(playerId));
      },
      grant(playerId, amount, reason) {
        return context.economy.grant(String(playerId), Number(amount), String(reason ?? '').slice(0, 120), context.gameId);
      },
      take(playerId, amount, reason) {
        return context.economy.take(String(playerId), Number(amount), String(reason ?? '').slice(0, 120), context.gameId);
      },
      ownsProduct(playerId, productId) {
        return context.economy.ownsProduct(String(playerId), String(productId));
      },
      getProducts() {
        return context.economy.listProducts(context.gameId);
      },
      getPasses() {
        return context.economy.listProducts(context.gameId, 'pass');
      },
      awardBadge(playerId, badgeId) {
        return context.badges.award(String(playerId), String(badgeId));
      },
      hasBadge(playerId, badgeId) {
        return context.badges.has(String(playerId), String(badgeId));
      },
      createBadge(name, description, iconAssetId) {
        return context.badges.create(String(name), String(description ?? ''), iconAssetId ?? null);
      },
    };

    api.Players.kick = (playerId, reason) => context.kickPlayer(String(playerId), String(reason ?? ''));
    api.Players.getLeaderboard = (storeName, field, limit) =>
      context.leaderboard(String(storeName ?? 'default'), String(field), Number(limit ?? 10));
  }

  // ---------------------------------------------------------------- Client-only services
  if (!isServer) {
    api.UI = {
      create(className, props) {
        return context.createUI(className, props ?? {});
      },
      get(name) {
        const instance = context.uiRoot?.findFirstChild(String(name), true);
        return instance ? context.wrap(instance) : undefined;
      },
      setVisible(handle, visible) {
        const target = handle?.__instance ?? handle;
        target.setProperty('visible', Boolean(visible));
      },
      setText(handle, text) {
        const target = handle?.__instance ?? handle;
        target.setProperty('text', String(text));
      },
    };

    api.Input = {
      isKeyDown(key) {
        return context.input?.isKeyDown(String(key)) ?? false;
      },
      getMouseDelta() {
        return context.input?.getMouseDelta() ?? { x: 0, y: 0 };
      },
      getMovement() {
        return context.input?.getMovement() ?? { x: 0, y: 0, z: 0 };
      },
      get keyPressed() {
        return context.signalFor('inputBegan');
      },
      get keyReleased() {
        return context.signalFor('inputEnded');
      },
    };

    api.Camera = {
      setPosition(position) {
        context.camera?.setPosition(position);
      },
      setTarget(target) {
        context.camera?.setTarget(target);
      },
      setFov(fov) {
        context.camera?.setFov(Number(fov));
      },
      get position() {
        return context.camera?.getPosition() ?? new Vector3(0, 10, 20);
      },
    };

    api.Sound = {
      play(assetId, options = {}) {
        return context.sound?.play(String(assetId), {
          volume: Number(options.volume ?? 0.7),
          looped: Boolean(options.looped),
          group: String(options.group ?? 'sfx'),
          position: options.position ?? null,
          pitch: Number(options.pitch ?? 1),
        });
      },
      stop(handle) {
        context.sound?.stop(handle);
      },
      setGroupVolume(group, volume) {
        context.sound?.setGroupVolume(String(group), Number(volume));
      },
    };

    api.LocalPlayer = {
      get player() {
        return context.localPlayer ? context.wrapPlayer(context.localPlayer) : undefined;
      },
      get character() {
        return api.LocalPlayer.player?.character ?? undefined;
      },
    };
  }

  return api;
}

export default buildRuntimeApi;
