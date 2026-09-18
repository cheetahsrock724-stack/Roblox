/**
 * The Lua sandbox and script host.
 *
 * One Lua VM hosts all server scripts (or all client scripts) of a game session. Every script runs
 * with its own `_ENV` table whose only metatable entry chains to the runtime table, so creator code
 * cannot see globals, cannot touch the host, and cannot interfere with other scripts' locals.
 *
 * Protections:
 *   - no os/io/require/package/debug/load/dofile in scope (removed from the raw globals as well)
 *   - instruction budget per script invocation (debug.sethook) so `while true do end` cannot hang
 *   - every JS callback from Lua is wrapped in try/catch and reported to the Output panel
 *   - the API surface is a fixed allow-list; there is no reflection into host objects
 */
import { LuaFactory } from 'wasmoon';
import { Vector3 } from '@kinetiq/engine';
import { ENGINE_LIMITS, createLogger } from '@kinetiq/shared';
import { PRELUDE, LIBRARY_EXPORTS, HARDENING } from './prelude.js';
import { ScriptInstance, ScriptPlayer, ScriptCharacter, buildRuntimeApi } from './api.js';

let factoryPromise = null;

/**
 * A single shared factory keeps the wasm module compiled once per process.
 *
 * In the browser the Lua VM is loaded from the vendored wasmoon build, so the factory is created
 * from `globalThis.wasmoon` with an explicit wasm URI instead of the bundler-resolved import.
 */
export function getLuaFactory() {
  if (!factoryPromise) {
    factoryPromise = (async () => {
      const scope = globalThis;
      if (scope.__KINETIQ_LUA_FACTORY__) return scope.__KINETIQ_LUA_FACTORY__;
      const WasmoonFactory = scope.wasmoon?.LuaFactory ?? LuaFactory;
      const factory = new WasmoonFactory(scope.__KINETIQ_WASM_URI__ ?? undefined);
      scope.__KINETIQ_LUA_FACTORY__ = factory;
      return factory;
    })();
  }
  return factoryPromise;
}

export class ScriptHost {
  /**
   * @param {object} options
   * @param {'server'|'client'} options.mode
   * @param {import('@kinetiq/engine').World} options.world
   * @param {object} options.context  host callbacks (players, data, economy, badges, remotes, ui…)
   */
  constructor({ mode = 'server', world, context = {}, name = 'scripts' } = {}) {
    this.mode = mode;
    this.world = world;
    this.context = context;
    this.name = name;
    this.logger = context.logger ?? createLogger(`script:${mode}`);
    this.lua = null;
    this.started = false;
    this.scripts = new Map();
    this.logs = [];
    this.errors = [];
    this.wrappers = new Map();
    this.remotes = new Map();
    this.instanceSignals = new Map();
    this.engineSignals = new Map();
    this.characterWrappers = new Map();
    // Values handed to Lua are passed as opaque handle ids and resolved on the Lua side. wasmoon
    // cannot push JS objects as call arguments, so this keeps the boundary to primitives only.
    this.handles = new Map();
    this.handleSeq = 0;
    this.bridges = new Map();
    this.stats = { loaded: 0, ticks: 0, errors: 0 };
  }

