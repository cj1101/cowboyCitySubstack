import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  query,
  where,
  serverTimestamp,
  writeBatch,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";
import type { Faction, FactionInput, FactionMember } from "@/lib/types";

const FACTIONS = "factions";
const FACTION_MEMBERS = "faction_members";

function memberDocId(uid: string, factionId: string): string {
  return `${uid}_${factionId}`;
}

function docToFaction(id: string, data: Record<string, unknown>): Faction {
  return {
    id,
    name: data.name as string,
    slug: data.slug as string,
    colors: data.colors as Faction["colors"],
    bannerUrl: data.bannerUrl as string | undefined,
    sigilUrl: data.sigilUrl as string | undefined,
    bio: (data.description as string | undefined) ?? (data.bio as string | undefined),
    description: (data.description as string | undefined) ?? (data.bio as string | undefined),
    lore: data.lore as string | undefined,
    mapImageUrl: data.mapImageUrl as string | undefined,
    liveHtml: data.liveHtml as string | undefined,
    pendingHtml: data.pendingHtml as string | undefined,
    htmlStatus: data.htmlStatus as Faction["htmlStatus"],
    htmlSubmittedAt: data.htmlSubmittedAt as Faction["htmlSubmittedAt"],
    ownerUids: (data.ownerUids as string[]) ?? [],
    createdAt: data.createdAt as Faction["createdAt"],
  };
}

export async function getAllFactions(): Promise<Faction[]> {
  const db = getClientDb();
  const snapshot = await getDocs(collection(db, FACTIONS));
  return snapshot.docs.map((d) => docToFaction(d.id, d.data()));
}

export async function getFactionById(id: string): Promise<Faction | null> {
  const db = getClientDb();
  const snap = await getDoc(doc(db, FACTIONS, id));
  if (!snap.exists()) return null;
  return docToFaction(snap.id, snap.data());
}

export async function getFactionBySlug(slug: string): Promise<Faction | null> {
  const db = getClientDb();
  const q = query(collection(db, FACTIONS), where("slug", "==", slug));
  const snapshot = await getDocs(q);
  if (snapshot.empty) return null;
  const d = snapshot.docs[0];
  return docToFaction(d.id, d.data());
}

export async function isSlugTaken(slug: string, excludeId?: string): Promise<boolean> {
  const existing = await getFactionBySlug(slug);
  if (!existing) return false;
  return excludeId ? existing.id !== excludeId : true;
}

export async function createFaction(
  creatorUid: string,
  input: FactionInput
): Promise<Faction> {
  const db = getClientDb();
  const factionRef = doc(collection(db, FACTIONS));
  const description = input.description ?? input.bio ?? "";
  await setDoc(factionRef, {
    name: input.name,
    slug: input.slug,
    colors: input.colors,
    bannerUrl: input.bannerUrl ?? null,
    sigilUrl: input.sigilUrl ?? null,
    bio: description,
    description,
    lore: input.lore ?? "",
    mapImageUrl: input.mapImageUrl ?? null,
    ownerUids: [creatorUid],
    createdAt: serverTimestamp(),
  });

  await setDoc(doc(db, FACTION_MEMBERS, memberDocId(creatorUid, factionRef.id)), {
    uid: creatorUid,
    factionId: factionRef.id,
    role: "owner",
  });
  await updateDoc(doc(db, "users", creatorUid), { ownsCity: true, proofCityId: factionRef.id });

  return {
    id: factionRef.id,
    name: input.name,
    slug: input.slug,
    colors: input.colors,
    bannerUrl: input.bannerUrl,
    sigilUrl: input.sigilUrl,
    bio: description,
    description,
    lore: input.lore,
    mapImageUrl: input.mapImageUrl,
    ownerUids: [creatorUid],
  };
}

export async function ensureCityOwnerClaim(uid: string, cityId: string): Promise<void> {
  await updateDoc(doc(getClientDb(), "users", uid), { ownsCity: true, proofCityId: cityId });
}

export async function updateFaction(
  factionId: string,
  input: Partial<FactionInput>
): Promise<void> {
  const db = getClientDb();
  const updates: Record<string, unknown> = {};
  if (input.name !== undefined) updates.name = input.name;
  if (input.slug !== undefined) updates.slug = input.slug;
  if (input.colors !== undefined) updates.colors = input.colors;
  if (input.bannerUrl !== undefined) updates.bannerUrl = input.bannerUrl;
  if (input.sigilUrl !== undefined) updates.sigilUrl = input.sigilUrl;
  if (input.bio !== undefined || input.description !== undefined) {
    const description = input.description ?? input.bio ?? "";
    updates.bio = description;
    updates.description = description;
  }
  if (input.lore !== undefined) updates.lore = input.lore;
  if (input.mapImageUrl !== undefined) updates.mapImageUrl = input.mapImageUrl;
  await updateDoc(doc(db, FACTIONS, factionId), updates);
}

