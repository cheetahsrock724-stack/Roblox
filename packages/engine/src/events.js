/**
 * Signal/event system used by the engine, the scripting bridge and the networking layer.
 * `Signal:Connect` semantics are familiar, `:Once`/`:Disconnect` supported, and listener errors
 * are isolated so one broken script cannot break the simulation loop.
 */
export class Signal {
  constructor(name = 'Signal') {
    this.name = name;
    this.listeners = new Set();
    this.suspended = false;
  }

  connect(fn, { once = false, tag = null, priority = 0 } = {}) {
    if (typeof fn !== 'function') throw new TypeError('Signal:Connect expects a function');
    const listener = { fn, once, tag, priority };
    this.listeners.add(listener);
    return {
      disconnect: () => this.listeners.delete(listener),
      connected: true,
    };
  }

  once(fn, options = {}) {
    return this.connect(fn, { ...options, once: true });
  }

  disconnectAll(tag = undefined) {
    if (tag === undefined) this.listeners.clear();
    else for (const listener of [...this.listeners]) if (listener.tag === tag) this.listeners.delete(listener);
  }

  get count() {
    return this.listeners.size;
  }

  /** Fires listeners synchronously in priority order; returns array of results. */
  fire(...args) {
    if (this.suspended || this.listeners.size === 0) return [];
    const ordered = [...this.listeners].sort((a, b) => b.priority - a.priority);
    const results = [];
    for (const listener of ordered) {
      if (listener.once) this.listeners.delete(listener);
      try {
        results.push(listener.fn(...args));
      } catch (error) {
        this.onError?.(error, listener);
      }
    }
    return results;
  }

  /** Async-safe fire: awaits each listener in turn (used by remote functions). */
  async fireAsync(...args) {
    if (this.suspended || this.listeners.size === 0) return [];
    const ordered = [...this.listeners].sort((a, b) => b.priority - a.priority);
    const results = [];
    for (const listener of ordered) {
      if (listener.once) this.listeners.delete(listener);
      try {
        results.push(await listener.fn(...args));
      } catch (error) {
        this.onError?.(error, listener);
      }
    }
    return results;
  }

  wait(timeoutMs = null) {
    return new Promise((resolve, reject) => {
      const connection = this.once((...args) => {
        if (timer) clearTimeout(timer);
        resolve(args.length === 1 ? args[0] : args);
      });
      const timer =
        timeoutMs === null
          ? null
          : setTimeout(() => {
              connection.disconnect();
              reject(new Error(`Timed out waiting for ${this.name}`));
            }, timeoutMs);
    });
  }
}

/** A registry of named signals, created lazily on first access. */
export class EventBus {
  constructor() {
    this.signals = new Map();
  }
  signal(name) {
    let signal = this.signals.get(name);
    if (!signal) {
      signal = new Signal(name);
      this.signals.set(name, signal);
    }
    return signal;
  }
  on(name, fn, options) {
    return this.signal(name).connect(fn, options);
  }
  fire(name, ...args) {
    return this.signal(name).fire(...args);
  }
  clear() {
    for (const signal of this.signals.values()) signal.disconnectAll();
    this.signals.clear();
  }
  list() {
    return [...this.signals.entries()].map(([name, signal]) => ({ name, listeners: signal.count }));
  }
}

/** Standard event names creators can subscribe to from scripts. */
export const ENGINE_EVENTS = [
  'heartbeat',
  'update',
  'playerJoined',
  'playerLeft',
  'characterSpawned',
  'characterRemoved',
  'characterDied',
  'humanoidStateChanged',
  'objectTouched',
  'touchEnded',
  'objectAdded',
  'objectRemoved',
  'objectChanged',
  'buttonClicked',
  'inputBegan',
  'inputEnded',
  'interacted',
  'remoteEvent',
  'remoteFunction',
  'serverStarted',
  'serverStopping',
  'badgeAwarded',
  'valueChanged',
];

export default Signal;
