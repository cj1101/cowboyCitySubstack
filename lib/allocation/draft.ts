/**
 * The `sim_stat_allocations/{cityId}` draft-save shape, as landed in Phase 1.
 *
 * The Phase 1 Firestore rules (firestore.rules, match
 * /sim_stat_allocations/{cityId}) give the city owner exactly one browser
 * write path: an update that —
 *
 * - starts from status 'not_started' or 'draft',
 * - lands on status 'draft' or 'commit_requested',
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
 * PHASE 4 INTEGRATION POINT — COMMIT
 * ==========================================================================
 * Requesting a commit from the browser sets status 'commit_requested' with
 * the final draft fields (buildCommitRequestFields). That is ALL a browser
 * may do. The commit itself is a fabric Resolution Event (R-35): Phase 4's
 * intake/dispatcher picks up the commit request (or an allocation action),
 * re-validates keys/bounds/exact-sum server-side, and the committer — in
 * one transaction — writes the eight values into sim_cities/{cityId}.stats,
 * sets status 'committed' with commitActionId / committedSeq /
 * committedByUid, writes the versions/{version} record with its previewHash
 * and commitSeq, and logs the allocation (one action-summary + one
 * rule-effect entry, amendment §3.1). No client code writes those fields;
 * the rules fence makes it impossible, deliberately.
 * ==========================================================================
 */

import type { AllocatableStat } from "./stats";
import { sumPoints, validateAllocation, type AllocationValues } from "./validation";

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
  status: "draft" | "commit_requested";
}

export interface BuildDraftOptions {
  values: AllocationValues;
  authorUid: string;
  /** The doc's current draftVersion (0 on a fresh, never-drafted doc). */
  previousDraftVersion: number;
  /** computeDraftHash(values, sum) — injected so this builder stays sync/pure. */
  draftHash: string;
}

function buildFields(
  options: BuildDraftOptions,
  status: DraftSaveFields["status"]
): DraftSaveFields {
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
    status,
  };
}

/** Fields for a draft save (status -> 'draft'). Add updatedAt at write time. */
export function buildDraftSaveFields(options: BuildDraftOptions): DraftSaveFields {
  return buildFields(options, "draft");
}

/**
 * Fields for a commit request (status -> 'commit_requested'). The caller
 * must have already established isCommittable(values) — this builder throws
 * otherwise, so a commit request can never carry a non-committable draft.
 * The commit itself is the Phase 4 fabric Resolution Event (see header).
 */
export function buildCommitRequestFields(options: BuildDraftOptions): DraftSaveFields {
  const issues = validateAllocation(options.values, { requireExactSum: true });
  if (issues.length > 0) {
    throw new Error(
      `Allocation is not committable: ${issues.map((i) => i.message).join(" ")}`
    );
  }
  return buildFields(options, "commit_requested");
}

/**
 * Shape for `sim_stat_allocations/{cityId}/versions/{version}` — immutable
 * snapshot records. Rules (Phase 1): owner may create with
 * authorUid == their uid; update/delete denied to everyone.
 *
 * PHASE 4 INTEGRATION POINT — VERSIONS: per Phase 1 brief §1.6, the first
 * version doc is written at Phase 4 preview/commit time, NOT at lazy
 * creation and not on every draft save. `previewHash` and `commitSeq` stay
 * null on any pre-commit snapshot; the committing Resolution Event writes
 * the committed version with both set. This builder exists so the Phase 4
 * page wiring and the fabric share one shape definition.
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
