/**
 * Mandate version mechanics (brief §2.3/§2.7): the canonical hash over
 * the immutable authority payload, and the pure derivation of a
 * version's in-force state at a given seq.
 *
 * Version docs are immutable once written; "expiry" is therefore a
 * DERIVATION, not a write: a lazily-read version whose stored status
 * still says "active" is expired as soon as the seq/horizon predicate
 * says so, and the fabric's finalizers persist the flip. Evaluation
 * never trusts the stored status alone (TC-N09's mid-flight revocation
 * is exactly the case where stored and derived state diverge).
 *
 * Periods are seq/action-count terms, never clock terms (§2.3): every
 * predicate here is evaluated against `atSeq` and the Log-counted
 * `PeriodUsage`, never against a wall clock.
 */

import { sha256Hex } from "../sim/canonical";
import type { MandateVersionRecord, PeriodUsage } from "./types";

/**
 * The immutable authority payload the owner confirmed — the hash input.
 * Excluded by design: `status`, `effectiveSeq`, `revokedSeq` (lifecycle
 * stamps the committer/finalizers apply after confirmation) and
 * `mandateHash` itself. A revocation or activation stamp therefore never
 * moves the hash of what was confirmed (brief §2.7).
 */
export function mandateAuthorityPayload(
  version: MandateVersionRecord
): Record<string, unknown> {
  return {
    mandateId: version.mandateId,
    version: version.version,
    mode: version.mode,
    scope: version.scope,
    expiresAtSeq: version.expiresAtSeq,
    horizonActions: version.horizonActions,
    createdByUid: version.createdByUid,
  };
}

export function computeMandateHash(version: MandateVersionRecord): string {
  return sha256Hex(mandateAuthorityPayload(version));
}

export function verifyMandateHash(version: MandateVersionRecord): boolean {
  return version.mandateHash === computeMandateHash(version);
}

export type MandateVersionState =
  | "in-force"
  | "pending" // written, not yet effective
  | "not-yet-effective" // active but effectiveSeq is still ahead
  | "superseded"
  | "revoked"
  | "expired-seq" // atSeq reached expiresAtSeq
  | "expired-horizon" // delegated count reached horizonActions
  | "hash-mismatch"; // stored hash ≠ payload hash: fail closed

/**
 * In force = stored status active AND hash verifies AND effectiveSeq
 * reached AND neither expiry predicate has fired. The hash check is
 * part of authority, not hygiene: a tampered or fan-out-corrupted
 * version doc must fail closed (the preview-parity lesson of TC-N05 —
 * evaluation reads only what the hash certifies).
 */
export function mandateVersionState(
  version: MandateVersionRecord,
  atSeq: number,
  usage: PeriodUsage
): MandateVersionState {
  if (version.status === "pending") return "pending";
  if (version.status === "superseded") return "superseded";
  if (version.status === "revoked") return "revoked";
  if (version.status === "expired") return "expired-seq";
  // status "active" from here.
  if (!verifyMandateHash(version)) return "hash-mismatch";
  if (version.effectiveSeq === null || atSeq < version.effectiveSeq) {
    return "not-yet-effective";
  }
  if (version.expiresAtSeq !== null && atSeq >= version.expiresAtSeq) {
    return "expired-seq";
  }
  if (
    version.horizonActions !== null &&
    usage.delegatedResolutions >= version.horizonActions
  ) {
    return "expired-horizon";
  }
  return "in-force";
}