export async function deleteFaction(factionId: string): Promise<void> {
  const db = getClientDb();
  const members = await getFactionMembers(factionId);
  const batch = writeBatch(db);
  for (const member of members) {
    batch.delete(doc(db, FACTION_MEMBERS, member.id));
  }
  batch.delete(doc(db, FACTIONS, factionId));
  await batch.commit();
}

export async function getFactionsForUser(uid: string): Promise<Faction[]> {
  const db = getClientDb();
  const q = query(collection(db, FACTION_MEMBERS), where("uid", "==", uid));
  const memberSnap = await getDocs(q);
  const factionIds = memberSnap.docs.map((d) => d.data().factionId as string);
  if (factionIds.length === 0) return [];

  const factions: Faction[] = [];
  for (const factionId of factionIds) {
    const faction = await getFactionById(factionId);
    if (faction) factions.push(faction);
  }
  return factions;
}

export async function getFactionMembers(factionId: string): Promise<FactionMember[]> {
  const db = getClientDb();
  const q = query(collection(db, FACTION_MEMBERS), where("factionId", "==", factionId));
  const snapshot = await getDocs(q);
  return snapshot.docs.map((d) => ({
    id: d.id,
    uid: d.data().uid as string,
    factionId: d.data().factionId as string,
    role: d.data().role as FactionMember["role"],
  }));
}

export async function addFactionOwner(factionId: string, uid: string): Promise<void> {
  const db = getClientDb();
  const faction = await getFactionById(factionId);
  if (!faction) throw new Error("Faction not found");

  const memberRef = doc(db, FACTION_MEMBERS, memberDocId(uid, factionId));
  await setDoc(memberRef, { uid, factionId, role: "owner" }, { merge: true });

  const ownerUids = [...new Set([...faction.ownerUids, uid])];
  await updateDoc(doc(db, FACTIONS, factionId), { ownerUids });
}

export async function removeFactionOwner(factionId: string, uid: string): Promise<void> {
  const db = getClientDb();
  const faction = await getFactionById(factionId);
  if (!faction) throw new Error("Faction not found");

  if (faction.ownerUids.length <= 1) {
    throw new Error("Cannot remove the last owner");
  }

  const memberRef = doc(db, FACTION_MEMBERS, memberDocId(uid, factionId));
  const memberSnap = await getDoc(memberRef);
  if (memberSnap.exists()) {
    await updateDoc(memberRef, { role: "member" });
  }

  const ownerUids = faction.ownerUids.filter((id) => id !== uid);
  await updateDoc(doc(db, FACTIONS, factionId), { ownerUids });
}

export async function isFactionOwner(factionId: string, uid: string): Promise<boolean> {
  const db = getClientDb();
  const memberSnap = await getDoc(doc(db, FACTION_MEMBERS, memberDocId(uid, factionId)));
  if (!memberSnap.exists()) return false;
  return memberSnap.data().role === "owner";
}

export async function submitFactionHtml(
  factionId: string,
  html: string
): Promise<void> {
  const db = getClientDb();
  await updateDoc(doc(db, FACTIONS, factionId), {
    pendingHtml: html,
    htmlStatus: "pending_review",
    htmlSubmittedAt: serverTimestamp(),
  });
}

export async function getPendingHtmlFactions(): Promise<Faction[]> {
  const db = getClientDb();
  const q = query(
    collection(db, FACTIONS),
    where("htmlStatus", "==", "pending_review")
  );
  const snapshot = await getDocs(q);
  const factions = snapshot.docs.map((d) => docToFaction(d.id, d.data()));
  return factions.sort(
    (a, b) =>
      (b.htmlSubmittedAt?.toMillis?.() ?? 0) -
      (a.htmlSubmittedAt?.toMillis?.() ?? 0)
  );
}

export async function approveFactionHtml(factionId: string): Promise<void> {
  const db = getClientDb();
  const snap = await getDoc(doc(db, FACTIONS, factionId));
  if (!snap.exists()) throw new Error("Faction not found");

  const pendingHtml = snap.data().pendingHtml as string | undefined;
  if (!pendingHtml) throw new Error("No pending HTML to approve");

  await updateDoc(doc(db, FACTIONS, factionId), {
    liveHtml: pendingHtml,
    pendingHtml: null,
    htmlStatus: "approved",
    htmlReviewedAt: serverTimestamp(),
  });
}

export async function rejectFactionHtml(factionId: string): Promise<void> {
  const db = getClientDb();
  await updateDoc(doc(db, FACTIONS, factionId), {
    pendingHtml: null,
    htmlStatus: "rejected",
    htmlReviewedAt: serverTimestamp(),
  });
}
