/**
 * Canonical JSON ("cowboy-canonical-json-v1") — browser-safe port.
 *
 * The sim layer's canonical module (lib/sim/canonical.ts) computes the
 * draftHash the Phase 1 template records (EMPTY_DRAFT_HASH), but on master
 * it imports node:crypto and therefore cannot be bundled into a client
 * component. This module re-implements the SAME canonical encoding —
 * object keys sorted recursively, arrays in order, `undefined` object
 * members dropped, Dates as ISO strings, non-finite numbers rejected — so
 * a browser-computed draft hash is byte-identical to the fabric's.
 *
 * Phase 4 integration note: Phase 2 re-implements lib/sim/canonical.ts in
 * pure TypeScript. Once that lands on master, this port should be deleted
 * and the draft-hash helpers should import sha256Hex from lib/sim/canonical
 * directly. The golden-vector test in validation.test.ts (the Phase 1
 * empty-draft hash) pins the equivalence either way.
 */

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

/**
 * SHA-256 (hex) of the canonical JSON, via WebCrypto — async, because
 * crypto.subtle is async in the browser (and in Node >= 19, where the
 * unit tests run). Byte-identical output to lib/sim/canonical's sha256Hex.
 */
export async function sha256Hex(value: unknown): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("sha256Hex: WebCrypto (crypto.subtle) is unavailable in this environment");
  }
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The allocation draft hash, over exactly the input the Phase 1 template
 * hashes for the empty draft ({ allocations: {}, spentPoints: null } ->
 * EMPTY_DRAFT_HASH in lib/sim/template.ts).
 */
export async function computeDraftHash(
  allocations: Record<string, number>,
  spentPoints: number | null
): Promise<string> {
  return sha256Hex({ allocations, spentPoints });
}
