/**
 * Small builders shared by rule handlers, the resolver, and the pending
 * machinery, so every plan is assembled the same way (brief §5.3): rule
 * entries first, the summary entry last and marked `summary: true`.
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

/** Register a doc write on the plan. `afterDoc` null means delete; the
 * op (create/update/delete) is derived against the snapshot so handlers
 * cannot mislabel it. */
export function planWrite(
  plan: ResolutionPlan,
  snapshot: SimSnapshot,
  path: string,
  afterDoc: Record<string, unknown> | null,
  recordClass: "state" | "pending",
  changedFields: string[]
): void {
  const before = snapshotDoc(snapshot, path);
  const existing = plan.writes.findIndex((w) => w.path === path);
  const write = {
    path,
    op: (afterDoc === null ? "delete" : before === null ? "create" : "update") as
      | "create"
      | "update"
      | "delete",
    recordClass,
    ...(afterDoc === null ? {} : { afterDoc }),
    changedFields,
  };
  if (existing >= 0) plan.writes[existing] = write;
  else plan.writes.push(write);
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
