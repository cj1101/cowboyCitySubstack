/**
 * The Log — Phase 2 form (Phase 2 brief §2.1).
 *
 * Hash version v2: the Phase 1 canonical field list plus `pendingId`,
 * `wakeActionId`, `executedDuringSeq`, `generation`. `computeEntryHash`
 * dispatches on `hashVersion`: v1 entries (genesis, and only genesis)
 * verify under the exact Phase 1 field list forever — delegated untouched
 * to Phase 1's `computeLogEntryHash` — and v2 entries under the extended
 * list. Genesis is never rewritten to v2.
 *
 * This module also carries the Firestore-value canonical projection the
 * Phase 2 code hashes docs with (the same duck-typed projection Phase 1's
 * genesis uses — duplicated deliberately so no Phase 2 module imports a
 * module that touches the Admin SDK; genesis.ts keeps its own copy), the
 * §8.3 ref-key grammar, and the pure read-path merge for the Log page /
 * export (§11.1): a member's view merges the public entries with their
 * own actor-private entries, deduped by seq.
 */

import { sha256Hex } from "./canonical";
import { computeLogEntryHash as computeLogEntryHashV1 } from "./template";
import type { LogEntryDraft } from "./state";

export const HASH_VERSION_V2 = "cowboy-canonical-json-v2";

// ---------------------------------------------------------------------------
// Canonical projection of Firestore values (Dates / Timestamps -> ISO).
// ---------------------------------------------------------------------------

export function projectFirestoreValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { toDate?: unknown }).toDate === "function"
  ) {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  if (Array.isArray(value)) return value.map(projectFirestoreValue);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value)) {
      out[key] = projectFirestoreValue(member);
    }
    return out;
  }
  return value;
}

export function projectDoc(doc: Record<string, unknown>): Record<string, unknown> {
  return projectFirestoreValue(doc) as Record<string, unknown>;
}

/** Hash of a stored doc, over its canonical projection. */
export function hashSimDoc(doc: Record<string, unknown>): string {
  return sha256Hex(projectDoc(doc));
}

/** The head hash of an absent doc — a fixed marker, so "was not there"
 * is a first-class head value in snapshots and manifests. */
export const ABSENT_DOC_HASH = sha256Hex({ simAbsentDoc: true });

export function headHashOf(doc: Record<string, unknown> | null): string {
  return doc === null ? ABSENT_DOC_HASH : hashSimDoc(doc);
}

// ---------------------------------------------------------------------------
// Entry hashing — v2 field list = Phase 1 list + the four Phase 2 fields.
// ---------------------------------------------------------------------------

const LOG_HASH_FIELDS_V2 = [
  "hashVersion",
  "seq",
  "resolutionId",
  "resolutionSeq",
  "kind",
  "resolvedAt",
  "rulesVersion",
  "actor",
  "actionId",
  "classification",
  "cityId",
  "cityIds",
  "ruleIds",
  "changes",
  "spilloverFromSeq",
  "causedBySeq",
  "correctsSeq",
  "recordsCreated",
  "recordsUpdated",
  "legal",
  "chronicleDraftId",
  "major",
  "summaryText",
  "actionText",
  "prevHash",
  "visibility",
  "baseline",
  // Phase 2 additions (§2.1) — present on every v2 entry, null when N/A.
  "pendingId",
  "wakeActionId",
  "executedDuringSeq",
  "generation",
] as const;

export function computeLogEntryHashV2(entry: Record<string, unknown>): string {
  const input: Record<string, unknown> = {};
  for (const field of LOG_HASH_FIELDS_V2) {
    input[field] = entry[field] ?? null;
  }
  return sha256Hex(input);
}

/** Dispatch on the entry's own hashVersion (brief §2.1). */
export function computeEntryHash(entry: Record<string, unknown>): string {
  if (entry.hashVersion === HASH_VERSION_V2) return computeLogEntryHashV2(entry);
  return computeLogEntryHashV1(entry);
}

// ---------------------------------------------------------------------------
// Ref-key grammar (brief §8.3) — canonical strings stored on manifests.
// ---------------------------------------------------------------------------

