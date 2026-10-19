/**
 * Browser-side Firestore writes for allocation drafts.
 *
 * These are the ONLY writes this module performs, and both go through the
 * Phase 1 rules' owner draft fence on `sim_stat_allocations/{cityId}`:
 * draft-field keys only, `updatedAt` stamped with serverTimestamp(), and
 * the fence-protected fields (baselineHash, baselineStats, pointBudget,
 * commitActionId, committedSeq, committedByUid) never sent.
 *
 * ==========================================================================
 * PHASE 4 INTEGRATION POINT — COMMIT
 * ==========================================================================
 * requestAllocationCommit() ends at status 'commit_requested'. Phase 4's
 * fabric turns that request into the R-35 Resolution Event (validation
 * re-run server-side, sim_cities stats write, committed fields, versions
 * record, Log entries). Until Phase 4 wires that intake, a commit request
 * is a recorded request and nothing more — the UI copy says exactly that.
 * ==========================================================================
 */

import { doc, serverTimestamp, updateDoc } from "firebase/firestore";

import { getClientDb } from "@/lib/firebase";

import { computeDraftHash } from "./canonical";
import {
  buildCommitRequestFields,
  buildDraftSaveFields,
  type DraftSaveFields,
} from "./draft";
import { isCommittable, sumPoints, type AllocationValues } from "./validation";

async function writeDraftFields(
  cityId: string,
  fields: DraftSaveFields
): Promise<void> {
  const db = getClientDb();
  await updateDoc(doc(db, "sim_stat_allocations", cityId), {
    ...fields,
    updatedAt: serverTimestamp(),
  });
}

/**
 * Save the working draft. Drafts may be saved at any sum (R-35: drafts are
 * revised freely before commit) but values must be integers in bounds —
 * buildDraftSaveFields throws otherwise.
 */
export async function saveAllocationDraft(args: {
  cityId: string;
  values: AllocationValues;
  authorUid: string;
  previousDraftVersion: number;
}): Promise<DraftSaveFields> {
  const draftHash = await computeDraftHash(
    { ...args.values },
    sumPoints(args.values)
  );
  const fields = buildDraftSaveFields({
    values: args.values,
    authorUid: args.authorUid,
    previousDraftVersion: args.previousDraftVersion,
    draftHash,
  });
  await writeDraftFields(args.cityId, fields);
  return fields;
}

/**
 * Request the one-time allocation commit. Refuses (throws) unless the
 * allocation is committable — sum exactly POINT_BUDGET, all values integer
 * and in bounds. On success the doc sits at 'commit_requested' for the
 * Phase 4 fabric to resolve (see header).
 */
export async function requestAllocationCommit(args: {
  cityId: string;
  values: AllocationValues;
  authorUid: string;
  previousDraftVersion: number;
}): Promise<DraftSaveFields> {
  if (!isCommittable(args.values)) {
    throw new Error(
      "Allocation is not committable: it must spend exactly the pool with every value in bounds."
    );
  }
  const draftHash = await computeDraftHash(
    { ...args.values },
    sumPoints(args.values)
  );
  const fields = buildCommitRequestFields({
    values: args.values,
    authorUid: args.authorUid,
    previousDraftVersion: args.previousDraftVersion,
    draftHash,
  });
  await writeDraftFields(args.cityId, fields);
  return fields;
}
