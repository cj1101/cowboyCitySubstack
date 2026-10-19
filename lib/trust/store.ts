/**
 * Firestore access for `sim_trust_assessments/{uid}` (June brief §2.3).
 *
 * Identity discipline — the whole point of the collection:
 * - WRITES run only as the owning member's own browser session
 *   (firestore.rules §11.3 posture: isFullMember() + uid match +
 *   validAssessments shape fence). Every function here takes the
 *   owner's uid and writes that owner's doc; there is no parameter
 *   that lets a caller write anyone else's.
 * - The fabric committer is DENIED write on this collection by design
 *   (TC-P12(v)): no NPC can mark a claim in anyone's view, including
 *   its owner's. Accordingly this module has NO fabric/admin path —
 *   it speaks only the client SDK, as the member.
 * - READS: the owner, or a member named in `sharedWith` (the separated
 *   view only). Removal from sharedWith stops the read at the next
 *   rules evaluation — revocation is prospective and immediate.
 *
 * Writes are whole-doc read-modify-write: the doc is per-user,
 * single-writer (the owner's own browser), and the caps keep it far
 * under the size limit, so a transaction would buy nothing here.
 */

import {
  Timestamp,
  deleteDoc,
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  type DocumentData,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";
import {
  normalizeTrustAssessments,
  validateMarkInput,
  withMark,
  withSharedWith,
  withoutMark,
  type TrustAssessments,
  type TrustMark,
} from "./assessments";

export const TRUST_ASSESSMENTS_COLLECTION = "sim_trust_assessments";

function isoOf(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const maybe = value as { toDate?: unknown };
  if (typeof maybe.toDate === "function") {
    return (maybe.toDate as () => Date)().toISOString();
  }
  return typeof value === "string" ? value : null;
}

function fromFirestore(data: DocumentData): TrustAssessments {
  const rawMarks = (data.marks ?? {}) as Record<string, DocumentData>;
  const marks: Record<string, unknown> = {};
  for (const [publicationId, mark] of Object.entries(rawMarks)) {
    marks[publicationId] = {
      stance: mark?.stance,
      note: mark?.note ?? null,
      subjectCityId: mark?.subjectCityId,
      updatedAtIso: isoOf(mark?.updatedAt),
    };
  }
  return normalizeTrustAssessments({
    marks,
    sharedWith: data.sharedWith ?? [],
    updatedAtIso: isoOf(data.updatedAt),
  });
}

function toFirestore(docData: TrustAssessments): DocumentData {
  const marks: Record<string, DocumentData> = {};
  for (const [publicationId, mark] of Object.entries(docData.marks)) {
    marks[publicationId] = {
      stance: mark.stance,
      note: mark.note,
      subjectCityId: mark.subjectCityId,
      updatedAt: mark.updatedAtIso
        ? Timestamp.fromDate(new Date(mark.updatedAtIso))
        : serverTimestamp(),
    };
  }
  return {
    marks,
    sharedWith: [...docData.sharedWith],
    updatedAt: serverTimestamp(),
  };
}

async function writeAssessments(
  uid: string,
  next: TrustAssessments
): Promise<TrustAssessments> {
  await setDoc(
    doc(getClientDb(), TRUST_ASSESSMENTS_COLLECTION, uid),
    toFirestore(next)
  );
  return next;
}

/** Read an assessments doc (owner or sharedWith reader, per rules).
 * Returns null when no doc exists — a member who never marked a claim
 * has no view yet, which is a normal state, not an error. */
export async function loadTrustAssessments(
  ownerUid: string
): Promise<TrustAssessments | null> {
  const snap = await getDoc(
    doc(getClientDb(), TRUST_ASSESSMENTS_COLLECTION, ownerUid)
  );
  if (!snap.exists()) return null;
  return fromFirestore(snap.data());
}

export async function loadOwnTrustAssessments(
  uid: string
): Promise<TrustAssessments> {
  return (await loadTrustAssessments(uid)) ?? {
    marks: {},
    sharedWith: [],
    updatedAtIso: null,
  };
}

/** Set/replace the owner's own mark on one publication. */
export async function saveTrustMark(
  uid: string,
  publicationId: string,
  input: { stance: unknown; note?: string | null; subjectCityId: unknown }
): Promise<TrustAssessments> {
  const validated = validateMarkInput(input);
  const mark: TrustMark = {
    ...validated,
    updatedAtIso: new Date().toISOString(),
  };
  const current = await loadOwnTrustAssessments(uid);
  return writeAssessments(uid, withMark(current, publicationId, mark));
}

/** Remove the owner's own mark on one publication. */
export async function clearTrustMark(
  uid: string,
  publicationId: string
): Promise<TrustAssessments> {
  const current = await loadOwnTrustAssessments(uid);
  return writeAssessments(uid, withoutMark(current, publicationId));
}

/** Replace the owner's share list (add/remove readers of their view). */
export async function saveTrustSharedWith(
  uid: string,
  sharedWith: string[]
): Promise<TrustAssessments> {
  const current = await loadOwnTrustAssessments(uid);
  return writeAssessments(uid, withSharedWith(current, sharedWith));
}

/** Delete the owner's whole assessments doc (their own hand only). */
export async function deleteTrustAssessments(uid: string): Promise<void> {
  await deleteDoc(doc(getClientDb(), TRUST_ASSESSMENTS_COLLECTION, uid));
}
