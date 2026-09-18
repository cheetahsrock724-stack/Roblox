/**
 * Frame codec + bandwidth accounting.
 *
 * Frames are JSON text (universally supported, debuggable, and fast enough at these sizes) with
 * optional gzip via `permessage-deflate` on the transport for larger payloads. The codec also
 * handles interest management: snapshots only include characters and objects within the client's
 * streaming radius.
 */
import { PROTOCOL_LIMITS, ServerMessage } from './protocol.js';

export function encodeFrame(message) {
  return JSON.stringify(message);
}

export function decodeFrame(text) {
  return JSON.parse(text);
}

/** Measured bandwidth, exposed in the developer console. */
export class BandwidthMeter {
  constructor(windowMs = 5000) {
    this.windowMs = windowMs;
    this.samples = [];
    this.totals = { in: 0, out: 0, framesIn: 0, framesOut: 0 };
  }

  recordIn(bytes) {
    this.samples.push({ at: Date.now(), bytes, direction: 'in' });
    this.totals.in += bytes;
    this.totals.framesIn += 1;
    this.trim();
  }

  recordOut(bytes) {
    this.samples.push({ at: Date.now(), bytes, direction: 'out' });
    this.totals.out += bytes;
    this.totals.framesOut += 1;
    this.trim();
  }

  trim() {
    const cutoff = Date.now() - this.windowMs;
    while (this.samples.length && this.samples[0].at < cutoff) this.samples.shift();
  }

  get stats() {
    this.trim();
    const seconds = this.windowMs / 1000;
    let inbound = 0;
    let outbound = 0;
    for (const sample of this.samples) {
      if (sample.direction === 'in') inbound += sample.bytes;
      else outbound += sample.bytes;
    }
    return {
      bytesInPerSecond: Math.round(inbound / seconds),
      bytesOutPerSecond: Math.round(outbound / seconds),
      totalIn: this.totals.in,
      totalOut: this.totals.out,
      framesIn: this.totals.framesIn,
      framesOut: this.totals.framesOut,
    };
  }
}

/**
 * Per-connection rate limiting + queueing. Prevents a client from flooding the server with
 * input frames or remote calls (which would otherwise amplify into game logic).
 */
export class ConnectionLimiter {
  constructor() {
    this.counters = new Map();
  }

  allow(key, limitPerSecond) {
    const now = Date.now();
    const bucket = this.counters.get(key) ?? { count: 0, resetAt: now + 1000 };
    if (now >= bucket.resetAt) {
      bucket.count = 0;
      bucket.resetAt = now + 1000;
    }
    bucket.count += 1;
    this.counters.set(key, bucket);
    return bucket.count <= limitPerSecond;
  }
}

/** Drops chars outside the printable range and clamps length (chat safety). */
export function sanitiseChatText(text) {
  return String(text ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s{3,}/g, '  ')
    .trim()
    .slice(0, PROTOCOL_LIMITS.maxStringLength);
}

/**
 * Interest management: given the observer position and a radius, return only the items the client
 * needs. Keeps large worlds playable with many players.
 */
export function visibleWithin(observerPosition, radius, items, getPosition) {
  const out = [];
  const radiusSquared = radius * radius;
  for (const item of items) {
    const position = getPosition(item);
    const dx = position.x - observerPosition.x;
    const dy = position.y - observerPosition.y;
    const dz = position.z - observerPosition.z;
    if (dx * dx + dy * dy + dz * dz <= radiusSquared) out.push(item);
  }
  return out;
}

export { ServerMessage };
export default { encodeFrame, decodeFrame, BandwidthMeter, ConnectionLimiter };
