import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type Timestamp,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";
import { withTimeout } from "@/lib/async";
import { ensureOwnerMembership, getFactionMembers } from "@/lib/firestore/factions";
import { notifyMany } from "@/lib/firestore/notifications";
import type { Faction } from "@/lib/types";
import {
  acceptTreaty,
  colorForTreatyName,
  counterTreaty,
  currentRevision,
  declineTreaty,
  proposeTreaty,
  ratifiedCityIds,
  responsesForRevision,
  treatyStatus,
  withdrawTreaty,
  type TreatyDecision,
  type TreatyDraft,
  type TreatyRecord,
  type TreatyResponse,
  type TreatyRevision,
  type TreatyStatus,
  type TreatyType,
} from "@/lib/treaties/machine";

export interface StoredTreaty {
  id: string;
  name: string;
  type: TreatyType;
  nature: string;
  terms: string;
  purpose: string;
  open: boolean;
  status: TreatyStatus;
  proposerCityId: string;
  authorUid: string;
  currentRevision: number;
  inviteeCityIds: string[];
  partyCityIds: string[];
  readerUids: string[];
  partyOwnerUids: string[];
  color: string;
  lastActionCityId: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface TreatyComment {
  id: string;
  authorUid: string;
  authorName: string;
  body: string;
  createdAt?: Timestamp;
}

export interface TreatyWikiSection {
  id: string;
  title: string;
  body: string;
  updatedAt?: Timestamp;
}

function ownersOf(factions: Faction[], cityIds: string[]): string[] {
  const ids = new Set(cityIds);
  return [...new Set(factions.filter((city) => ids.has(city.id)).flatMap((city) => city.ownerUids))];
}

function toRevision(id: string, data: Record<string, unknown>): TreatyRevision {
  return {
    number: Number(data.number ?? id),
    name: (data.name as string) || "",
    type: (data.type as TreatyType) || "other",
    nature: (data.nature as string) || "",
    terms: (data.terms as string) || "",
    purpose: (data.purpose as string) || "",
    open: data.open === true,
    inviteeCityIds: (data.inviteeCityIds as string[]) || [],
    authorCityId: (data.authorCityId as string) || "",
    note: (data.note as string) || "",
  };
}

function toResponse(data: Record<string, unknown>): TreatyResponse {
  return {
    cityId: (data.cityId as string) || "",
    revision: Number(data.revision ?? 0),
    decision: data.decision as TreatyResponse["decision"],
    note: (data.note as string) || "",
  };
}

export function toStoredTreaty(id: string, data: Record<string, unknown>): StoredTreaty {
  return {
    id,
    name: (data.name as string) || "Treaty",
    type: (data.type as TreatyType) || "other",
    nature: (data.nature as string) || "",
    terms: (data.terms as string) || "",
    purpose: (data.purpose as string) || "",
    open: data.open === true,
    status: data.status === "active" ? "active" : "pending",
    proposerCityId: (data.proposerCityId as string) || "",
    authorUid: (data.authorUid as string) || "",
    currentRevision: Number(data.currentRevision ?? 1),
    inviteeCityIds: (data.inviteeCityIds as string[]) || [],
    partyCityIds: (data.partyCityIds as string[]) || [],
    readerUids: (data.readerUids as string[]) || [],
    partyOwnerUids: (data.partyOwnerUids as string[]) || [],
    color: (data.color as string) || "#169C9C",
    lastActionCityId: (data.lastActionCityId as string) || "",
    createdAt: data.createdAt as Timestamp | undefined,
    updatedAt: data.updatedAt as Timestamp | undefined,
  };
}

async function loadRecord(treatyId: string): Promise<TreatyRecord> {
  const db = getClientDb();
  const snap = await getDoc(doc(db, "treaties", treatyId));
  if (!snap.exists()) throw new Error("That treaty is not available.");
  const stored = toStoredTreaty(snap.id, snap.data());
  const [revisions, responses] = await Promise.all([
    getDocs(collection(db, "treaties", treatyId, "revisions")),
    getDocs(collection(db, "treaties", treatyId, "responses")),
  ]);
  return {
    proposerCityId: stored.proposerCityId,
    revisions: revisions.docs.map((item) => toRevision(item.id, item.data())).sort((a, b) => a.number - b.number),
    responses: responses.docs.map((item) => toResponse(item.data())),
  };
}

function parentPatch(record: TreatyRecord, previous: StoredTreaty, uid: string, factions: Faction[]) {
  const revision = currentRevision(record);
  const partyCityIds = ratifiedCityIds(record);
  const readerUids = [...new Set([...previous.readerUids, ...ownersOf(factions, [record.proposerCityId, ...revision.inviteeCityIds, ...partyCityIds])])];
  const partyOwnerUids = ownersOf(factions, partyCityIds);
  return {
    name: revision.name,
    type: revision.type,
    nature: revision.nature,
    terms: revision.terms,
    purpose: revision.purpose,
    open: revision.open,
    status: treatyStatus(record),
    proposerCityId: record.proposerCityId,
    authorUid: uid,
    currentRevision: revision.number,
    inviteeCityIds: revision.inviteeCityIds,
    partyCityIds,
    readerUids,
    partyOwnerUids: partyOwnerUids.length > 0 ? partyOwnerUids : previous.partyOwnerUids,
    color: previous.color,
    lastActionCityId: revision.authorCityId,
    updatedAt: serverTimestamp(),
  };
}

async function readerUidsFor(uid: string, cityIds: string[], factions: Faction[]): Promise<string[]> {
  const listed = ownersOf(factions, cityIds);
  const thin = cityIds.filter((id) => {
    const city = factions.find((item) => item.id === id);
    return !city || city.ownerUids.length === 0;
  });
  const lookedUp = await Promise.all(
    thin.map((id) => getFactionMembers(id).catch(() => []))
  );
  const owners = lookedUp.flat().filter((member) => member.role === "owner").map((member) => member.uid);
  return [...new Set([uid, ...listed, ...owners])];
}

export async function createTreaty(
  uid: string,
  draft: TreatyDraft,
  factions: Faction[]
): Promise<string> {
  const record = proposeTreaty(draft);
  const revision = currentRevision(record);
  try {
    await withTimeout(ensureOwnerMembership(uid, draft.proposerCityId), 8000);
  } catch (error) {
    if (error instanceof Error && /permission|insufficient|owners/i.test(error.message)) {
      throw new Error("Only a city's owners can propose a treaty.");
    }
    throw error;
  }
  const readerUids = await readerUidsFor(uid, [draft.proposerCityId, ...revision.inviteeCityIds], factions);
  const partyOwnerUids = [...new Set([uid, ...ownersOf(factions, [draft.proposerCityId])])];
  const db = getClientDb();
  const ref = doc(collection(db, "treaties"));
  await withTimeout(setDoc(ref, {
    name: revision.name,
    type: revision.type,
    nature: revision.nature,
    terms: revision.terms,
    purpose: revision.purpose,
    open: revision.open,
    status: "pending",
    proposerCityId: draft.proposerCityId,
    authorUid: uid,
    currentRevision: 1,
    inviteeCityIds: revision.inviteeCityIds,
    partyCityIds: [draft.proposerCityId],
    readerUids,
    partyOwnerUids,
    color: colorForTreatyName(revision.name),
    lastActionCityId: draft.proposerCityId,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }));
  await withTimeout(Promise.all([
    setDoc(doc(db, "treaties", ref.id, "revisions", "1"), {
      ...revision,
      authorUid: uid,
      createdAt: serverTimestamp(),
    }),
    setDoc(doc(db, "treaties", ref.id, "responses", `${draft.proposerCityId}_1`), {
      cityId: draft.proposerCityId,
      revision: 1,
      decision: "accept",
      uid,
      note: "",
      updatedAt: serverTimestamp(),
    }),
  ]));
  void notifyMany(readerUids, {
    type: "treaty",
    summary: `${revision.name} is waiting on a response.`,
    href: `/treaties/${ref.id}`,
    actorUid: uid,
  });
  return ref.id;
}

async function persistResponse(
  treatyId: string,
  previous: StoredTreaty,
  record: TreatyRecord,
  cityId: string,
  uid: string,
  factions: Faction[],
  decision: TreatyDecision
) {
  const revision = currentRevision(record);
  const db = getClientDb();
  const partyCityIds = ratifiedCityIds(record);
  const status = treatyStatus(record);
  const readerUids = [
    ...new Set([
      ...previous.readerUids,
      ...ownersOf(factions, [record.proposerCityId, ...revision.inviteeCityIds, ...partyCityIds]),
    ]),
  ];
  const partyOwnerUids = ownersOf(factions, partyCityIds);
  if (decision === "counter") {
    await setDoc(doc(db, "treaties", treatyId, "revisions", String(revision.number)), {
      ...revision,
      authorUid: uid,
      createdAt: serverTimestamp(),
    });
    await updateDoc(doc(db, "treaties", treatyId), {
      ...parentPatch(record, previous, uid, factions),
      lastActionCityId: cityId,
      readerUids,
      partyOwnerUids: partyOwnerUids.length > 0 ? partyOwnerUids : [uid],
    });
  } else if (
    partyCityIds.join(",") !== previous.partyCityIds.join(",") ||
    status !== previous.status
  ) {
    await updateDoc(doc(db, "treaties", treatyId), {
      partyCityIds,
      status,
      lastActionCityId: cityId,
      readerUids,
      partyOwnerUids: partyOwnerUids.length > 0 ? partyOwnerUids : previous.partyOwnerUids,
      updatedAt: serverTimestamp(),
    });
  }
  const response = responsesForRevision(record, revision.number).find((item) => item.cityId === cityId);
  await setDoc(doc(db, "treaties", treatyId, "responses", `${cityId}_${revision.number}`), {
    cityId,
    revision: revision.number,
    decision,
    uid,
    note: response?.note || "",
    updatedAt: serverTimestamp(),
  });
  const summary =
    decision === "counter"
      ? `${revision.name} has a new revision to ratify.`
      : decision === "accept" && status === "active"
        ? `${revision.name} is now active.`
        : `${revision.name}: a city ${decision === "accept" ? "ratified" : decision === "decline" ? "declined" : "withdrew"}.`;
  await notifyMany(readerUids, {
    type: "treaty",
    summary,
    href: `/treaties/${treatyId}`,
    actorUid: uid,
  });
}

export async function respondToTreaty(
  treatyId: string,
  cityId: string,
  uid: string,
  factions: Faction[],
  action: "accept" | "decline" | "withdraw" | { counter: Parameters<typeof counterTreaty>[2] }
): Promise<void> {
  const db = getClientDb();
  const snap = await getDoc(doc(db, "treaties", treatyId));
  if (!snap.exists()) throw new Error("That treaty is not available.");
  const previous = toStoredTreaty(snap.id, snap.data());
  const record = await loadRecord(treatyId);
  if (action === "accept") {
    await persistResponse(treatyId, previous, acceptTreaty(record, cityId), cityId, uid, factions, "accept");
    return;
  }
  if (action === "decline") {
    await persistResponse(treatyId, previous, declineTreaty(record, cityId), cityId, uid, factions, "decline");
    return;
  }
  if (action === "withdraw") {
    await persistResponse(treatyId, previous, withdrawTreaty(record, cityId), cityId, uid, factions, "withdraw");
    return;
  }
  await persistResponse(
    treatyId,
    previous,
    counterTreaty(record, cityId, action.counter),
    cityId,
    uid,
    factions,
    "counter"
  );
}

export async function getTreatyBundle(treatyId: string): Promise<{
  treaty: StoredTreaty;
  record: TreatyRecord;
  comments: TreatyComment[];
  wiki: TreatyWikiSection[];
} | null> {
  const db = getClientDb();
  const snap = await getDoc(doc(db, "treaties", treatyId));
  if (!snap.exists()) return null;
  const [record, comments, wiki] = await Promise.all([
    loadRecord(treatyId),
    getDocs(query(collection(db, "treaties", treatyId, "comments"), orderBy("createdAt", "asc"))),
    getDocs(collection(db, "treaties", treatyId, "wiki_sections")),
  ]);
  return {
    treaty: toStoredTreaty(snap.id, snap.data()),
    record,
    comments: comments.docs.map((item) => ({
      id: item.id,
      authorUid: (item.data().authorUid as string) || "",
      authorName: (item.data().authorName as string) || "Member",
      body: (item.data().body as string) || "",
      createdAt: item.data().createdAt as Timestamp | undefined,
    })),
    wiki: wiki.docs.map((item) => ({
      id: item.id,
      title: (item.data().title as string) || "Note",
      body: (item.data().body as string) || "",
      updatedAt: item.data().updatedAt as Timestamp | undefined,
    })),
  };
}

export async function listActiveTreaties(): Promise<StoredTreaty[]> {
  const snap = await getDocs(
    query(collection(getClientDb(), "treaties"), where("status", "==", "active"))
  );
  return snap.docs.map((item) => toStoredTreaty(item.id, item.data()));
}

export async function listActiveTreatiesForCity(cityId: string): Promise<StoredTreaty[]> {
  const snap = await getDocs(
    query(
      collection(getClientDb(), "treaties"),
      where("status", "==", "active"),
      where("partyCityIds", "array-contains", cityId)
    )
  );
  return snap.docs.map((item) => toStoredTreaty(item.id, item.data()));
}

export async function listReadablePending(uid: string, ownsCity: boolean): Promise<StoredTreaty[]> {
  const db = getClientDb();
  const [invited, open] = await Promise.all([
    getDocs(query(collection(db, "treaties"), where("readerUids", "array-contains", uid))),
    ownsCity
      ? getDocs(query(collection(db, "treaties"), where("open", "==", true), where("status", "==", "pending"))).catch(() => null)
      : Promise.resolve(null),
  ]);
  const map = new Map<string, StoredTreaty>();
  for (const item of invited.docs) {
    const treaty = toStoredTreaty(item.id, item.data());
    if (treaty.status === "pending") map.set(treaty.id, treaty);
  }
  open?.docs.forEach((item) => {
    const treaty = toStoredTreaty(item.id, item.data());
    map.set(treaty.id, treaty);
  });
  return [...map.values()];
}

export async function addTreatyComment(
  treatyId: string,
  authorUid: string,
  authorName: string,
  body: string
): Promise<void> {
  const ref = doc(collection(getClientDb(), "treaties", treatyId, "comments"));
  await setDoc(ref, {
    authorUid,
    authorName,
    body: body.trim(),
    createdAt: serverTimestamp(),
  });
}

export async function saveTreatyWiki(
  treatyId: string,
  section: { id?: string; title: string; body: string }
): Promise<void> {
  const db = getClientDb();
  const ref = section.id
    ? doc(db, "treaties", treatyId, "wiki_sections", section.id)
    : doc(collection(db, "treaties", treatyId, "wiki_sections"));
  await setDoc(ref, { title: section.title.trim(), body: section.body, updatedAt: serverTimestamp() }, { merge: true });
}

export async function deleteTreatyWiki(treatyId: string, sectionId: string): Promise<void> {
  await deleteDoc(doc(getClientDb(), "treaties", treatyId, "wiki_sections", sectionId));
}
