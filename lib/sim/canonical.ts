/**
 * Canonical JSON + SHA-256 for the sim layer (backend-architecture §1.3).
 *
 * Canonical encoding ("cowboy-canonical-json-v1"): object keys sorted
 * recursively, arrays preserved in order, no `undefined` values, timestamps
 * represented as ISO strings, integers kept as integers. Anything hashed in
 * the sim layer goes through here so the fabric, the procedures, and the
 * Phase 2 verifier all compute identical hashes over identical input.
 */

import { createHash } from "node:crypto";

export const HASH_VERSION = "cowboy-canonical-json-v1";

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
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
