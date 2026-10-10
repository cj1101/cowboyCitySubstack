import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getDocsFromServer,
  limit,
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
import { createPost } from "@/lib/firestore/posts";
import { createThread } from "@/lib/firestore/forum";
import { searchTokensFrom } from "@/lib/search/tokens";
import type { Faction } from "@/lib/types";
import {
  acceptTreaty,
  breakTreaty,
  colorForTreatyName,
  counterTreaty,
  currentRevision,
  declineTreaty,
  proposeTreaty,
  ratifiedCityIds,
  renewTreaty,
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
  expiresOn: string;
  renewOn: string;
  brokenByCityId: string;
  breakNote: string;
  searchTokens?: string[];
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface TreatyTimelineEvent {
  id: string;
  at: number;
  title: string;
  detail: string;
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

function millisOf(value: unknown): number | undefined {
  if (value && typeof value === "object" && "toMillis" in value && typeof value.toMillis === "function") {
    return value.toMillis();
  }
  return undefined;
}

function toRevision(id: string, data: Record<string, unknown>): TreatyRevision {
  const number = Number(data.number ?? id);
  const kind = data.kind === "renewal" || data.kind === "counter" || data.kind === "proposal"
    ? data.kind
    : number <= 1
      ? "proposal"
      : "counter";
  return {
    number,
    name: (data.name as string) || "",
    type: (data.type as TreatyType) || "other",
    nature: (data.nature as string) || "",
    terms: (data.terms as string) || "",
    purpose: (data.purpose as string) || "",
    open: data.open === true,
    inviteeCityIds: (data.inviteeCityIds as string[]) || [],
    authorCityId: (data.authorCityId as string) || "",
    note: (data.note as string) || "",
    expiresOn: (data.expiresOn as string) || "",
    renewOn: (data.renewOn as string) || "",
    kind,
    at: millisOf(data.createdAt),
  };
}

function toResponse(data: Record<string, unknown>): TreatyResponse {
  return {
    cityId: (data.cityId as string) || "",
    revision: Number(data.revision ?? 0),
    decision: data.decision as TreatyResponse["decision"],
    note: (data.note as string) || "",
    at: millisOf(data.updatedAt) ?? millisOf(data.createdAt),
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
    status: data.status === "active" || data.status === "broken" ? data.status : "pending",
    proposerCityId: (data.proposerCityId as string) || "",
    authorUid: (data.authorUid as string) || "",
    currentRevision: Number(data.currentRevision ?? 1),
    inviteeCityIds: (data.inviteeCityIds as string[]) || [],
    partyCityIds: (data.partyCityIds as string[]) || [],
    readerUids: (data.readerUids as string[]) || [],
    partyOwnerUids: (data.partyOwnerUids as string[]) || [],
    color: (data.color as string) || "#169C9C",
    lastActionCityId: (data.lastActionCityId as string) || "",
    expiresOn: (data.expiresOn as string) || "",
    renewOn: (data.renewOn as string) || "",
    brokenByCityId: (data.brokenByCityId as string) || "",
    breakNote: (data.breakNote as string) || "",
    searchTokens: (data.searchTokens as string[]) || [],
    createdAt: data.createdAt as Timestamp | undefined,
    updatedAt: data.updatedAt as Timestamp | undefined,
  };
}

function dateFields(revision: TreatyRevision): Record<string, string> {
  const fields: Record<string, string> = {};
  if (revision.expiresOn) fields.expiresOn = revision.expiresOn;
  if (revision.renewOn) fields.renewOn = revision.renewOn;
  return fields;
}

function tokensFor(revision: TreatyRevision): string[] {
  return searchTokensFrom({
    title: `${revision.name} ${revision.type} ${revision.purpose}`,
    body: `${revision.nature} ${revision.terms}`,
  });
}

async function loadTreaty(treatyId: string): Promise<{ stored: StoredTreaty; record: TreatyRecord }> {
  const db = getClientDb();
  const [snap, revisions, responses] = await Promise.all([
    getDoc(doc(db, "treaties", treatyId)),
    getDocs(collection(db, "treaties", treatyId, "revisions")),
    getDocs(collection(db, "treaties", treatyId, "responses")),
  ]);
  if (!snap.exists()) throw new Error("That treaty is not available.");
  const stored = toStoredTreaty(snap.id, snap.data());
  return {
    stored,
    record: {
      proposerCityId: stored.proposerCityId,
      revisions: revisions.docs.map((item) => toRevision(item.id, item.data())).sort((a, b) => a.number - b.number),
      responses: responses.docs.map((item) => toResponse(item.data())),
    },
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
    ...dateFields(revision),
    searchTokens: tokensFor(revision),
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
    ...dateFields(revision),
    searchTokens: tokensFor(revision),
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
    decision: response?.decision || decision,
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
  const { stored: previous, record } = await loadTreaty(treatyId);
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

export function treatyTimeline(record: TreatyRecord, nameOf: (cityId: string) => string): TreatyTimelineEvent[] {
  const events: TreatyTimelineEvent[] = [];
  for (const revision of record.revisions) {
    const verb = revision.kind === "renewal"
      ? "proposed a renewal"
      : revision.kind === "counter" || revision.number > 1
        ? "counter-proposed"
        : "proposed the treaty";
    const dates = [
      revision.expiresOn ? `Expiry ${revision.expiresOn}` : "",
      revision.renewOn ? `Renewal ${revision.renewOn}` : "",
    ].filter(Boolean);
    events.push({
      id: `revision-${revision.number}`,
      at: revision.at ?? revision.number,
      title: `${nameOf(revision.authorCityId)} ${verb}`,
      detail: [revision.note, ...dates].filter(Boolean).join(" · "),
    });
    for (const response of responsesForRevision(record, revision.number)) {
      if (response.decision === "counter" && response.cityId === revision.authorCityId) continue;
      const label: Record<TreatyResponse["decision"], string> = {
        accept: revision.kind === "renewal" ? "ratified the renewal" : "ratified",
        decline: "declined",
        withdraw: "withdrew",
        counter: "answered with a revision",
        break: "broke the treaty",
      };
      events.push({
        id: `vote-${revision.number}-${response.cityId}-${response.decision}`,
        at: (response.at ?? revision.at ?? revision.number) + 1,
        title: `${nameOf(response.cityId)} ${label[response.decision] || response.decision}`,
        detail: response.note || "",
      });
    }
  }
  return events.sort((a, b) => a.at - b.at || a.title.localeCompare(b.title));
}

export async function renewStoredTreaty(
  treatyId: string,
  cityId: string,
  uid: string,
  factions: Faction[],
  input: { expiresOn?: string; renewOn?: string; note: string }
): Promise<void> {
  await withTimeout(ensureOwnerMembership(uid, cityId), 8000);
  const { stored, record } = await loadTreaty(treatyId);
  const next = renewTreaty(record, cityId, input);
  await persistResponse(treatyId, stored, next, cityId, uid, factions, "counter");
}

export async function breakStoredTreaty(
  treatyId: string,
  cityId: string,
  uid: string,
  factions: Faction[],
  note: string,
  authorName: string
): Promise<{ postId: string; threadId: string }> {
  await withTimeout(ensureOwnerMembership(uid, cityId), 8000);
  const { stored, record } = await loadTreaty(treatyId);
  const next = breakTreaty(record, cityId, note);
  const revision = currentRevision(next);
  const partyCityIds = ratifiedCityIds(next);
  const status = treatyStatus(next);
  const readerUids = [
    ...new Set([
      ...stored.readerUids,
      ...ownersOf(factions, [record.proposerCityId, ...revision.inviteeCityIds, ...partyCityIds, cityId]),
    ]),
  ];
  const partyOwnerUids = ownersOf(factions, partyCityIds);
  const db = getClientDb();
  const trimmed = note.trim();
  await updateDoc(doc(db, "treaties", treatyId), {
    partyCityIds,
    status,
    lastActionCityId: cityId,
    readerUids,
    partyOwnerUids: partyOwnerUids.length > 0 ? partyOwnerUids : stored.partyOwnerUids,
    updatedAt: serverTimestamp(),
    brokenByCityId: cityId,
    breakNote: trimmed,
  });
  await setDoc(doc(db, "treaties", treatyId, "responses", `${cityId}_${revision.number}`), {
    cityId,
    revision: revision.number,
    decision: "break",
    uid,
    note: trimmed,
    updatedAt: serverTimestamp(),
  });
  const cityName = factions.find((city) => city.id === cityId)?.name || "A city";
  const announcement = {
    title: `Treaty broken: ${stored.name}`.slice(0, 180),
    body: `${cityName} has broken the treaty "${stored.name}".\n\n${trimmed}\n\nThe treaty page: /treaties/${treatyId}`,
  };
  let postId = "";
  let threadId = "";
  try {
    postId = await createPost({
      type: "announcement",
      factionId: cityId,
      characterId: "",
      title: announcement.title,
      body: announcement.body,
      cityIds: [cityId],
      referencedPostIds: [],
      spoiler: false,
      pinned: false,
      status: "published",
    }, uid);
    threadId = await createThread({
      title: announcement.title,
      body: announcement.body,
      authorUid: uid,
      authorName: authorName || cityName,
      cityId,
      treatyId,
      files: [],
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "The feed could not be updated.";
    throw new Error(`The break is recorded and the map will update, but the public announcement failed. ${reason}`);
  }
  void notifyMany(readerUids, {
    type: "treaty",
    summary: `${cityName} broke ${stored.name}.`,
    href: `/treaties/${treatyId}`,
    actorUid: uid,
  });
  return { postId, threadId };
}

export async function getTreatyBundle(treatyId: string): Promise<{
  treaty: StoredTreaty;
  record: TreatyRecord;
  comments: TreatyComment[];
  wiki: TreatyWikiSection[];
} | null> {
  const db = getClientDb();
  const [loaded, comments, wiki] = await Promise.all([
    loadTreaty(treatyId).catch((error: unknown) => {
      if (error instanceof Error && error.message === "That treaty is not available.") return null;
      throw error;
    }),
    getDocs(query(collection(db, "treaties", treatyId, "comments"), orderBy("createdAt", "asc"), limit(80))),
    getDocs(query(collection(db, "treaties", treatyId, "wiki_sections"), limit(40))),
  ]);
  if (!loaded) return null;
  return {
    treaty: loaded.stored,
    record: loaded.record,
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
  const snap = await getDocsFromServer(
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
