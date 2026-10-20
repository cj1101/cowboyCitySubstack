/**
 * The allocation commit ACTION (Phase 4, build-prep P4-K14 / brief §3.3).
 *
 * A Season-0 commit is an ordinary action through the play loop — kind
 * `allocate_season0` — never a browser status write. The browser's whole
 * role is: save the final map as the head draft (draftSave.ts), then
 * submit ONE `sim_actions` doc via the landed intake builder
 * (`buildActionDoc`, lib/sim/intake.ts), born `received` with every
 * lifecycle field null — exactly the shape the §9.4 create clause
 * admits. From there the fabric owns the loop: preview (commit-grade
 * validation re-run server-side by the R-35 handler in
 * lib/sim/rules/allocation.ts), the member's hash-bound confirmation on
 * the never-bind card (§2.3 — the binding act, not this submit), the
 * wake, and the commit transaction that writes the eight values into
 * `sim_cities/{cityId}.stats`, flips the allocation doc to `committed`,
 * writes the first versions record, and logs the city's first entries.
 *
 * The payload carries the final map itself plus the draft it commits
 * (`draftVersion` + `draftHash`, brief §3.3 step 1): the preview binds
 * to exactly what will commit, and the handler refuses a payload whose
 * draft reference no longer matches the saved draft (a newer draft
 * raced it — §3.4's stale discipline).
 *
 * Idempotency: the default clientRequestId names the draft version
 * being committed (`allocate-season0:{cityId}:v{draftVersion}`), and
 * intake derives the actionId from (actorUid, clientRequestId) — a
 * double-click or retry maps onto the same action doc, and the submit
 * helper below is a no-op when that doc already exists (TC-A04).
 */

import { doc, getDoc, setDoc } from "firebase/firestore";

import { getClientDb } from "@/lib/firebase";
import { buildActionDoc } from "@/lib/sim/intake";
import type { SimAction, SimActor } from "@/lib/sim/state";

import { computeDraftHash } from "./draft";
import {
  sumPoints,
  validateAllocation,
  type AllocationValues,
} from "./validation";

export const ALLOCATE_SEASON0_ACTION_KIND = "allocate_season0";

/** The `allocate_season0` payload (the action's structuredAction). */
export interface AllocationCommitPayload {
  cityId: string;
  /** The final map — all eight indices, final values (brief §3.3). */
  allocations: AllocationValues;
  /** The saved draft this commit commits (its post-save version). */
  draftVersion: number;
  /** computeDraftHash(allocations, 400) — the saved draft's hash. */
  draftHash: string;
}

/**
 * Build the commit payload for a committable map. Throws unless the map
 * passes commit-grade validation (draft grade + sum exactly the pool) —
 * a commit action can never carry a map the fabric would refuse; the
 * fabric re-validates regardless (the UI check is never the authority).
 */
export function buildAllocationCommitPayload(args: {
  cityId: string;
  values: AllocationValues;
  draftVersion: number;
}): AllocationCommitPayload {
  const issues = validateAllocation(args.values, { requireExactSum: true });
  if (issues.length > 0) {
    throw new Error(
      `Allocation is not committable: ${issues.map((i) => i.message).join(" ")}`
    );
  }
  return {
    cityId: args.cityId,
    allocations: { ...args.values },
    draftVersion: args.draftVersion,
    draftHash: computeDraftHash({ ...args.values }, sumPoints(args.values)),
  };
}

/** The member actor for a personal commit (shared-office acts are built
 * by the Town Hall surface, not this module — brief §3.1's mayor guard
 * is enforced by the handler against the actor it receives). */
export function memberActor(uid: string): SimActor {
  return {
    type: "member",
    memberId: uid,
    npcId: null,
    onBehalfOfMemberId: null,
    mandateId: null,
    mandateVersion: null,
    envelopeId: null,
  };
}

/**
 * Build the born-`received` action doc for an allocation commit (pure —
 * the write is submitAllocationCommitAction below). `now` is injected
 * so fixtures control the clock, per the intake builder's contract.
 */
export function buildAllocationCommitAction(args: {
  cityId: string;
  values: AllocationValues;
  authorUid: string;
  draftVersion: number;
  now: string;
  clientRequestId?: string;
}): { actionId: string; doc: SimAction; payload: AllocationCommitPayload } {
  const payload = buildAllocationCommitPayload({
    cityId: args.cityId,
    values: args.values,
    draftVersion: args.draftVersion,
  });
  const { actionId, doc } = buildActionDoc({
    actorUid: args.authorUid,
    clientRequestId:
      args.clientRequestId ??
      `allocate-season0:${args.cityId}:v${args.draftVersion}`,
    actor: memberActor(args.authorUid),
    actionType: ALLOCATE_SEASON0_ACTION_KIND,
    actionText:
      `Commit the Season-0 allocation for ${args.cityId} (draft v${args.draftVersion}): ` +
      "spend exactly 400 across the eight indices as final values. One-time; there is no respec.",
    structuredAction: { ...payload },
    targetCityIds: [args.cityId],
    source: "web",
    now: args.now,
  });
  return { actionId, doc, payload };
}

/**
 * Submit the commit action: create the `sim_actions` doc if it does not
 * already exist (an existing doc means this exact commit — same city,
 * same draft version, same author — was already submitted; return its id
 * without a second write). The browser writes NOTHING else: no status
 * flip on the allocation doc (the committer sets `commit_requested`
 * when it queues this action — P4-K14), no stats, no versions record.
 */
export async function submitAllocationCommitAction(args: {
  cityId: string;
  values: AllocationValues;
  authorUid: string;
  draftVersion: number;
  now?: string;
  clientRequestId?: string;
}): Promise<{ actionId: string; payload: AllocationCommitPayload }> {
  const built = buildAllocationCommitAction({
    cityId: args.cityId,
    values: args.values,
    authorUid: args.authorUid,
    draftVersion: args.draftVersion,
    now: args.now ?? new Date().toISOString(),
    clientRequestId: args.clientRequestId,
  });
  const db = getClientDb();
  const ref = doc(db, "sim_actions", built.actionId);
  const existing = await getDoc(ref);
  if (!existing.exists()) {
    await setDoc(ref, built.doc);
  }
  return { actionId: built.actionId, payload: built.payload };
}
