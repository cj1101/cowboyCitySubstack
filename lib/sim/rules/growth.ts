/**
 * Growth — R-36 capacity growth + the growth audit surface (Phase 4
 * brief §5, step 10).
 *
 * R-36 in one paragraph (spec v2 §3.6, brief §5.2): a city owner
 * starts a CAPACITY PROJECT naming one of the eight allocatable
 * indices. The project resolves through the R-05 project mechanics —
 * the phase arithmetic here is Catalogue I's own exported functions
 * (`phaseCostRubars`, `paidTowardCurrentPhase`), so the numbers can
 * never diverge from the spine it composes with: phase cost =
 * recorded budget ÷ work units, treasury-paid under budget-class
 * discipline (a part-paid phase does not complete; the shortfall is
 * logged). `workUnitsRequired` derives ONCE, at start, from the named
 * index's CURRENT value (bands 1/2/3/4 below) and is frozen on the
 * record — a standing project never resizes because the index moved
 * meanwhile. On completion, inside the completing Resolution Event:
 * the named index +2, clamped at 100, and no other stat moves. The
 * completion entry carries the city's running index-sum.
 *
 * R-38's hook itself lives in Catalogue I (structures.ts completion
 * dispatch) — this module composes with it, never rebuilds it: R-38's
 * gains are growth the audit surface below counts, like every other
 * channel's.
 *
 * THE AUDIT SURFACE (P4-G7's identity, as pure functions): at any seq,
 *     index sum == 400 + Σ every growth `changes[]` line since allocation
 * recomputed from the standing Log — there is NO points ledger
 * anywhere in the system, and none is introduced here. Earned growth
 * is direct stat growth: never re-allocatable points, no respec path,
 * no second allocation commit. The audit counts EVERY change line on
 * the eight index fields for the city (growth channels move indices
 * up; damage and other lawful movers move them down — the identity is
 * over the Log's lines, not over a channel allowlist), which is what
 * makes the recompute exact rather than approximate.
 *
 * Records: capacity projects live in their own subcollection,
 * `sim_cities/{cityId}/projects/{projectId}` — not the structures
 * subcollection Catalogue I owns semantically (R-05's handlers cannot
 * be aimed at a capacity record, nor R-36's at a structure). Assembly
 * (Build Lead): register GROWTH_DESCRIPTORS into RULE_DESCRIPTORS —
 * "R-36" is unregistered in the base tree, so this is a pure addition
 * with no merge. Rules/index needs are specced in
 * workstreams/p4-chains-prep-report.md.
 *
 * Handler discipline (Step 0 contracts, binding): handlers are pure
 * (snapshot, action) → plan; domain refusals return rejection plans,
 * never throw; writes compose against the planned doc (F-02); index
 * deltas skip-and-log on a null index — the engine never invents a
 * value (an unallocated city is refused at start, in the open).
 */

import {
  docField,
  emptyPlan,
  snapshotDoc,
  withDocField,
  type LogEntryDraft,
  type ResolutionPlan,
  type SimAction,
} from "../state";
import { clampNumber } from "./arithmetic";
import {
  fieldChange,
  planWrite,
  plannedDoc,
  rejectedPlan,
  ruleEffectDraft,
  summaryDraft,
} from "./planHelpers";
import {
  checkCityAuthority,
  type DescriptorReadPlan,
  type HandlerContext,
  type ReadPlanSeeds,
  type RuleDescriptor,
} from "./registry";
import { paidTowardCurrentPhase, phaseCostRubars } from "./structures";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** The eight allocatable indices (spec §2.1) — the only stats R-36
 * may name, and the fields the audit identity sums. */
export const ALLOCATABLE_INDICES = [
  "spirit",
  "culture",
  "infrastructure",
  "stability",
  "law",
  "influence",
  "military",
  "defense",
] as const;

export type AllocatableIndex = (typeof ALLOCATABLE_INDICES)[number];

/** The Season-0 point pool every city allocated (the identity's
 * base). A city's indices sum to exactly this at allocation. */
export const INDEX_SUM_BASE_POINTS = 400;

/** R-36's completion gain and cap (spec §3.6). */
export const GROWTH_INDEX_DELTA = 2;
export const INDEX_CAP = 100;