export const refKey = {
  resolution: (resolutionId: string) => `resolution:${resolutionId}`,
  seq: (seq: number) => `seq:${seq}`,
  action: (actionId: string) => `action:${actionId}`,
  record: (path: string) => `record:${path}`,
  recordVersion: (path: string, stateVersion: number | null) =>
    `record-version:${path}@${stateVersion === null ? "none" : stateVersion}`,
  field: (path: string, fieldName: string) => `field:${path}#${fieldName}`,
  pending: (pendingId: string) => `pending:${pendingId}`,
};

// ---------------------------------------------------------------------------
// Entry assembly — the committer turns a draft + allocation into the
// stored entry (brief §4.4 steps 6–7). Pure: no Firestore, no clock.
// ---------------------------------------------------------------------------

export interface EntryAllocation {
  seq: number;
  resolutionSeq: number;
  resolutionId: string;
  entryIndexWithinResolution: number;
  resolvedAt: string;
  rulesVersion: string;
  prevHash: string;
  /** Set by the committer on ripening/voiding entries (§7.4): the
   * occasion, kept out of the cause chain. Null for action entries. */
  wakeActionId: string | null;
  executedDuringSeq: number | null;
  /** Summary entries only: filled after the write set is known. */
  writeSetDigest?: string;
  stateHeadsAfter?: { path: string; afterHash: string; stateVersion: number | null }[];
}

export function buildLogEntry(
  draft: LogEntryDraft,
  alloc: EntryAllocation
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    seq: alloc.seq,
    resolutionSeq: alloc.resolutionSeq,
    resolutionId: alloc.resolutionId,
    entryIndexWithinResolution: alloc.entryIndexWithinResolution,
    kind: draft.kind,
    resolvedAt: alloc.resolvedAt,
    rulesVersion: alloc.rulesVersion,
    actor: draft.actor,
    actionId: draft.actionId,
    actionText: draft.actionText,
    classification: draft.classification,
    cityId: draft.cityId,
    cityIds: draft.cityIds,
    ruleIds: draft.ruleIds,
    changes: draft.changes,
    spilloverFromSeq: draft.spilloverFromSeq,
    causedBySeq: draft.causedBySeq,
    correctsSeq: draft.correctsSeq,
    recordsCreated: draft.recordsCreated,
    recordsUpdated: draft.recordsUpdated,
    legal: draft.legal,
    chronicleDraftId: draft.chronicleDraftId,
    major: draft.major,
    summaryText: draft.summaryText,
    visibility: draft.visibility,
    baseline: draft.baseline,
    pendingId: draft.pendingId,
    wakeActionId: alloc.wakeActionId,
    executedDuringSeq: alloc.executedDuringSeq,
    generation: draft.generation,
    prevHash: alloc.prevHash,
    hashVersion: HASH_VERSION_V2,
  };
  if (draft.summary) {
    entry.writeSetDigest = alloc.writeSetDigest ?? null;
    entry.stateHeadsAfter = alloc.stateHeadsAfter ?? [];
  }
  entry.entryHash = computeLogEntryHashV2(entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Read-path merge (§11.1) — pure helper for the Log page and the export.
// A member's visible set = public entries + their own actor-private
// entries. Erased entries leave no placeholder: they are not in either
// input, so they are not in the output. Seq gaps are never annotated.
// ---------------------------------------------------------------------------

export interface VisibleEntry {
  seq: number;
  [key: string]: unknown;
}

export function mergeVisibleEntries<T extends VisibleEntry>(
  publicEntries: readonly T[],
  ownPrivateEntries: readonly T[]
): T[] {
  const bySeq = new Map<number, T>();
  for (const entry of publicEntries) bySeq.set(entry.seq, entry);
  for (const entry of ownPrivateEntries) bySeq.set(entry.seq, entry);
  return [...bySeq.values()].sort((a, b) => b.seq - a.seq);
}

/** The private badge test used by the page (§11.1): an entry renders as
 * private-to-you only in the owner's own merged view. */
export function isActorPrivate(entry: VisibleEntry): boolean {
  return entry.visibility === "actor-private";
}
