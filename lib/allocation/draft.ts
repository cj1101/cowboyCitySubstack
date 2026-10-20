/**
 * The `sim_stat_allocations/{cityId}` draft-save shape, as landed in Phase 1
 * and narrowed in Phase 4 Module 0 (build-prep P4-K14).
 *
 * The Firestore rules (firestore.rules, match /sim_stat_allocations/{cityId})
 * give the city owner exactly one browser write path: an update that —
 *
 * - starts from status 'not_started' or 'draft',
 * - lands on status 'draft' — the ONLY owner-settable target since the
 *   P4-K14 narrowing ('commit_requested' is the committer's alone),
 * - leaves baselineHash, baselineStats, pointBudget, commitActionId,
 *   committedSeq, and committedByUid byte-identical (field-equality checks),
 * - and touches ONLY the draft fields listed in DRAFT_WRITABLE_FIELDS.
 *
 * Doc creation is fabric-committer-only (lazy creation, Phase 1 brief §3);
 * delete is denied to everyone. This module builds payloads that fit that
 * fence exactly — nothing here can express a write the rules would refuse,
 * and the field list is asserted against the fence in validation.test.ts.
 *
 * ==========================================================================
 * COMMIT — AN ACTION, NOT A STATUS WRITE (P4-K14, brief §3.3)
 * ==========================================================================
 * There is deliberately no commit builder in this file. Committing is an
 * `allocate_season0` ACTION through the play loop (commitAction.ts builds
 * and submits it): the fabric previews it, the member's hash-bound
 * confirmation on the action is the binding act, and the committer — in
 * one transaction — writes the eight values into sim_cities/{cityId}.stats,
 * sets status 'committed' with commitActionId / committedSeq /
 * committedByUid, writes the versions/{version} record, and logs the
 * allocation (one action-summary + one rule-effect entry, amendment §3.1).
 * The committer also sets 'commit_requested' when it queues the confirmed
 * action; a browser never writes that status (the pre-Phase-4
 * buildCommitRequestFields path was rules-legal under the Phase 1 fence
 * and contract-wrong against the brief — removed, not deprecated).
 * ==========================================================================
 */

import { sha256Hex } from "@/lib/sim/canonical";

import type { AllocatableStat } from "./stats";
import { sumPoints, validateAllocation, type AllocationValues } from "./validation";

/**
 * The allocation draft hash, over exactly the input the Phase 1 template
 * hashes for the empty draft ({ allocations: {}, spentPoints: null } ->
 * EMPTY_DRAFT_HASH in lib/sim/template.ts). Computed with the sim layer's
 * canonical module directly (P4-K15: the Phase 2 pure-TS
 * lib/sim/canonical.ts is isomorphic, so the browser port that used to
 * live in this module is deleted; the golden-vector test in
 * validation.test.ts remains the equivalence pin — browser draft-hash ==
 * fabric hash, which is what P4-G1/P4-G2 bind to).
 */
export function computeDraftHash(
  allocations: Record<string, number>,
  spentPoints: number | null
): string {
  return sha256Hex({ allocations, spentPoints });
}

/** Allocation control-doc lifecycle, per Phase 1 brief §1.6. */
export type AllocationStatus =
  | "not_started"
  | "draft"
  | "commit_requested"
  | "committed"
  | "superseded";

/** Read shape of `sim_stat_allocations/{cityId}` as created by lazy creation. */
export interface SimStatAllocationsDoc {
  cityId: string;
  status: AllocationStatus;
  baselineHash: string;
  baselineStats: Record<string, unknown>;
  pointBudget: number;
  allocations: Partial<Record<AllocatableStat, number>>;
  spentPoints: number | null;
  draftVersion: number;
  draftHash: string;
  authorUid: string | null;
  commitActionId: string | null;
  committedSeq: number | null;
  committedByUid: string | null;
  createdAt: unknown;
  updatedAt: unknown;
}

/**
 * The exact key set the Phase 1 rules fence allows an owner draft update to
 * touch (firestore.rules: diff(resource.data).affectedKeys().hasOnly([...])).
 * `updatedAt` is in the fence but is stamped by the save call with
 * serverTimestamp() — the builders below return the other six.
 */
export const DRAFT_WRITABLE_FIELDS = [
  "allocations",
  "spentPoints",
  "draftVersion",
  "draftHash",
  "authorUid",
  "status",
  "updatedAt",
] as const;

export interface DraftSaveFields {
  allocations: AllocationValues;
  spentPoints: number;
  draftVersion: number;
  draftHash: string;
  authorUid: string;
  /** The only status a browser may ever write (P4-K14 narrowing). */
  status: "draft";
}

export interface BuildDraftOptions {
  values: AllocationValues;
  authorUid: string;
  /** The doc's current draftVersion (0 on a fresh, never-drafted doc). */
  previousDraftVersion: number;
  /** computeDraftHash(values, sum) — injected so this builder stays sync/pure. */
  draftHash: string;
}

/** Fields for a draft save (status -> 'draft'). Add updatedAt at write time. */
export function buildDraftSaveFields(options: BuildDraftOptions): DraftSaveFields {
  // Draft saves are free-form about the SUM (drafts may be revised freely
  // before commit, R-35) but never about keys/bounds/integers: a draft the
  // fabric could never accept is refused here, at the preview layer.
  const issues = validateAllocation(options.values);
  if (issues.length > 0) {
    throw new Error(
      `Invalid allocation draft: ${issues.map((i) => i.message).join(" ")}`
    );
  }
  return {
    allocations: { ...options.values },
    spentPoints: sumPoints(options.values),
    draftVersion: options.previousDraftVersion + 1,
    draftHash: options.draftHash,
    authorUid: options.authorUid,
    status: "draft",
  };
}

/**
 * Shape for `sim_stat_allocations/{cityId}/versions/{version}` — immutable
 * snapshot records. Rules: create is fabric-committer-only since the
 * P4-K14 narrowing (the Phase 1 owner-create clause is removed); update
 * is denied to everyone.
 *
 * VERSIONS (brief §1.2): the first version doc is written by the R-35
 * handler inside the allocation commit transaction — NOT at lazy
 * creation, not on any draft save, and never by a browser. This builder
 * remains the shared shape definition: the handler's version doc carries
 * exactly these fields plus `cityId` (the §12.4 versions-by-cityId +
 * commitSeq index query reads it) and `createdAt` (committer-stamped).
 * `previewHash` / `commitSeq` are null here because a client-side
 * snapshot is pre-commit by definition; the committed record carries
 * both (see the handler for how each is bound).
 */
export interface AllocationVersionFields {
  source: "first_login" | "reallocation_event";
  allocations: AllocationValues;
  spentPoints: number;
  draftVersion: number;
  draftHash: string;
  authorUid: string;
  previewHash: string | null;
  commitSeq: number | null;
}

export function buildVersionSnapshotFields(options: {
  values: AllocationValues;
  authorUid: string;
  draftVersion: number;
  draftHash: string;
  source?: AllocationVersionFields["source"];
}): AllocationVersionFields {
  return {
    source: options.source ?? "first_login",
    allocations: { ...options.values },
    spentPoints: sumPoints(options.values),
    draftVersion: options.draftVersion,
    draftHash: options.draftHash,
    authorUid: options.authorUid,
    previewHash: null,
    commitSeq: null,
  };
}
