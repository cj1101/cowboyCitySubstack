import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
  type DocumentData,
  type QueryConstraint,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";
import { parseMentions } from "@/lib/mentions";
import type {
  Character,
  CreatePostInput,
  Faction,
  FactionMember,
  Post,
  PostMentions,
} from "@/lib/types";

const POSTS_COLLECTION = "posts";
const FACTIONS_COLLECTION = "factions";
const CHARACTERS_COLLECTION = "characters";
const FACTION_MEMBERS_COLLECTION = "faction_members";

function docToPost(id: string, data: DocumentData): Post {
  return {
    id,
    type: data.type,
    factionId: data.factionId,
    characterId: data.characterId,
    title: data.title,
    body: data.body ?? "",
    images: data.images,
    poll: data.poll,
    pinned: data.pinned ?? false,
    mentions: data.mentions ?? { factions: [], characters: [], posts: [] },
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
  };
}

function emptyMentions(overrides?: Partial<PostMentions>): PostMentions {
  return {
    factions: overrides?.factions ?? [],
    characters: overrides?.characters ?? [],
    posts: overrides?.posts ?? [],
  };
}

export async function createPost(input: CreatePostInput): Promise<string> {
  const db = getClientDb();
  const ref = await addDoc(collection(db, POSTS_COLLECTION), {
    type: input.type,
    factionId: input.factionId,
    characterId: input.characterId,
    title: input.title,
    body: input.body,
    images: input.images ?? [],
    poll: input.poll ?? null,
    pinned: input.pinned ?? false,
    mentions: emptyMentions(parseMentions(input.body)),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

export async function getPost(postId: string): Promise<Post | null> {
  const db = getClientDb();
  const snap = await getDoc(doc(db, POSTS_COLLECTION, postId));
  if (!snap.exists()) return null;
  return docToPost(snap.id, snap.data());
}

export async function getPosts(options?: {
  factionId?: string | null;
}): Promise<Post[]> {
  const db = getClientDb();
  const constraints: QueryConstraint[] = [orderBy("createdAt", "desc")];

  if (options?.factionId) {
    constraints.unshift(where("factionId", "==", options.factionId));
  }

  const snap = await getDocs(
    query(collection(db, POSTS_COLLECTION), ...constraints)
  );

  const posts = snap.docs.map((d) => docToPost(d.id, d.data()));

  const pinned = posts.filter((p) => p.pinned && p.type === "announcement");
  const rest = posts.filter((p) => !(p.pinned && p.type === "announcement"));

  pinned.sort(
    (a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0)
  );

  return [...pinned, ...rest];
}

export async function updatePostImages(
  postId: string,
  images: string[]
): Promise<void> {
  const db = getClientDb();
  await updateDoc(doc(db, POSTS_COLLECTION, postId), {
    images,
    updatedAt: serverTimestamp(),
  });
}

export async function getAllFactions(): Promise<Faction[]> {
  const db = getClientDb();
  const snap = await getDocs(collection(db, FACTIONS_COLLECTION));
  return snap.docs.map((d) => ({
    id: d.id,
    name: d.data().name ?? "Unknown",
    slug: d.data().slug ?? d.id,
    colors: d.data().colors,
    bannerUrl: d.data().bannerUrl,
    sigilUrl: d.data().sigilUrl,
    bio: d.data().bio,
    ownerUids: d.data().ownerUids,
  }));
}

export async function getFaction(factionId: string): Promise<Faction | null> {
  const db = getClientDb();
  const snap = await getDoc(doc(db, FACTIONS_COLLECTION, factionId));
  if (!snap.exists()) return null;
  const data = snap.data();
  return {
    id: snap.id,
    name: data.name ?? "Unknown",
    slug: data.slug ?? snap.id,
    colors: data.colors,
    bannerUrl: data.bannerUrl,
    sigilUrl: data.sigilUrl,
    bio: data.bio,
    ownerUids: data.ownerUids,
  };
}

export async function getCharactersByFaction(
  factionId: string
): Promise<Character[]> {
  const db = getClientDb();
  const snap = await getDocs(
    query(
      collection(db, CHARACTERS_COLLECTION),
      where("factionId", "==", factionId)
    )
  );
  return snap.docs
    .map((d) => ({
      id: d.id,
      factionId: d.data().factionId,
      name: d.data().name ?? "Unknown",
      title: d.data().title,
      avatarUrl: d.data().avatarUrl,
      isActive: d.data().isActive ?? true,
    }))
    .filter((c) => c.isActive !== false);
}

export async function getCharacter(
  characterId: string
): Promise<Character | null> {
  const db = getClientDb();
  const snap = await getDoc(doc(db, CHARACTERS_COLLECTION, characterId));
  if (!snap.exists()) return null;
  const data = snap.data();
  return {
    id: snap.id,
    factionId: data.factionId,
    name: data.name ?? "Unknown",
    title: data.title,
    avatarUrl: data.avatarUrl,
    isActive: data.isActive ?? true,
  };
}

export async function getUserFactionMemberships(
  uid: string
): Promise<FactionMember[]> {
  const db = getClientDb();
  const snap = await getDocs(
    query(collection(db, FACTION_MEMBERS_COLLECTION), where("uid", "==", uid))
  );
  return snap.docs.map((d) => ({
    id: d.id,
    uid: d.data().uid,
    factionId: d.data().factionId,
    role: d.data().role ?? "member",
  }));
}

export async function getUserFactions(uid: string): Promise<Faction[]> {
  const memberships = await getUserFactionMemberships(uid);
  const factions = await Promise.all(
    memberships.map((m) => getFaction(m.factionId))
  );
  return factions.filter((f): f is Faction => f !== null);
}

export async function getFactionsMap(
  factionIds: string[]
): Promise<Map<string, Faction>> {
  const unique = [...new Set(factionIds)];
  const factions = await Promise.all(unique.map((id) => getFaction(id)));
  const map = new Map<string, Faction>();
  factions.forEach((f) => {
    if (f) map.set(f.id, f);
  });
  return map;
}

export async function getCharactersMap(
  characterIds: string[]
): Promise<Map<string, Character>> {
  const unique = [...new Set(characterIds)];
  const characters = await Promise.all(unique.map((id) => getCharacter(id)));
  const map = new Map<string, Character>();
  characters.forEach((c) => {
    if (c) map.set(c.id, c);
  });
  return map;
}
