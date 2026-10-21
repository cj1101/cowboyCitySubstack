/**
 * Shared vocabulary for the Phase 2 resolver core (Phase 2 brief §5.1).
 *
 * Types only — no logic, no I/O. Every other `lib/sim/` Phase 2 module
 * speaks in these terms: a caller assembles a `SimSnapshot` from an
 * explicit read plan, the pure resolver turns (snapshot, action) into a
 * `ResolutionPlan`, and the committer enriches the plan's entry drafts
 * with seqs and hashes inside one Firestore transaction.
 */

import type { BaselineCitation } from "./baseline/registry";

/** The resolver's own rules version (Phase 2 brief §5.5, decision P2-K —
 * adopted in workstreams/phase2-decisions.md). A different namespace from
 * the genesis label on `sim_world/current`, which stays
 * `"sim-rules-0.1.0-phase1"` forever. */
export const RESOLVER_RULES_VERSION = "sim-rules-0.5.0-phase5";

export const COMMITTER_VERSION = "sim-committer-0.2.0-phase2";

/** Total transactional write ceiling per Resolution Event (brief §4.6). */
export const MAX_WRITES_PER_RESOLUTION = 450;

/** Serialized-manifest preflight ceiling (brief §2.2/§4.6). Firestore's
 * document limit is 1 MiB; the manifest must leave room to spare. */
export const MAX_MANIFEST_BYTES = 900_000;