/** The published growth-channel rule list (brief §5.3): R-36 here;
 * R-38 in Catalogue I; the incidental movers (structure completions
 * R-01–R-04, law mix shifts R-08, and R-21/R-23/R-22E in their own
 * phases). Documentation for readers of the audit — the audit itself
 * deliberately counts every index change line, whoever wrote it, so
 * the identity stays exact when a channel moves an index DOWN. */
export const GROWTH_CHANNEL_RULE_IDS = [
  "R-36",
  "R-38",
  "R-01",
  "R-02",
  "R-03",
  "R-04",
  "R-08",
  "R-21",
  "R-23",
  "R-22E",
] as const;

export function capacityProjectPath(cityId: string, projectId: string): string {
  return `sim_cities/${cityId}/projects/${projectId}`;
}

// ---------------------------------------------------------------------------
// Pure arithmetic — work-unit bands, index sums
// ---------------------------------------------------------------------------

/** R-36 work units by the index's CURRENT value at project start:
 * 1 for 0–24, 2 for 25–49, 3 for 50–74, 4 for 75–99. Null when the
 * index is unset (unallocated city) or already at the 100 cap — no
 * lawful project exists in either case, and the engine invents
 * neither a value nor a band. */
export function capacityWorkUnitsFor(currentValue: number | null): number | null {
  if (currentValue === null || !Number.isFinite(currentValue)) return null;
  const v = Math.floor(currentValue);
  if (v < 0 || v >= INDEX_CAP) return null;
  if (v <= 24) return 1;
  if (v <= 49) return 2;
  if (v <= 74) return 3;
  return 4;
}

/** Sum of the eight allocatable indices on a stats record, or null
 * when any index is unset (an unallocated city has no index sum —
 * null-honesty, never a fabricated 0 or 400). */
export function indexSumOfStats(stats: Record<string, unknown> | null | undefined): number | null {
  if (!stats) return null;
  let total = 0;
  for (const index of ALLOCATABLE_INDICES) {
    const value = stats[`stats.${index}`] ?? stats[index];
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    total += value;
  }
  return total;
}

// ---------------------------------------------------------------------------
// The growth audit surface (P4-G7) — pure recompute over Log entries
// ---------------------------------------------------------------------------

/** The structural minimum of a Log entry the audit reads. Both entry
 * drafts and committed entries satisfy it. */
export interface GrowthAuditEntry {
  seq?: number | null;
  cityId?: string | null;
  ruleIds?: string[];
  changes?: { field: string; before: unknown; after: unknown }[];
}

export interface GrowthAuditLine {
  seq: number | null;
  ruleIds: string[];
  index: AllocatableIndex;
  before: number;
  after: number;
  delta: number;
}

export interface GrowthAudit {
  cityId: string;
  basePoints: number;
  /** Σ (after − before) over every index change line since allocation. */
  growthTotal: number;
  /** basePoints + growthTotal — the index sum the Log proves. */
  computedIndexSum: number;
  perIndex: Record<string, number>;
  lines: GrowthAuditLine[];
}

/** Collect every growth change line for a city from a Log entry
 * stream (supplied in seq order, beginning at the allocation commit —
 * completeness of the stream is the caller's contract; the verifier
 * compares the result against the live city doc). A line is a change
 * on one of the eight `stats.<index>` fields with numeric before and
 * after, on an entry whose cityId is this city. */
export function collectGrowthLines(
  entries: readonly GrowthAuditEntry[],
  cityId: string
): GrowthAuditLine[] {
  const lines: GrowthAuditLine[] = [];
  for (const entry of entries) {
    if (entry.cityId !== cityId) continue;
    for (const change of entry.changes ?? []) {
      if (!change.field.startsWith("stats.")) continue;
      const index = change.field.slice("stats.".length) as AllocatableIndex;
      if (!(ALLOCATABLE_INDICES as readonly string[]).includes(index)) continue;
      if (typeof change.before !== "number" || typeof change.after !== "number") continue;
      lines.push({
        seq: entry.seq ?? null,
        ruleIds: entry.ruleIds ?? [],
        index,
        before: change.before,
        after: change.after,
        delta: change.after - change.before,
      });
    }
  }
  return lines;
}

/** The P4-G7 identity, recomputed: index sum at the head of the
 * supplied stream == 400 + Σ growth lines. */