  async start() {
    if (this.started) return this;
    const factory = await getLuaFactory();
    this.lua = await factory.createEngine();
    const global = this.lua.global;
    await global.set('__kt_host_log', (level, message) => this.pushLog(level, message));
    await global.set('__kt_host_error', (where, message) => this.pushError(where, message));
    // Host callbacks the prelude captures as locals. They must exist before the prelude runs.
    await global.set('__kt_resolve', (handle) => this.resolveHandle(handle));
    await global.set('__kt_watch', (instanceId, eventName) => this.watchInstance(instanceId, eventName));
    await global.set('__kt_remote_send', (name, target, args) => this.remoteSend(name, target, args));
    await this.lua.doString(PRELUDE);
    await this.lua.doString(LIBRARY_EXPORTS);
    const runtime = global.get('__kt_runtime');
    this.runtimeTable = runtime;
    // The Lua-side dispatcher: JS calls it with handle ids, Lua resolves and runs the wrappers.
    this.emitFn = runtime.__kt_bridge_emit;
    this.runtimeHandle = runtime;
    // The prelude exposes its entry points on the runtime table, which scripts cannot reach.
    this.tickFn = runtime.__kt_tick_guarded;
    this.loadFn = runtime.__kt_load;
    this.moduleFn = runtime.__kt_run_module;
    this.defineFn = runtime.__kt_define;
    // Bridge host logging into the runtime so Console output lands in the Output panel.
    runtime.__kt_on_log = (level, message) => this.pushLog(level, message);
    runtime.__kt_on_error = (where, message) => this.pushError(where, message);
    this.installApi();
    // Hardening runs last so the API staging globals are already copied into the runtime table.
    await this.lua.doString(HARDENING);
    this.started = true;
    return this;
  }

  installApi() {
    const api = buildRuntimeApi(this.buildApiContext());
    const global = this.lua.global;
    // wasmoon exposes Lua tables as JS proxies, so writing `runtime.key = v` from JS would not be
    // visible inside Lua. We stage each entry as a real Lua global, then copy the whole API into
    // the runtime table inside Lua and delete the staging globals.
    const keys = Object.keys(api);
    for (const key of keys) {
      global.set(`__kt_api_${key}`, key === 'Vector3' ? Vector3 : api[key]);
    }
    global.set('__kt_api_keys', keys);
    this.lua.doStringSync(String.raw`
      do
        local rt = __kt_runtime
        local list = __kt_api_keys
        for i = 1, #list do
          local key = list[i]
          local staged = _G['__kt_api_' .. key]
          if staged ~= nil then
            rt[key] = staged
            _G['__kt_api_' .. key] = nil
          end
        end
      end
    `);
    this.lua.doStringSync('__kt_api_keys = nil');
    this.installLuaOverlay();
  }

  /**
   * Lua-side sugar that must live in Lua so script callbacks receive resolved host objects:
   * service signals (`Players.playerJoined`), remote events and instance events.
   */
  installLuaOverlay() {
    this.lua.doStringSync(String.raw`
      do
        local rt = __kt_runtime
        local function withSignals(proxy, signals)
          local wrapper = {}
          for key, value in pairs(signals) do wrapper[key] = value end
          return setmetatable(wrapper, {
            __index = function(self, key)
              local value = proxy[key]
              if _type(value) ~= 'function' then return value end
              return function(...)
                local args = { ... }
                if args[1] == self then _table.remove(args, 1) end
                return value(_table.unpack(args))
              end
            end,
          })
        end

        if rt.Players then
          rt.Players = withSignals(rt.Players, {
            playerJoined = rt.__kt_signal('event:playerJoined'),
            playerLeft = rt.__kt_signal('event:playerLeft'),
            characterSpawned = rt.__kt_signal('event:characterSpawned'),
            characterRemoved = rt.__kt_signal('event:characterRemoved'),
          })
        end

        if rt.Input then
          rt.Input = withSignals(rt.Input, {
            keyPressed = rt.__kt_signal('event:inputBegan'),
            keyReleased = rt.__kt_signal('event:inputEnded'),
          })
        end

        rt.Remote = {
          get = function(name) return rt.__kt_remote(_tostring(name)) end,
          create = function(name) return rt.__kt_remote(_tostring(name)) end,
        }
      end
    `);
  }

  /** ------------------------------------------------------------- host <-> Lua values */

  /** Registers a host value so Lua can resolve it later. Primitives pass straight through. */
  registerHandle(value) {
    if (value === null || value === undefined) return undefined;
    const type = typeof value;
    if (type === 'string' || type === 'number' || type === 'boolean') return value;
    const id = `kqh:${(this.handleSeq += 1)}`;
    this.handles.set(id, value);
    if (this.handles.size > 4000) {
      // Drop the oldest quarter; scripts hold wrapped instances via their own caches.
      const drop = Math.floor(this.handles.size / 4);
      let index = 0;
      for (const key of this.handles.keys()) {
        this.handles.delete(key);
        if ((index += 1) >= drop) break;
      }
    }
    return id;
  }

