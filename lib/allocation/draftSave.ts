/**
 * Browser-side Firestore writes for allocation drafts.
 *
 * This is the module's ONLY draft write, and it goes through the rules'
 * owner draft fence on `sim_stat_allocations/{cityId}`: draft-field keys
 * only, `updatedAt` stamped with serverTimestamp(), and the
 * fence-protected fields (baselineHash, baselineStats, pointBudget,
 * commitActionId, committedSeq, committedByUid) never sent. Since the
 * Phase 4 Module 0 narrowing (P4-K14) the fence admits exactly one
 * target status — 'draft'.
 *
 * ==========================================================================
 * COMMIT IS NOT HERE (P4-K14, brief §3.3)
 * ==========================================================================
 * The pre-Phase-4 requestAllocationCommit() — a browser status write to
 * 'commit_requested' — is REMOVED, not deprecated: allocation commit is
 * an `allocate_season0` action through the play loop, built and
 * submitted by commitAction.ts. Exactly one commit path exists, and it
 * is not a draft write.
 * ==========================================================================
 */

import { doc, serverTimestamp, updateDoc } from "firebase/firestore";

import { getClientDb } from "@/lib/firebase";

import {
  buildDraftSaveFields,
  computeDraftHash,
  type DraftSaveFields,
} from "./draft";
import { sumPoints, type AllocationValues } from "./validation";

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
 * buildDraftSaveFields throws otherwise. Returns the written fields: the
 * commit flow (commitAction.ts) binds the saved `draftVersion` +
 * `draftHash` into the commit action's payload, so a commit always
 * references the draft exactly as saved.
 */
export async function saveAllocationDraft(args: {
  cityId: string;
  values: AllocationValues;
  authorUid: string;
  previousDraftVersion: number;
}): Promise<DraftSaveFields> {
  const draftHash = computeDraftHash(
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
