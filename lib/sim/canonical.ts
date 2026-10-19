/**
 * Canonical JSON + SHA-256 for the sim layer (backend-architecture §1.3).
 *
 * Canonical encoding ("cowboy-canonical-json-v1"): object keys sorted
 * recursively, arrays preserved in order, no `undefined` values, timestamps
 * represented as ISO strings, integers kept as integers. Anything hashed in
 * the sim layer goes through here so the fabric, the procedures, and the
 * Phase 2 verifier all compute identical hashes over identical input.
 */

export const HASH_VERSION = "cowboy-canonical-json-v1";

/**
 * SHA-256 in pure TypeScript (FIPS 180-4), deliberately isomorphic: the
 * canonical layer must produce identical digests in Node, in tests, and
 * in the browser (the Log page and the client-side export read sim
 * modules). Digests are byte-identical to node:crypto's — verified
 * against it over the Phase 1 template hash and randomized vectors when
 * this replaced the node:crypto import (Phase 2), so every hash minted
 * under Phase 1 stays valid.
 */
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function sha256Digest(bytes: Uint8Array): Uint8Array {
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const bitLen = bytes.length * 8;
  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const msg = new Uint8Array(paddedLen);
  msg.set(bytes);
  msg[bytes.length] = 0x80;
  const view = new DataView(msg.buffer);
  view.setUint32(paddedLen - 4, bitLen >>> 0);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000));
  const w = new Int32Array(64);
  for (let block = 0; block < paddedLen; block += 64) {
    for (let t = 0; t < 16; t += 1) w[t] = view.getInt32(block + t * 4);
    for (let t = 16; t < 64; t += 1) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let t = 0; t < 64; t += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA256_K[t] + w[t]) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) | 0;
      h = g; g = f; f = e; e = (d + temp1) | 0;
      d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((word, i) =>
    outView.setUint32(i * 4, word >>> 0)
  );
  return out;
}

/** SHA-256 of a UTF-8 string, hex-encoded. */
export function sha256HexOfText(text: string): string {
  const digest = sha256Digest(new TextEncoder().encode(text));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

/**
 * Convert an arbitrary value into its canonical form. Dates become ISO
 * strings; `undefined` object members are dropped (canonical JSON has no
 * undefined); `undefined` anywhere else is a caller bug and throws.
 */
export function toCanonical(value: unknown): CanonicalValue {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item === undefined) {
        throw new Error("canonicalJson: undefined array element is not representable");
      }
      return toCanonical(item);
    });
  }
  if (isPlainObject(value)) {
    const out: { [key: string]: CanonicalValue } = {};
    for (const key of Object.keys(value).sort()) {
      const member = value[key];
      if (member === undefined) continue;
      out[key] = toCanonical(member);
    }
    return out;
  }
  if (typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("canonicalJson: non-finite number is not representable");
    }
    return value;
  }
  throw new Error(`canonicalJson: unsupported value of type ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(toCanonical(value));
}

export function sha256Hex(value: unknown): string {
  return sha256HexOfText(canonicalJson(value));
}