  resolveHandle(handle) {
    if (typeof handle !== 'string' || !handle.startsWith('kqh:')) return handle;
    return this.handles.get(handle);
  }

  /** Invokes the Lua bridge dispatcher with handle ids (never raw objects). */
  dispatchBridge(key, ...args) {
    if (!this.started || typeof this.emitFn !== 'function') return;
    try {
      this.emitFn(key, ...args.map((value) => this.registerHandle(value)));
    } catch (error) {
      this.pushError(`event:${key}`, error.message ?? String(error));
    }
  }

  buildApiContext() {
    const self = this;
    const ctx = this.context;
    return {
      mode: this.mode,
      world: this.world,
      physics: this.world.physics,
      gameId: ctx.gameId ?? null,
      localPlayer: ctx.localPlayer ?? null,
      input: ctx.input ?? null,
      camera: ctx.camera ?? null,
      sound: ctx.sound ?? null,
      uiRoot: ctx.uiRoot ?? null,
      createInstance: (className, props) => {
        const instance = self.world.create(className, self.sanitiseProps(props));
        if (ctx.onInstanceCreated) ctx.onInstanceCreated(instance);
        return self.wrap(instance);
      },
      wrap: (instance) => self.wrap(instance),
      wrapPlayer: (player) => self.wrapPlayer(player),
      wrapCharacter: (character) => self.wrapCharacter(character),
      getPlayers: () => ctx.getPlayers?.() ?? [],
      characterFor: (playerId) => ctx.characterFor?.(playerId) ?? null,
      areFriends: (a, b) => Boolean(ctx.areFriends?.(a, b)),
      sendGameMessage: (playerId, text) => ctx.sendGameMessage?.(playerId, String(text)),
      kickPlayer: (playerId, reason) => ctx.kickPlayer?.(playerId, String(reason)),
      signalFor: (eventName) => self.signalFor(eventName),
      getRemote: (name) => self.getRemote(name),
      createRemote: (name) => self.createRemote(name),
      openDataStore: (storeName) =>
        ctx.openDataStore
          ? ctx.openDataStore(storeName)
          : self.memoryStore(storeName),
      leaderboard: (storeName, field, limit) => ctx.leaderboard?.(storeName, field, limit) ?? [],
      economy: ctx.economy ?? self.disabledEconomy(),
      badges: ctx.badges ?? self.disabledBadges(),
      createUI: (className, props) => self.createUI(className, props),
    };
  }

  sanitiseProps(props) {
    if (!props || typeof props !== 'object') return {};
    const out = {};
    for (const [key, value] of Object.entries(props)) {
      if (key.startsWith('__')) continue;
      out[key] = unwrapDeep(value);
    }
    return out;
  }

  /** ------------------------------------------------------------ wrappers */
  wrap(instance) {
    // `undefined` (not null) — see the note in api.js about JS -> Lua nil.
    if (!instance) return undefined;
    let wrapper = this.wrappers.get(instance.id);
    if (!wrapper) {
      wrapper = new ScriptInstance(instance, this);
      this.wrappers.set(instance.id, wrapper);
    }
    return wrapper;
  }

  wrapPlayer(player) {
    if (player instanceof ScriptPlayer) return player;
    if (!player) return undefined;
    return new ScriptPlayer(player, this);
  }

  wrapCharacter(character) {
    if (character instanceof ScriptCharacter) return character;
    if (!character) return undefined;
    let wrapper = this.characterWrappers.get(character.playerId);
    if (!wrapper) {
      wrapper = new ScriptCharacter(character, this);
      this.characterWrappers.set(character.playerId, wrapper);
    }
    return wrapper;
  }

  characterFor(playerId) {
    return this.context.characterFor?.(playerId) ?? null;
  }

