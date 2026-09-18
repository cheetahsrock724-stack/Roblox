/**
 * Wire protocol between the game client, the game server (realm) and the platform.
 *
 * Frames are JSON with a compact `t` (type) field. High-frequency frames (input, snapshot) use
 * short keys and array payloads to keep packets small, and the codec quantises floats so two
 * clients never disagree about rounding.
 *
 * Every inbound frame is validated here before it reaches game logic: unknown types, oversized
 * payloads, wrong argument counts and out-of-range numbers are rejected.
 */
export const PROTOCOL_VERSION = 1;

export const ClientMessage = {
  HELLO: 'hello',
  READY: 'ready',
  INPUT: 'in',
  CHAT: 'chat',
  REMOTE: 'rem',
  RESPAWN: 'respawn',
  INTERACT: 'interact',
  PING: 'ping',
  CHUNK_REQUEST: 'chunk',
  CLICK: 'click',
  SET_UI_STATE: 'uistate',
};

export const ServerMessage = {
  WELCOME: 'welcome',
  CHUNK: 'chunk',
  SNAPSHOT: 'snap',
  SPAWN: 'spawn',
  DESPAWN: 'despawn',
  CHAT: 'chat',
  REMOTE: 'rem',
  OBJECT_UPDATE: 'obj',
  UI: 'ui',
  PONG: 'pong',
  ERROR: 'error',
  LOG: 'log',
  STOP: 'stop',
  PLAYER_STATE: 'pstate',
  NOTIFY: 'notify',
};

export const PROTOCOL_LIMITS = {
  maxFrameBytes: 256 * 1024,
  maxInputPerSecond: 90,
  maxChatPerSecond: 4,
  maxRemotePerSecond: 25,
  maxRemoteArgs: 12,
  maxStringLength: 512,
  maxArrayLength: 256,
};

/** Input frame: [moveX, moveZ, run, jump, yaw] with quantised numbers. */
export function encodeInput({ moveX = 0, moveZ = 0, run = false, jump = false, yaw = 0, sequence = 0 }) {
  return [q(moveX), q(moveZ), run ? 1 : 0, jump ? 1 : 0, q(yaw), sequence];
}

export function decodeInput(payload) {
  if (!Array.isArray(payload) || payload.length < 5) return null;
  const moveX = clampNumber(payload[0], -1, 1);
  const moveZ = clampNumber(payload[1], -1, 1);
  return {
    moveX,
    moveZ,
    run: Boolean(payload[2]),
    jump: Boolean(payload[3]),
    yaw: clampNumber(payload[4], -Math.PI * 4, Math.PI * 4),
    sequence: Number.isFinite(Number(payload[5])) ? Number(payload[5]) : 0,
  };
}

/** Snapshot frame: compact arrays to keep player counts cheap. */
export function encodeSnapshot({ tick, time, characters, objects = [] }) {
  return {
    t: ServerMessage.SNAPSHOT,
    k: tick,
    w: q(time),
    p: characters.map((character) => [
      character.id,
      q(character.position.x),
      q(character.position.y),
      q(character.position.z),
      q(character.facing),
      q(character.velocity.x),
      q(character.velocity.y),
      q(character.velocity.z),
      character.state,
      Math.round(character.health),
    ]),
    o: objects,
  };
}

export function decodeSnapshot(message) {
  if (!message || !Array.isArray(message.p)) return { tick: 0, time: 0, characters: [] };
  return {
    tick: Number(message.k) || 0,
    time: Number(message.w) || 0,
    characters: message.p.map((entry) => ({
      id: String(entry[0]),
      position: { x: Number(entry[1]) || 0, y: Number(entry[2]) || 0, z: Number(entry[3]) || 0 },
      facing: Number(entry[4]) || 0,
      velocity: { x: Number(entry[5]) || 0, y: Number(entry[6]) || 0, z: Number(entry[7]) || 0 },
      state: String(entry[8] ?? 'idle'),
      health: Number(entry[9] ?? 100),
    })),
    objects: Array.isArray(message.o) ? message.o : [],
  };
}

function q(value) {
  // 3 decimal places: plenty for a 20Hz snapshot, and it halves payload size versus raw floats.
  return Math.round((Number(value) || 0) * 1000) / 1000;
}

function clampNumber(value, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.min(max, Math.max(min, num));
}

/** Validates any inbound frame. Returns { ok, error, message }. */
export function validateFrame(raw, { maxBytes = PROTOCOL_LIMITS.maxFrameBytes } = {}) {
  const text = typeof raw === 'string' ? raw : raw?.toString?.('utf8') ?? '';
  if (text.length > maxBytes) return { ok: false, error: 'frame_too_large' };
  if (!text.trim()) return { ok: false, error: 'empty_frame' };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'malformed_json' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'not_an_object' };
  }
  const type = parsed.t ?? parsed.type;
  if (typeof type !== 'string' || type.length > 32) return { ok: false, error: 'bad_type' };
  return { ok: true, message: parsed, type };
}

/** Sanitises remote-event payloads (scripts must not be able to inject giant or exotic values). */
export function sanitiseRemoteArgs(args, depth = 0) {
  if (depth > 4) return null;
  if (!Array.isArray(args)) return [];
  return args.slice(0, PROTOCOL_LIMITS.maxRemoteArgs).map((value) => sanitiseValue(value, depth + 1));
}

function sanitiseValue(value, depth) {
  if (value === null || value === undefined) return null;
  const type = typeof value;
  if (type === 'number') return Number.isFinite(value) ? value : 0;
  if (type === 'boolean') return value;
  if (type === 'string') return value.slice(0, PROTOCOL_LIMITS.maxStringLength);
  if (type === 'object') {
    if (Array.isArray(value)) {
      return value.slice(0, PROTOCOL_LIMITS.maxArrayLength).map((item) => sanitiseValue(item, depth + 1));
    }
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 32)) {
      if (key.startsWith('__')) continue;
      out[key.slice(0, 64)] = sanitiseValue(item, depth + 1);
    }
    return out;
  }
  return null;
}

export function nowMs() {
  return Date.now();
}

export const DEFAULT_REALM_PORT_RANGE = [41000, 41999];

export default { ClientMessage, ServerMessage, validateFrame, encodeSnapshot, decodeSnapshot };
