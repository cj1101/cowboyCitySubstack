/**
 * Small builders shared by rule handlers, the resolver, and the pending
 * machinery, so every plan is assembled the same way (brief §5.3): rule
 * entries first, the summary entry last and marked `summary: true`.
 *
 * Write composition (Phase 4 Step 0, F-02): a plan holds AT MOST ONE
 * write per path, and `planWrite` FOLDS — a second write to a path
 * already in the plan replaces the stored after-state with the new one
 * and unions the changed-field sets. Folding is only sound if callers
 * compute each new after-state against the PLANNED doc, never against
 * the original snapshot: use `plannedDoc` for reads inside a handler
 * that may write the same doc twice, or `planMutate` to fold a mutation
 * in one step. (The pre-Step-0 `planWrite` replaced silently while
 * callers computed from the snapshot, so composite events lost all but
 * the last write to a doc while their `changes[]` claimed every one —
 * the Log/state bijection breach Nadia's F-02 names.) `validatePlan`
 * reconciles `changes[]` against the folded writes so a handler that
 * still computes from the snapshot fails loudly at resolve time.
 */

import { emptyPlan, snapshotDoc, type LogEntryDraft, type ResolutionPlan, type SimActor, type SimSnapshot } from "../state";

export function ruleEffectDraft(partial: Partial<LogEntryDraft> & { summaryText: string }): LogEntryDraft {
  return {
    kind: "rule-effect",
    summary: false,
    actor: partial.actor as SimActor,
    actionId: null,
    actionText: null,
    classification: null,
    cityId: null,
    cityIds: [],
    ruleIds: [],
    changes: [],
    spilloverFromSeq: null,
    causedBySeq: null,
    correctsSeq: null,
    recordsCreated: [],
    recordsUpdated: [],
    legal: null,
    chronicleDraftId: null,
    major: false,
    visibility: "public",
    baseline: null,
    pendingId: null,
    generation: null,
    ...partial,
  };
}

export function summaryDraft(partial: Partial<LogEntryDraft> & { summaryText: string; actor: SimActor }): LogEntryDraft {
  return ruleEffectDraft({ ...partial, kind: "action-summary", summary: true });
}

/** The doc a handler should read when it may write `path` again: the
 * plan's pending after-state if this plan already writes the path
 * (null when the planned write is a delete), else the snapshot doc.
 * Every read that feeds a `planWrite` for the same path MUST come from
 * here — reading the snapshot instead is the F-02 bug. */
export function plannedDoc(
  plan: ResolutionPlan,
  snapshot: SimSnapshot,
  path: string
): Record<string, unknown> | null {
  const write = plan.writes.find((w) => w.path === path);
  if (write) return write.op === "delete" ? null : (write.afterDoc ?? null);
  return snapshotDoc(snapshot, path);
}

/** Register a doc write on the plan, FOLDING into any write already
 * planned for the path (F-02): the stored after-state becomes
 * `afterDoc` — which the caller computed against `plannedDoc` — and
 * the changed-field sets union. `afterDoc` null means delete; the op
 * (create/update/delete) is derived from the NET effect against the
 * snapshot so handlers cannot mislabel it. One write per path, always:
 * the committer's write set and the entries' `changes[]` therefore
 * describe the same event (reconciled by `validatePlan`). */
export function planWrite(
  plan: ResolutionPlan,
  snapshot: SimSnapshot,
  path: string,
  afterDoc: Record<string, unknown> | null,
  recordClass: "state" | "pending",
  changedFields: string[]
): void {
  const before = snapshotDoc(snapshot, path);
  const existingIdx = plan.writes.findIndex((w) => w.path === path);
  const existing = existingIdx >= 0 ? plan.writes[existingIdx] : undefined;
  const write = {
    path,
    op: (afterDoc === null ? "delete" : before === null ? "create" : "update") as
      | "create"
      | "update"
      | "delete",
    recordClass: existing?.recordClass ?? recordClass,
    ...(afterDoc === null ? {} : { afterDoc }),
    changedFields: existing
      ? [...new Set([...existing.changedFields, ...changedFields])]
      : [...changedFields],
  };
  if (existingIdx >= 0) plan.writes[existingIdx] = write;
  else plan.writes.push(write);
}

/** Fold a mutation into the plan's write for `path` in one step: the
 * mutator receives the PLANNED doc (see `plannedDoc`) and returns the
 * new after-state (null = delete). Returns the new after-state. */
export function planMutate(
  plan: ResolutionPlan,
  snapshot: SimSnapshot,
  path: string,
  recordClass: "state" | "pending",
  changedFields: string[],
  mutate: (current: Record<string, unknown> | null) => Record<string, unknown> | null
): Record<string, unknown> | null {
  const next = mutate(plannedDoc(plan, snapshot, path));
  planWrite(plan, snapshot, path, next, recordClass, changedFields);
  return next;
}

export function fieldChange(
  field: string,
  before: unknown,
  after: unknown,
  formula: string
): { field: string; before: unknown; after: unknown; formula: string } {
  return { field, before, after, formula };
}

export function rejectedPlan(
  descriptorId: string | null,
  code: string,
  ruleIds: string[],
  summaryText: string
): ResolutionPlan {
  const plan = emptyPlan(descriptorId);
  plan.outcome = "rejected";
  plan.rejection = { code, ruleIds, summaryText };
  return plan;
}