  areFriends(a, b) {
    return Boolean(this.context.areFriends?.(a, b));
  }

  sendGameMessage(playerId, text) {
    return this.context.sendGameMessage?.(playerId, String(text));
  }

  kickPlayer(playerId, reason) {
    return this.context.kickPlayer?.(playerId, reason);
  }

  /** ------------------------------------------------------------ instances */
  setInstanceProperty(instance, name, value) {
    if (name === 'parent') {
      const target = value?.__instance ?? value;
      instance.setParent(target);
      if (target && !target.world?.instances.has(instance.id)) target.world.registerTree(instance);
      return this.wrap(instance);
    }
    const plain = unwrapDeep(value);
    instance.setProperty(name, plain);
    if (['position', 'size', 'anchored', 'canCollide', 'material', 'mass'].includes(name)) {
      this.world.physics.refreshInstance(instance);
      if (name === 'anchored') {
        this.world.physics.unregister(instance.id);
        this.world.physics.register(instance);
      }
    }
    return this.wrap(instance);
  }

  getInstanceProperty(instance, name) {
    if (name === 'parent') return instance.parent ? this.wrap(instance.parent) : undefined;
    const value = instance.getProperty(name);
    if (value instanceof Vector3) return value;
    return value;
  }

  /** ------------------------------------------------------------ events */
  signalFor(eventName) {
    let bridge = this.engineSignals.get(eventName);
    if (!bridge) {
      const host = this;
      const listeners = new Set();
      // Engine events are bridged through one shared subscription.
      if (this.world.events.signals.has(eventName) || true) {
        this.world.events.on(eventName, (...args) => {
          const raw = args.length === 1 ? args[0] : args;
          const payload = host.wrapEventPayload(eventName, raw);
          for (const listener of [...listeners]) {
            try {
              const result = listener(payload);
              if (result && typeof result.catch === 'function') {
                result.catch((error) => host.pushError(`event:${eventName}`, error.message ?? String(error)));
              }
            } catch (error) {
              host.pushError(`event:${eventName}`, error.message ?? String(error));
            }
          }
        });
      }
      bridge = {
        connect(fn) {
          listeners.add(fn);
          return {
            disconnect: () => listeners.delete(fn),
          };
        },
        once(fn) {
          const handle = bridge.connect((...args) => {
            handle.disconnect();
            fn(...args);
          });
          return handle;
        },
        connect_(fn) {
          return bridge.connect(fn);
        },
        wait: (timeoutSeconds = 5) =>
          new Promise((resolve) => {
            const handle = bridge.connect((payload) => {
              handle.disconnect();
              resolve(payload);
            });
            if (timeoutSeconds) setTimeout(() => handle.disconnect(), timeoutSeconds * 1000).unref?.();
          }),
        // PascalCase aliases so `signal:Connect(fn)` reads naturally in scripts.
        get Connect() {
          return (fn) => bridge.connect(fn);
        },
        get Once() {
          return (fn) => bridge.once(fn);
        },
        get Wait() {
          return () => bridge.wait();
        },
        get Fire() {
          return (...args) => bridge.fire?.(...args);
        },
      };
      this.engineSignals.set(eventName, bridge);
    }
    return bridge;
  }

  /**
   * Converts engine event payloads into script-friendly handles: scripts connected through
   * `Players.playerJoined:Connect(...)` receive a player handle rather than a plain record.
   */
  wrapEventPayload(eventName, payload) {
    if (!payload || typeof payload !== 'object') return payload;
    if (payload instanceof ScriptPlayer || payload instanceof ScriptCharacter || payload instanceof ScriptInstance) {
      return payload;
    }
    if (typeof payload.getProperty === 'function' && typeof payload.id === 'string' && payload.className) {
      return this.wrap(payload); // something that is already an engine Instance
    }
    switch (eventName) {
      case 'playerJoined':
      case 'playerLeft':
        return this.wrapPlayer(payload);
      case 'characterSpawned':
        return this.wrapCharacter(payload.character ?? payload);
      case 'characterRemoved':
        return this.wrapCharacter(payload.character ?? payload);
      case 'objectTouched':
      case 'interacted':
        return {
          instance: payload.instance ? this.wrap(payload.instance) : undefined,
          trigger: payload.trigger ? this.wrap(payload.trigger) : undefined,
          playerId: payload.playerId ?? undefined,
          player: payload.playerId ? this.wrapPlayer({ id: payload.playerId, username: payload.playerId, displayName: payload.playerId }) : undefined,
        };
      default:
        return payload;
    }
  }