export function auditIndexSum(
  entries: readonly GrowthAuditEntry[],
  cityId: string
): GrowthAudit {
  const lines = collectGrowthLines(entries, cityId);
  const perIndex: Record<string, number> = {};
  for (const index of ALLOCATABLE_INDICES) perIndex[index] = 0;
  let growthTotal = 0;
  for (const line of lines) {
    perIndex[line.index] += line.delta;
    growthTotal += line.delta;
  }
  return {
    cityId,
    basePoints: INDEX_SUM_BASE_POINTS,
    growthTotal,
    computedIndexSum: INDEX_SUM_BASE_POINTS + growthTotal,
    perIndex,
    lines,
  };
}

/** Cross-check the Log-recomputed sum against a city doc's live
 * stats (the verifier's F5 posture: the Log is the proof, the doc is
 * the claim). `actualIndexSum` is null when the doc's indices are
 * unset; `ok` is then false with the reason stated, never coerced. */
export function verifyIndexSumAgainstCity(
  entries: readonly GrowthAuditEntry[],
  cityId: string,
  cityDoc: Record<string, unknown> | null
): { ok: boolean; audit: GrowthAudit; actualIndexSum: number | null; note: string } {
  const audit = auditIndexSum(entries, cityId);
  const stats = (cityDoc?.stats ?? null) as Record<string, unknown> | null;
  const actualIndexSum = indexSumOfStats(stats);
  if (actualIndexSum === null) {
    return {
      ok: false,
      audit,
      actualIndexSum,
      note: `${cityId}'s indices are unset (unallocated city) — no index sum stands to verify.`,
    };
  }
  const ok = actualIndexSum === audit.computedIndexSum;
  return {
    ok,
    audit,
    actualIndexSum,
    note: ok
      ? `index sum ${actualIndexSum} == 400 + Σ growth lines (${audit.growthTotal}) over ${audit.lines.length} line(s) — the standing Log proves the standing sum.`
      : `MISMATCH: live index sum ${actualIndexSum} != 400 + Σ growth lines (${audit.computedIndexSum}) — a stat moved without a Log line, or a line is missing.`,
  };
}

// ---------------------------------------------------------------------------
// Shared handler helpers (local copies, the family-file pattern)
// ---------------------------------------------------------------------------

const sa = (action: SimAction): Record<string, unknown> =>
  (action.structuredAction ?? {}) as Record<string, unknown>;

const actionCityId = (action: SimAction): string =>
  (sa(action).cityId as string | undefined) ?? action.targetCityIds[0] ?? "";

const num = (doc: Record<string, unknown> | null, field: string): number | null => {
  const value = docField(doc, field);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

function actorCitations(
  plan: ResolutionPlan,
  ctx: HandlerContext,
  resolutionId: string
): void {
  const citations = ctx.citations;
  for (const id of citations.resolutionIds ?? []) plan.readRefKeys.push(`resolution:${id}`);
  for (const id of citations.pendingIds ?? []) plan.readRefKeys.push(`pending:${id}`);
  for (const path of citations.recordPaths ?? []) plan.readRefKeys.push(`record:${path}`);
  for (const seq of citations.seqs ?? []) plan.readRefKeys.push(`seq:${seq}`);
  plan.readRefKeys.push(`resolution:${resolutionId}`);
}

/** Drop record claims the folded plan does not actually perform
 * (the Catalogue I discipline — validatePlan reconciles claims
 * against writes). */
function pruneRecordClaims(plan: ResolutionPlan): void {
  const ops = new Map(plan.writes.map((w) => [w.path, w.op]));
  for (const entry of plan.entries) {
    const created = new Set<string>();
    const updated = new Set<string>();
    for (const path of [...entry.recordsCreated, ...entry.recordsUpdated]) {
      const op = ops.get(path);
      if (op === "create") created.add(path);
      else if (op !== undefined) updated.add(path);
    }
    entry.recordsCreated = [...created];
    entry.recordsUpdated = [...updated];
  }
}

/** Growth authority: the city owner — or, for the shared city, the
 * sitting mayor alone (CJ round 3; same posture as chains/allocation
 * until Phase 7's terms data lands). */
function requireGrowthAuthority(
  ctx: HandlerContext,
  descriptorId: string
): ResolutionPlan | null {
  const cityId = actionCityId(ctx.action);
  const city = snapshotDoc(ctx.snapshot, `sim_cities/${cityId}`);
  if (city?.isSharedCity === true) {
    const actor = ctx.action.actor;
    if (actor.type !== "shared-office" || actor.office !== "mayor" || !actor.memberId) {
      return rejectedPlan(
        descriptorId,
        "AUTHORITY_REVOKED",
        ["R-36"],
        `${cityId} is the shared city: its capacity projects are the sitting mayor's act alone (CJ round 3), and this actor is not a shared-office mayor actor.`
      );
    }
    return null;
  }
  const verdict = checkCityAuthority(ctx.snapshot, cityId, ctx.action.actor);
  if (!verdict.ok) {
    return rejectedPlan(
      descriptorId,
      "AUTHORITY_REVOKED",
      ["R-36"],
      `Authority revoked for ${ctx.action.actor.memberId ?? "actor"} over ${cityId}: ${verdict.reason}.`
    );
  }
  return null;
}

function capacityReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const params = (seeds.action.structuredAction ?? {}) as Record<string, unknown>;
  const cityId =
    (typeof params.cityId === "string" ? params.cityId : undefined) ??
    seeds.action.targetCityIds[0] ??
    "";
  const projectId = typeof params.projectId === "string" ? params.projectId : "";
  if (!cityId || !projectId) return {};
  return { paths: [capacityProjectPath(cityId, projectId)] };
}