/** Ripeness scan caps (brief §7.3, decision P2-K13). */
export const SCAN_EVALUATE_CAP = 25;
export const SCAN_RIPEN_CAP = 5;
export const PENDING_GENERATION_CAP = 3;
export const PENDING_FANOUT_CAP = 4;
export const PENDING_MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Actors, actions, changes — the Phase 1 shapes (Phase 1 brief §1.4/§1.5,
// backend spec §3.3/§3.4), restated as types.
// ---------------------------------------------------------------------------

export interface SimActor {
  type: "member" | "npc" | "shared-office" | "contest" | "system";
  memberId: string | null;
  npcId: string | null;
  onBehalfOfMemberId: string | null;
  mandateId: string | null;
  mandateVersion: number | null;
  envelopeId: string | null;
  /** Present on shared-office actors (spec §3.3); absent elsewhere. */
  office?: "mayor" | "vice-mayor" | null;
  /** Phase 5 (P5-K13, Vera §9 C-1): the MEMBER actor form's one
   * additive field — a member acting in character carries the persona's
   * ID here, and attribution stays `type: "member"` (renders "〈member〉
   * as 〈character〉"). There is no `character` actor type and never will
   * be: a character is not an authority. Absent ≡ null in canonical
   * form — entries minted before Phase 5 lack the key, and the entry
   * builder (lib/sim/log.ts) stores the key only when it carries a
   * value, so the hashed field list and every historical hash are
   * unchanged. NPC actors never carry it (the mandate, not the persona,
   * authorized the act — the entry cites `npcId`). */
  characterId?: string | null;
}

export interface SimChange {
  field: string;
  before: unknown;
  after: unknown;
  formula: string;
}

export type ActionStatus =
  | "received"
  | "preview_pending"
  | "awaiting_confirmation"
  | "confirmed"
  | "queued"
  | "resolving"
  | "resolved"
  | "rejected"
  | "failed";

export interface SimAction {
  actionId: string;
  schemaVersion: number;
  clientRequestId: string;
  idempotencyKey: string;
  source: string;
  actor: SimActor;
  actionType: string;
  actionText: string | null;
  structuredAction: Record<string, unknown> | null;
  targetCityIds: string[];
  threadRef: { kind: string; id: string } | null;
  audienceUids: string[];
  preview: Record<string, unknown> | null;
  previewPlanHash: string | null;
  confirmation: {
    confirmedByUid: string;
    confirmedAt: unknown;
    previewHash: string;
    authorityType: string;
  } | null;
  /** The worker-prepared payload this action's preview was computed
   * with (Phase 4 Step 0, F-07), stored on the action doc at preview
   * time by the dispatcher and passed verbatim to the committer at
   * commit time: preview, confirmation, and commit all bind the SAME
   * payload. Never set by intake — a member-supplied judgment is the
   * FIXTURE-MARKET anti-pattern, a fairness breach as a product path. */
  preparedPayload?: PreparedPayload | null;
  preparedInputHash?: string | null;
  claim: {
    cycleId: string;
    leaseId: string;
    attempt: number;
    claimedAt: unknown;
    leaseExpiresAt: unknown;
  } | null;
  lastAttempt: { at: unknown; code: string; message: string } | null;
  status: ActionStatus;
  resolutionId: string | null;
  firstLogSeq: number | null;
  lastLogSeq: number | null;
  failure: { code: string; message: string } | null;
  createdAt: unknown;
  updatedAt: unknown;
}

/** Citations an action (or a resolution plan) declares against standing
 * records. The committer turns these into manifest ref keys (§8.3) and
 * pending reference registrations (§7.4). */
export interface SimCitations {
  resolutionIds?: string[];
  pendingIds?: string[];
  recordPaths?: string[];
  seqs?: number[];
}

// ---------------------------------------------------------------------------
// Snapshot (brief §5.1)
// ---------------------------------------------------------------------------

export interface SnapshotHead {
  path: string;
  stateVersion: number | null;
  /** sha256 over the canonical projection of the doc; absent docs hash a
   * fixed absent-marker so "wasn't there" is itself a head value. */
  hash: string;
}

/** A collection read declared by a read plan (Phase 4 Step 0, F-01).
 * The snapshot is the integrity boundary — heads, previewHash, the
 * manifest's input set, and the undo closure all derive from it — so a
 * read a handler needs must be declared here, never improvised inside
 * the handler (handlers are pure and receive only the snapshot).
 * Filters are equality-only in v1: the order book, the ballot set, and
 * holdings reads are all equality + order + limit shapes. */
export interface CollectionQuerySpec {
  /** Stable id within the declaring descriptor's read plan. */
  id: string;
  collectionPath: string;
  filters: { field: string; op: "=="; value: unknown }[];
  orderBy?: { field: string; direction: "asc" | "desc" }[];
  limit?: number;
}

/** A materialized collection read: the spec, the result doc paths in
 * query order, and a digest over the spec + the ordered (path, head
 * hash) results. Recorded on the snapshot and in the manifest's input
 * set, so query reads are bound exactly like doc reads — a membership
 * or content change between preview and commit is a stale preview. */
export interface SnapshotQueryRecord {
  spec: CollectionQuerySpec;
  resultPaths: string[];
  digest: string;
}

export interface SimSnapshot {
  /** path -> raw Firestore doc data (Timestamps intact), or null when the
   * doc does not exist. Handlers treat docs as read-only. */
  docs: ReadonlyMap<string, Record<string, unknown> | null>;
  heads: SnapshotHead[];
  /** Collection reads materialized into this snapshot (F-01); empty for
   * doc-only snapshots. Result docs are also in `docs`/`heads`. */
  queries: SnapshotQueryRecord[];
  counterHead: { lastSeq: number; lastEntryHash: string };
  /** Injected ISO instant — the only clock input the resolver ever sees. */
  now: string;
}

export function snapshotDoc(
  snapshot: SimSnapshot,
  path: string
): Record<string, unknown> | null {
  return snapshot.docs.get(path) ?? null;
}

/** Dotted-path field read ("stats.treasuryRubars") over a plain doc. */
export function docField(doc: Record<string, unknown> | null, field: string): unknown {
  if (doc === null) return undefined;
  let current: unknown = doc;
  for (const part of field.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Return a copy of `doc` with a dotted-path field set (immutable update). */
export function withDocField(
  doc: Record<string, unknown>,
  field: string,
  value: unknown
): Record<string, unknown> {
  const parts = field.split(".");
  const out: Record<string, unknown> = { ...doc };
  let cursor: Record<string, unknown> = out;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const next = cursor[parts[i]];
    const copy: Record<string, unknown> =
      typeof next === "object" && next !== null && !Array.isArray(next)
        ? { ...(next as Record<string, unknown>) }
        : {};
    cursor[parts[i]] = copy;
    cursor = copy;
  }
  cursor[parts[parts.length - 1]] = value;
  return out;
}

// ---------------------------------------------------------------------------
// Prepared payloads (brief §5.4) — worker output, bound by hash to the
// snapshot heads it was computed against. Validated, never generated,
// inside the commit path.
// ---------------------------------------------------------------------------

export interface PreparedPayload {
  classification?: unknown;
  generatedContent?: unknown;
  inputHash: string;
}

// ---------------------------------------------------------------------------
// Plans (brief §5.1/§5.3)
// ---------------------------------------------------------------------------

export type RecordClass = "state" | "pending" | "control" | "log";

export interface WritePlan {
  path: string;
  op: "create" | "update" | "delete";
  recordClass: RecordClass;
  /** Full after-state of the doc (absent for deletes). May still be
   * missing committer-stamped fields (`stateVersion` bump, `lastChangedSeq`)
   * — the committer finalizes those inside the transaction. */
  afterDoc?: Record<string, unknown>;
  changedFields: string[];
}

export type LogEntryKind =
  | "action-summary"
  | "rule-effect"
  | "case"
  | "contest"
  | "rejected"
  | "genesis";

/** A Log entry before the committer enriches it: no seq, no prevHash, no
 * entryHash, no resolvedAt/rulesVersion (stamped uniformly at commit). */
export interface LogEntryDraft {
  kind: LogEntryKind;
  /** Exactly one draft per plan carries `summary: true` — the last entry,
   * which receives `writeSetDigest` + `stateHeadsAfter` at commit. */
  summary: boolean;
  actor: SimActor;
  actionId: string | null;
  actionText: string | null;
  classification: Record<string, unknown> | null;
  cityId: string | null;
  cityIds: string[];
  ruleIds: string[];
  changes: SimChange[];
  spilloverFromSeq: number | null;
  causedBySeq: number | null;
  correctsSeq: number | null;
  recordsCreated: string[];
  recordsUpdated: string[];
  legal: Record<string, unknown> | null;
  chronicleDraftId: string | null;
  major: boolean;
  summaryText: string;
  visibility: "public" | "actor-private";
  baseline: BaselineCitation | null;
  pendingId: string | null;
  generation: {
    preparedBy: "worker";
    preparedInputHash: string;
    seed: string | null;
    boundsChecked: true;
  } | null;
}

export interface PendingDraft {
  /** Full pending doc per brief §2.4, except the committer-finalized
   * fields: `createdAtSeq`, `createdAt`, and the ripen condition's
   * `requiredSeq`/`eligibleAt` (they depend on the origin event's seq and
   * instant, which only exist inside the commit transaction). Those four
   * arrive as null here and are stamped by the committer. */
  doc: Record<string, unknown>;
}

export interface PendingTransition {
  pendingId: string;
  toStatus: "ripened" | "voided";
  outcomeSummary?: string | null;
  voidReason?: string | null;
}

export interface NarrativeIntent {
  kind: "note" | "chronicle" | "situation" | "outbox";
  text: string;
}

export interface ResolutionPlan {
  outcome: "resolved" | "rejected";
  rejection?: { code: string; ruleIds: string[]; summaryText: string };
  /** The classifying rule descriptor's ID (registry), for plan validation
   * (visibility class, pending permissions). Null for unruled narrative. */
  descriptorId: string | null;
  entries: LogEntryDraft[];
  writes: WritePlan[];
  pendingCreates: PendingDraft[];
  pendingTransitions: PendingTransition[];
  /** Pending docs whose `referencedByRefKeys` gain this resolution's key
   * (the §7.4 check-in registration, generalized to any citation). */
  pendingReferenceWrites: { pendingId: string }[];
  /** Ref keys (§8.3 grammar) this resolution reads/cites/consumes, beyond
   * its input heads. The committer unions these with the input-head keys
   * to form the manifest's `dependencyRefKeys`. */
  readRefKeys: string[];
  narrativeOutputs: NarrativeIntent[];
  /** sha256 over the canonical plan (seq-free). Filled by `finalizePlan`. */
  planHash: string;
}

export function emptyPlan(descriptorId: string | null): ResolutionPlan {
  return {
    outcome: "resolved",
    descriptorId,
    entries: [],
    writes: [],
    pendingCreates: [],
    pendingTransitions: [],
    pendingReferenceWrites: [],
    readRefKeys: [],
    narrativeOutputs: [],
    planHash: "",
  };
}