  connectInstanceEvent(instance, event, fn) {
    const key = `${instance.id}:${event}`;
    const engineEvent = event === 'touched' ? 'objectTouched' : event === 'clicked' ? 'buttonClicked' : event;
    const subscription = this.world.events.on(engineEvent, (payload) => {
      if (!payload || (payload.instance !== instance && payload.trigger !== instance)) return;
      const other = payload.instance === instance ? payload.trigger ?? payload.body?.instance ?? null : payload.instance;
      try {
        const result = fn(other ? this.wrap(other) : null);
        if (result && typeof result.catch === 'function') {
          result.catch((error) => this.pushError(key, error.message ?? String(error)));
        }
      } catch (error) {
        this.pushError(key, error.message ?? String(error));
      }
    });
    this.instanceSignals.set(key, subscription);
    return {
      disconnect: () => {
        subscription.disconnect();
        this.instanceSignals.delete(key);
      },
    };
  }

  /**
   * Ensures object events (`Events.onInstance(part, "touched", fn)`) are routed to the script that
   * asked for them. The engine only publishes world-level events, so we filter by instance id.
   */
  watchInstance(instanceId, eventName) {
    const key = `${instanceId}:${eventName}`;
    this.instanceWatches = this.instanceWatches ?? new Set();
    if (this.instanceWatches.has(key)) return;
    this.instanceWatches.add(key);
    const worldEvent =
      eventName === 'touched'
        ? 'objectTouched'
        : eventName === 'clicked'
          ? 'buttonClicked'
          : eventName === 'entered'
            ? 'regionEntered'
            : eventName;
    this.world.events.on(worldEvent, (...args) => {
      const payload = args.length === 1 ? args[0] : args;
      const match = (candidate) =>
        candidate && (candidate.instance?.id === instanceId || candidate.id === instanceId || candidate.targetId === instanceId);
      if (match(payload)) {
        this.dispatchBridge(`inst:${instanceId}:${eventName}`, payload.instance ?? payload);
        return;
      }
      if (Array.isArray(payload)) {
        for (const entry of payload) {
          if (match(entry)) this.dispatchBridge(`inst:${instanceId}:${eventName}`, entry.instance ?? entry);
        }
      }
    });
  }

  /**
   * Called from Lua (`remote:fireClient(...)`, `remote:fireServer(...)`). `args` arrives as a Lua
   * table and is converted to plain host values.
   */
  remoteSend(name, target, args) {
    const list = Array.isArray(args) ? args.map(unwrapDeep) : [];
    const key = String(name);
    if (target === '*') {
      this.context.sendToAllClients?.(key, list);
      return true;
    }
    if (target === 'server') {
      this.context.sendToServer?.(key, list);
      return true;
    }
    this.context.sendToClient?.(String(target), key, list);
    return true;
  }

  /** ------------------------------------------------------------ remotes */
  getRemote(name) {
    return this.createRemote(name);
  }