// ---------------------------------------------------------------------------
// R-36 — start / advance a capacity project (one handler, the R-05
// shape: start creates the record and may pay toward phase 1 in the
// same event; advance continues a standing record).
// ---------------------------------------------------------------------------

function capacityProjectHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "R-36";
  const ruleIds = ["R-36"];
  const denied = requireGrowthAuthority(ctx, descriptorId);
  if (denied) return denied;

  const params = sa(ctx.action);
  const cityId = actionCityId(ctx.action);
  const cityPath = `sim_cities/${cityId}`;
  const city = snapshotDoc(ctx.snapshot, cityPath);
  if (!city) {
    return rejectedPlan(descriptorId, "NO_CITY", ruleIds, `City ${cityId} does not stand.`);
  }
  const isStart = ctx.action.actionType === "start_capacity_project";
  const projectId =
    typeof params.projectId === "string" && params.projectId.length > 0
      ? params.projectId
      : `capacity_${ctx.resolutionId}`;
  if (projectId.includes("/") || projectId.includes(".")) {
    return rejectedPlan(
      descriptorId,
      "INVALID_PROJECT_ID",
      ruleIds,
      `Project id "${projectId}" is not a lawful record id (no path separators).`
    );
  }
  const pPath = capacityProjectPath(cityId, projectId);
  const existing = snapshotDoc(ctx.snapshot, pPath);
  const actor = ctx.action.actor;
  const treasury = num(city, "stats.treasuryRubars") ?? 0;

  const plan = emptyPlan(descriptorId);
  let project: Record<string, unknown>;
  let created = false;
  let creationInfo: {
    capacityIndex: string;
    currentValue: number;
    required: number;
    total: number;
    proposalFlag: string;
  } | null = null;

  if (!existing) {
    if (!isStart) {
      return rejectedPlan(
        descriptorId,
        "NO_PROJECT",
        ruleIds,
        `No capacity project stands at ${pPath} — advance names a standing project; start_capacity_project creates one.`
      );
    }
    const capacityIndex = typeof params.capacityIndex === "string" ? params.capacityIndex : "";
    if (!(ALLOCATABLE_INDICES as readonly string[]).includes(capacityIndex)) {
      return rejectedPlan(
        descriptorId,
        "UNKNOWN_INDEX",
        ruleIds,
        `"${capacityIndex || "(none)"}" is not one of the eight allocatable indices (${ALLOCATABLE_INDICES.join(", ")}) — stocks and derived counts are never capacity targets.`
      );
    }
    const currentValue = num(city, `stats.${capacityIndex}`);
    if (currentValue === null) {
      return rejectedPlan(
        descriptorId,
        "UNALLOCATED_INDEX",
        ruleIds,
        `${cityId}'s ${capacityIndex} is unset (null) — the city has not allocated, and the engine never invents an index value to band a project against. Allocate first; the refusal is the honest preview.`
      );
    }
    const required = capacityWorkUnitsFor(currentValue);
    if (required === null) {
      return rejectedPlan(
        descriptorId,
        "INDEX_AT_CAP",
        ruleIds,
        `${cityId}'s ${capacityIndex} already stands at ${currentValue} — at the 100 cap there is nothing for a capacity project to grow.`
      );
    }
    const total = params.totalBudgetRubars;
    if (typeof total !== "number" || !Number.isInteger(total) || total <= 0) {
      return rejectedPlan(
        descriptorId,
        "INVALID_BUDGET",
        ruleIds,
        "A capacity project records a positive whole-Rubar budget at proposal (totalBudgetRubars) — phase costs derive from it under the R-05 formula."
      );
    }
    project = {
      schemaVersion: 2,
      kind: "capacity-project",
      cityId,
      capacityIndex,
      name:
        typeof params.projectName === "string" && params.projectName.length > 0
          ? params.projectName
          : `${capacityIndex} capacity project`,
      status: "planned",
      workUnitsRequired: required,
      workUnitsDone: 0,
      totalBudgetRubars: total,
      paidRubars: 0,
      indexValueAtStart: currentValue,
      createdByResolutionId: ctx.resolutionId,
      createdAt: null,
      stateVersion: 1,
      lastChangedSeq: null,
      lastResolutionId: null,
    };
    created = true;
    // The Judge's-proposal flag (§4.3 convention), at proposal: a
    // budget over 10% of the treasury is flagged in the open, on the
    // creation entry — a flag, never a refusal.
    creationInfo = {
      capacityIndex,
      currentValue,
      required,
      total,
      proposalFlag:
        total > treasury * 0.1
          ? ` Flag: the recorded budget (${total} R) exceeds 10% of ${cityId}'s treasury (${treasury} R).`
          : "",
    };
  } else {
    if (isStart) {
      return rejectedPlan(
        descriptorId,
        "PROJECT_EXISTS",
        ruleIds,
        `A capacity project already stands at ${pPath} — start never rewrites a standing project's recorded terms; advance it, or name a new projectId.`
      );
    }
    project = existing;
    const status = project.status as string | undefined;
    if (status === "complete") {
      return rejectedPlan(descriptorId, "NOTHING_TO_ADVANCE", ruleIds, `Capacity project ${projectId} in ${cityId} already stands complete; its +${GROWTH_INDEX_DELTA} is banked history.`);
    }
    if (status !== "planned" && status !== "under-construction") {
      return rejectedPlan(descriptorId, "INVALID_STATUS", ruleIds, `Capacity project ${projectId} has status ${status ?? "unset"} — not a project state R-36 can advance.`);
    }
  }

  const capacityIndex = project.capacityIndex as AllocatableIndex;
  const required = num(project, "workUnitsRequired");
  const total = num(project, "totalBudgetRubars");
  if (required === null || total === null || total < 0) {
    return rejectedPlan(
      descriptorId,
      "MALFORMED_PROJECT",
      ruleIds,
      `Capacity project ${projectId} lacks a lawful project basis (workUnitsRequired and totalBudgetRubars on the record). The record must be repaired by its creation flow — the engine invents neither.`
    );
  }
  const done = num(project, "workUnitsDone") ?? 0;
  const paid = num(project, "paidRubars") ?? 0;
  const status = project.status as string;

  // R-05 phase mechanics, via Catalogue I's own arithmetic: phase
  // cost = budget ÷ work units (last phase takes the remainder); pay
  // up to the treasury's balance; a part-paid phase does NOT complete
  // and the shortfall is logged (budget class, §2.4).
  const phase = Math.min(done + 1, required);
  const phaseCost = phaseCostRubars(total, required, phase);
  const due = Math.max(0, phaseCost - paidTowardCurrentPhase(project));
  const pay = Math.min(due, treasury);
  const shortfall = due - pay;
  const phaseComplete = pay === due;
  const newDone = phaseComplete ? done + 1 : done;
  const completes = phaseComplete && newDone >= required;

  const changes: LogEntryDraft["changes"] = [];
  if (pay > 0) {
    const cityNow = plannedDoc(plan, ctx.snapshot, cityPath) ?? city;
    planWrite(plan, ctx.snapshot, cityPath, withDocField(cityNow, "stats.treasuryRubars", treasury - pay), "state", ["stats.treasuryRubars"]);
    changes.push(
      fieldChange("stats.treasuryRubars", treasury, treasury - pay, `R-36 phase ${phase} of ${required} payment toward capacity project ${projectId} (phase cost ${phaseCost} R, ${paidTowardCurrentPhase(project)} R already toward this phase)`)
    );
  }

  // Project-record change lines. F-02 discipline: every line carries
  // SNAPSHOT-before → PLAN-FINAL-after. A record born in this event
  // has snapshot-before null, so its lines (which ride the creation
  // entry) are null → born value; a standing record's lines ride the
  // advance entry.
  const projectLines: LogEntryDraft["changes"] = [];
  let after: Record<string, unknown> = plannedDoc(plan, ctx.snapshot, pPath) ?? { ...project };
  const projectChangedFields: string[] = [];
  const afterStatus = completes ? "complete" : status === "planned" ? "under-construction" : status;
  if (created) {
    after = { ...project, status: afterStatus };
    projectChangedFields.push("status", "workUnitsRequired", "totalBudgetRubars", "capacityIndex");
    projectLines.push(
      fieldChange(`projects/${projectId}.status`, null, afterStatus, `R-36: capacity project recorded — ${capacityIndex} stands at ${creationInfo?.currentValue}, banding ${required} work unit(s) (bands 1/2/3/4 at 0–24/25–49/50–74/75–99); the band is frozen on the record at start`),
      fieldChange(`projects/${projectId}.capacityIndex`, null, capacityIndex, "R-36: the named index — the project's whole subject"),
      fieldChange(`projects/${projectId}.workUnitsRequired`, null, required, "R-36: work units banded from the index's value at start"),
      fieldChange(`projects/${projectId}.totalBudgetRubars`, null, total, "R-36: the proposal's recorded budget — phase costs derive from it (budget ÷ work units, last phase takes the remainder)")
    );
  } else if (afterStatus !== status) {
    after = withDocField(after, "status", afterStatus);
    projectChangedFields.push("status");
    projectLines.push(fieldChange(`projects/${projectId}.status`, status, afterStatus, completes ? "R-36: final phase paid — the capacity project completes inside this Resolution Event" : "R-36: break ground — planned → under-construction"));
  }
  if (newDone !== done) {
    after = withDocField(after, "workUnitsDone", newDone);
    projectChangedFields.push("workUnitsDone");
    projectLines.push(fieldChange(`projects/${projectId}.workUnitsDone`, created ? null : done, newDone, `R-36: phase ${phase} fully funded — work unit ${newDone} of ${required} done`));
  }
  if (pay > 0) {
    after = withDocField(after, "paidRubars", paid + pay);
    projectChangedFields.push("paidRubars");
    projectLines.push(fieldChange(`projects/${projectId}.paidRubars`, created ? null : paid, paid + pay, "R-36: cumulative phase payments (the audit field)"));
  }
  planWrite(plan, ctx.snapshot, pPath, after, "state", [...new Set(projectChangedFields)]);

  if (created && creationInfo) {
    plan.entries.push(
      ruleEffectDraft({
        actor,
        cityId,
        cityIds: [cityId],
        ruleIds,
        changes: projectLines,
        recordsCreated: [pPath],
        summaryText:
          `R-36: a capacity project for ${cityId}'s ${creationInfo.capacityIndex} is proposed and recorded: ${creationInfo.required} work unit(s), budget ${creationInfo.total} R, completion grants ${creationInfo.capacityIndex} +${GROWTH_INDEX_DELTA} (clamped at ${INDEX_CAP}) inside the completing event and moves no other stat.${creationInfo.proposalFlag}`,
      })
    );
  }

  const phaseLabel = created ? "propose + break ground" : status === "planned" ? "break ground" : "continue work";
  plan.entries.push(
    ruleEffectDraft({
      actor,
      cityId,
      cityIds: [cityId],
      ruleIds,
      changes: created ? changes : [...changes, ...projectLines],
      recordsUpdated: created ? [cityPath] : [pPath, cityPath],
      summaryText:
        `R-36 ${phaseLabel}: capacity project ${projectId} (${capacityIndex}) in ${cityId}, phase ${phase} of ${required} (cost ${phaseCost} R; paid ${pay} R this event` +
        (shortfall > 0 ? `; SHORTFALL ${shortfall} R — the phase is partially funded and does not complete (budget class, §2.4)` : "") +
        `). workUnitsDone ${done} → ${newDone} of ${required}.`,
      major: completes,
    })
  );

  if (completes) {
    // The growth itself, inside the completing Resolution Event and
    // nowhere else: the named index +2, clamped at 100; no other
    // stat moves. The entry carries the running index-sum, computed
    // from the PLANNED city doc after the delta.
    const cityPlanned = plannedDoc(plan, ctx.snapshot, cityPath) ?? city;
    const before = num(cityPlanned, `stats.${capacityIndex}`);
    const completionChanges: LogEntryDraft["changes"] = [];
    let sumNote: string;
    if (before === null) {
      sumNote = `${capacityIndex} stands unset at completion — the +${GROWTH_INDEX_DELTA} is skipped and logged, never invented (null-honesty).`;
    } else {
      const afterValue = clampNumber(before + GROWTH_INDEX_DELTA, 0, INDEX_CAP);
      planWrite(plan, ctx.snapshot, cityPath, withDocField(cityPlanned, `stats.${capacityIndex}`, afterValue), "state", [`stats.${capacityIndex}`]);
      completionChanges.push(
        fieldChange(`stats.${capacityIndex}`, before, afterValue, `R-36 completion: ${capacityIndex} +${GROWTH_INDEX_DELTA}${before + GROWTH_INDEX_DELTA > INDEX_CAP ? " (clamped at the 100 cap)" : ""} — the project's whole yield, banked as direct stat growth (never re-allocatable points)`)
      );
      const statsAfter = (plannedDoc(plan, ctx.snapshot, cityPath)?.stats ?? {}) as Record<string, unknown>;
      const runningSum = indexSumOfStats(statsAfter);
      sumNote =
        runningSum !== null
          ? `${cityId}'s running index-sum is now ${runningSum} — the audit identity: 400 (Season-0 base) + Σ every growth changes[] line since allocation, recomputed from the standing Log; no points ledger exists.`
          : `${cityId}'s running index-sum cannot be stated: an index stands unset — the audit reports the gap, never a fabricated total.`;
    }
    plan.entries.push(
      ruleEffectDraft({
        actor,
        cityId,
        cityIds: [cityId],
        ruleIds,
        changes: completionChanges,
        recordsUpdated: [cityPath],
        summaryText: `R-36 completion: capacity project ${projectId} completes in ${cityId} — ${capacityIndex} +${GROWTH_INDEX_DELTA} lands inside this same Resolution Event. ${sumNote}`,
        major: true,
      })
    );
  }

  plan.entries.push(
    summaryDraft({
      actor,
      actionId: ctx.action.actionId,
      actionText: ctx.action.actionText,
      classification: {
        verb: isStart ? "start-capacity-project" : "advance-capacity-project",
        scope: "city",
        ruleIds,
        unruled: false,
      },
      cityId,
      cityIds: [cityId],
      ruleIds,
      summaryText: completes
        ? `Capacity project ${projectId} completed in ${cityId}: ${capacityIndex} +${GROWTH_INDEX_DELTA}; total paid ${paid + pay} R of ${total} R budget.`
        : `Capacity project ${projectId} (${capacityIndex}) in ${cityId}: ${phaseLabel}, phase ${phase} of ${required}${shortfall > 0 ? `, shortfall ${shortfall} R logged` : ""}.`,
      major: completes,
    })
  );
  pruneRecordClaims(plan);
  actorCitations(plan, ctx, ctx.resolutionId);
  return plan;
}

// ---------------------------------------------------------------------------
// Descriptors (Lead assembly: pure addition — R-36 is unregistered)
// ---------------------------------------------------------------------------

export const GROWTH_DESCRIPTORS: Record<string, RuleDescriptor> = {
  "R-36": {
    id: "R-36",
    actionKinds: ["start_capacity_project", "advance_capacity_project"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: {
      start_capacity_project: capacityProjectHandler,
      advance_capacity_project: capacityProjectHandler,
    },
    readPlan: capacityReadPlan,
    summary:
      "Capacity growth: an owner starts a project naming one of the eight allocatable indices; work units band 1/2/3/4 by the index's current value (frozen on the record at start); phases are treasury-paid under R-05 mechanics and budget-class discipline; completion lands the index +2 (clamped at 100) inside the completing Resolution Event with the city's running index-sum on the entry. The audit identity (400 + Σ growth Log lines) is recomputed from the standing Log by this module's audit surface — no points ledger exists.",
  },
};
