// Wire format. Byte 0 is the message type.
//   STATE (unreliable): u8 type, u16 race, u16 serial, f64 time, u8 count, count * (f32 x, f32 y, f32 a, i16 vx, i16 vy, i16 av)
//   PING/PONG (unreliable): clock sync
//   CTRL (reliable): u8 type, utf8 JSON  (low-rate lobby/race control)
// Everything received is untrusted: decoders validate sizes and types and return null on garbage.

export const T = { STATE: 1, CTRL: 2, PING: 3, PONG: 4 };
export const MAX_CTRL_BYTES = 16 * 1024;
const VEL_SCALE = 50; // i16 velocities, +-655 units/s at 0.02 resolution
const BODY_BYTES = 18;
const STATE_HEADER = 1 + 2 + 2 + 8 + 1;

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: false });

export function encodeState(race, serial, time, samples, count) {
  const buf = new ArrayBuffer(STATE_HEADER + count * BODY_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, T.STATE);
  v.setUint16(1, race & 0xffff, true);
  v.setUint16(3, serial & 0xffff, true);
  v.setFloat64(5, time, true);
  v.setUint8(13, count);
  let o = STATE_HEADER;
  const clamp = (x) => Math.max(-32767, Math.min(32767, Math.round(x * VEL_SCALE)));
  for (let i = 0; i < count; i++) {
    const s = i * 6;
    const x = samples[s];
    v.setFloat32(o, x, true);
    v.setFloat32(o + 4, Number.isFinite(x) ? samples[s + 1] : 0, true);
    v.setFloat32(o + 8, Number.isFinite(x) ? samples[s + 2] : 0, true);
    v.setInt16(o + 12, Number.isFinite(x) ? clamp(samples[s + 3]) : 0, true);
    v.setInt16(o + 14, Number.isFinite(x) ? clamp(samples[s + 4]) : 0, true);
    v.setInt16(o + 16, Number.isFinite(x) ? clamp(samples[s + 5]) : 0, true);
    o += BODY_BYTES;
  }
  return new Uint8Array(buf);
}

export function decodeState(u8) {
  if (u8.byteLength < STATE_HEADER) return null;
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const count = v.getUint8(13);
  if (u8.byteLength !== STATE_HEADER + count * BODY_BYTES || count > 64) return null;
  const time = v.getFloat64(5, true);
  if (!Number.isFinite(time)) return null;
  const data = new Float64Array(count * 6);
  let o = STATE_HEADER;
  for (let i = 0; i < count; i++) {
    const s = i * 6;
    const x = v.getFloat32(o, true);
    const y = v.getFloat32(o + 4, true);
    const a = v.getFloat32(o + 8, true);
    const ok = Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(a) && Math.abs(x) < 1e6 && Math.abs(y) < 1e6;
    data[s] = ok ? x : NaN;
    data[s + 1] = y; data[s + 2] = a;
    data[s + 3] = v.getInt16(o + 12, true) / VEL_SCALE;
    data[s + 4] = v.getInt16(o + 14, true) / VEL_SCALE;
    data[s + 5] = v.getInt16(o + 16, true) / VEL_SCALE;
    o += BODY_BYTES;
  }
  return { race: v.getUint16(1, true), serial: v.getUint16(3, true), time, data };
}

export function encodeCtrl(obj) {
  const body = enc.encode(JSON.stringify(obj));
  const out = new Uint8Array(1 + body.length);
  out[0] = T.CTRL;
  out.set(body, 1);
  return out;
}

export function decodeCtrl(u8) {
  if (u8.byteLength < 3 || u8.byteLength > MAX_CTRL_BYTES) return null;
  try {
    const obj = JSON.parse(dec.decode(u8.subarray(1)));
    return obj && typeof obj === 'object' && !Array.isArray(obj) && typeof obj.t === 'string' ? obj : null;
  } catch {
    return null;
  }
}

export function encodePing(type, id, t0, hostNow = 0) {
  const b = new ArrayBuffer(21);
  const v = new DataView(b);
  v.setUint8(0, type);
  v.setUint32(1, id >>> 0, true);
  v.setFloat64(5, t0, true);
  v.setFloat64(13, hostNow, true);
  return new Uint8Array(b);
}

export function decodePing(u8) {
  if (u8.byteLength !== 21) return null;
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  return { id: v.getUint32(1, true), t0: v.getFloat64(5, true), hostNow: v.getFloat64(13, true) };
}

// ---- validation helpers for CTRL payloads ----
export const V = {
  int: (x, min, max) => Number.isInteger(x) && x >= min && x <= max,
  num: (x) => typeof x === 'number' && Number.isFinite(x),
  bool: (x) => typeof x === 'boolean',
  str: (x, max) => typeof x === 'string' && x.length <= max,
  id: (x) => typeof x === 'string' && /^\d{1,20}$/.test(x),
  layout: (x) => Array.isArray(x) && x.length <= 64 && x.every((k) => typeof k === 'string' && k.length <= 64 && /^[A-Za-z0-9_.]+$/.test(k)),
  args: (x) => Array.isArray(x) && x.length <= 4 && x.every((a) => a === null || typeof a === 'boolean' || (typeof a === 'number' && Number.isFinite(a))),
};

/** Strip control characters and cap length; the UI also only ever uses textContent. */
export function cleanText(s, max = 200) {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '').slice(0, max);
}