  createRemote(name) {
    if (this.remotes.has(name)) return this.remotes.get(name);
    const host = this;
    const clientHandlers = new Set();
    const serverHandlers = new Set();
    const remote = {
      name,
      // server side
      fireClient(playerId, ...args) {
        host.context.sendToClient?.(String(playerId), name, args.map(unwrapDeep));
        return true;
      },
      fireAllClients(...args) {
        host.context.sendToAllClients?.(name, args.map(unwrapDeep));
        return true;
      },
      onServerEvent(fn) {
        serverHandlers.add(fn);
        return { disconnect: () => serverHandlers.delete(fn) };
      },
      onClientEvent(fn) {
        clientHandlers.add(fn);
        return { disconnect: () => clientHandlers.delete(fn) };
      },
      // client side
      fireServer(...args) {
        host.context.sendToServer?.(name, args.map(unwrapDeep));
        return true;
      },
    };
    remote.__emitServer = (playerId, args) => {
      const player = host.context.getPlayers?.().find((entry) => entry.id === playerId) ?? { id: playerId, username: playerId };
      for (const handler of [...serverHandlers]) {
        try {
          const result = handler(host.wrapPlayer(player), ...args);
          if (result && typeof result.catch === 'function') {
            result.catch((error) => host.pushError(`remote:${name}`, error.message ?? String(error)));
          }
        } catch (error) {
          host.pushError(`remote:${name}`, error.message ?? String(error));
        }
      }
    };
    remote.__emitClient = (args) => {
      for (const handler of [...clientHandlers]) {
        try {
          const result = handler(...args);
          if (result && typeof result.catch === 'function') {
            result.catch((error) => host.pushError(`remote:${name}`, error.message ?? String(error)));
          }
        } catch (error) {
          host.pushError(`remote:${name}`, error.message ?? String(error));
        }
      }
    };
    this.remotes.set(name, remote);
    return remote;
  }

  emitClientRemote(name, args = []) {
    this.dispatchBridge(`remote:${name}:client`, ...(Array.isArray(args) ? args : [args]));
  }

  emitServerRemote(name, playerId, args = []) {
    // A client may fire any remote name it likes; names no script listens on are simply ignored.
    const player = this.context.getPlayers?.().find((entry) => entry.id === playerId) ?? { id: playerId, username: playerId };
    this.dispatchBridge(`remote:${name}:server`, this.wrapPlayer(player), ...(Array.isArray(args) ? args : [args]));
  }

  /** ------------------------------------------------------------ UI helpers */
  createUI(className, props) {
    const allowed = ['Frame', 'TextLabel', 'TextButton', 'ImageLabel', 'InputField', 'ScrollingList', 'ProgressBar', 'Viewport', 'Folder'];
    if (!allowed.includes(className)) throw new Error(`${className} is not a creatable UI class`);
    const parent = this.context.uiRoot ?? this.world.root.findFirstChild('UI') ?? this.world.root;
    const instance = this.world.create(className, this.sanitiseProps(props), parent);
    if (this.context.onInstanceCreated) this.context.onInstanceCreated(instance);
    return this.wrap(instance);
  }

  /** ------------------------------------------------------------ fallbacks */
  memoryStore(storeName) {
    this._memoryStores = this._memoryStores ?? new Map();
    if (!this._memoryStores.has(storeName)) this._memoryStores.set(storeName, new Map());
    const store = this._memoryStores.get(storeName);
    return {
      get: (playerId) => structuredClone(store.get(playerId) ?? {}),
      set: (playerId, values) => {
        const payload = JSON.stringify(values ?? {});
        if (Buffer.byteLength?.(payload) > ENGINE_LIMITS.maxDataStoreValueBytes) {
          throw new Error('Data store value exceeds the size limit');
        }
        store.set(playerId, structuredClone(values ?? {}));
        return store.get(playerId);
      },
      increment: (playerId, key, amount = 1) => {
        const values = store.get(playerId) ?? {};
        values[key] = (Number(values[key]) || 0) + Number(amount);
        store.set(playerId, values);
        return values[key];
      },
    };
  }

  disabledEconomy() {
    return {
      getBalance: () => 0,
      grant: () => {
        throw new Error('Economy is not available in this context');
      },
      take: () => {
        throw new Error('Economy is not available in this context');
      },
      ownsProduct: () => false,
      listProducts: () => [],
    };
  }

  disabledBadges() {
    return {
      award: () => ({ awarded: false, reason: 'unavailable' }),
      has: () => false,
      create: () => {
        throw new Error('Badges are not available in this context');
      },
    };
  }

  /** ------------------------------------------------------------ scripts */
  async loadScript({ id, name, source, kind = this.mode, disabled = false }) {
    if (!this.started) await this.start();
    if (disabled) return { ok: true, skipped: true };
    let ok = false;
    let error = null;
    try {
      // Modules become runtime.import-ed values; server/client scripts execute immediately.
      const result =
        kind === 'module' ? this.moduleFn(name, source) : this.loadFn(name, source);
      if (Array.isArray(result)) {
        ok = Boolean(result[0]);
        error = result[0] === false ? String(result[1]) : null;
      } else {
        ok = Boolean(result);
      }
    } catch (err) {
      error = err.message ?? String(err);
      this.pushError(name, error);
    }
    this.scripts.set(id ?? name, { id, name, kind, source, ok, error });
    this.stats.loaded = this.scripts.size;
    if (!ok) this.stats.errors += 1;
    return { ok, error };
  }

  async loadAll(scripts = []) {
    await this.start();
    const results = [];
    // Modules first so server/client scripts can import them.
    const ordered = [...scripts].sort((a, b) => (a.kind === 'module' ? -1 : 0) - (b.kind === 'module' ? -1 : 0));
    for (const script of ordered) {
      results.push({ name: script.name, ...(await this.loadScript(script)) });
    }
    return results;
  }

  reloadScript(script) {
    this.scripts.delete(script.id ?? script.name);
    return this.loadScript(script);
  }

  /** Runs one scheduler step (heartbeat + task queue). */
  tick(deltaSeconds) {
    if (!this.started || !this.tickFn) return;
    try {
      if (this.lua.doStringSync) this.tickFn(deltaSeconds);
      else this.tickFn(deltaSeconds);
      this.stats.ticks += 1;
    } catch (error) {
      this.pushError('tick', error.message ?? String(error));
    }
    void this.runtimeHandle;
  }

  fireEvent(name, ...args) {
    // Scripts receive resolved host objects via the Lua bridge; see dispatchBridge().
    this.dispatchBridge(`event:${name}`, ...args);
    return true;
  }

  pushLog(level, message) {
    const entry = { level, message: String(message), script: this.currentScript, at: Date.now() };
    this.logs.push(entry);
    if (this.logs.length > 500) this.logs.shift();
    this.context.onLog?.(entry);
    if (this.mode === 'server') {
      const logFn = level === 'error' ? this.logger.error : level === 'warn' ? this.logger.warn : this.logger.info;
      logFn(String(message).slice(0, 500));
    }
  }

  pushError(where, message) {
    const entry = { level: 'error', message: String(message), where, at: Date.now() };
    this.errors.push(entry);
    if (this.errors.length > 200) this.errors.shift();
    this.stats.errors += 1;
    this.context.onError?.(entry);
    if (this.mode === 'server') this.logger.error(`[${where}] ${String(message).slice(0, 300)}`);
  }

  consumeErrors() {
    const copy = [...this.errors];
    this.errors.length = 0;
    return copy;
  }

  dispose() {
    for (const subscription of this.instanceSignals.values()) subscription.disconnect();
    this.instanceSignals.clear();
    this.wrappers.clear();
    this.remotes.clear();
    try {
      this.lua?.global?.close?.();
    } catch {
      /* engine already closed */
    }
    this.lua = null;
    this.started = false;
  }
}

/** Converts Lua-facing values back to plain JS for storage or transport. */
export function unwrapDeep(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(unwrapDeep);
  if (value instanceof Vector3) return { x: value.x, y: value.y, z: value.z };
  if (value && typeof value === 'object') {
    if (value.__instance) return value.__instance.id;
    if (value.toHex) return value.toHex();
    if (value.position && value.eulerDegrees) return value.position;
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (key.startsWith('__')) continue;
      out[key] = unwrapDeep(item);
    }
    return out;
  }
  return value;
}

function toLuaSafe(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'object') {
    if (value.__instance) return value;
    return unwrapDeep(value);
  }
  return value;
}

export default ScriptHost;
