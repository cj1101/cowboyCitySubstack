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
  PostMedia,
  PostMentions,
  PostStatus,
} from "@/lib/types";

const POSTS_COLLECTION = "posts";
const FACTIONS_COLLECTION = "factions";
const CHARACTERS_COLLECTION = "characters";
const FACTION_MEMBERS_COLLECTION = "faction_members";

function mediaFromDoc(data: DocumentData): PostMedia[] {
  if (Array.isArray(data.media) && data.media.length > 0) {
    return data.media as PostMedia[];
  }
  const images = (data.images as string[] | undefined) ?? [];
  return images.map((url) => ({ url, type: "image" as const }));
}

function docToPost(id: string, data: DocumentData): Post {
  const factionId = data.factionId as string;
  return {
    id,
    type: data.type,
    factionId,
    characterId: data.characterId ?? "",
    title: data.title,
    body: data.body ?? "",
    images: data.images,
    media: mediaFromDoc(data),
    poll: data.poll,
    pinned: data.pinned ?? false,
    mentions: data.mentions ?? { factions: [], characters: [], posts: [] },
    cityIds: (data.cityIds as string[] | undefined) ?? (factionId ? [factionId] : []),
    referencedPostIds: (data.referencedPostIds as string[] | undefined) ?? [],
    authorUid: data.authorUid ?? "",
    status: (data.status as PostStatus | undefined) ?? "published",
    publishAt: data.publishAt ?? null,
    settlementYear: data.settlementYear ?? null,
    era: data.era ?? null,
    contentWarning: data.contentWarning ?? null,
    spoiler: data.spoiler === true,
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

export async function createPost(
  input: CreatePostInput,
  authorUid: string
): Promise<string> {
  const db = getClientDb();
  const cityIds = input.cityIds?.length
    ? Array.from(new Set([input.factionId, ...input.cityIds]))
    : [input.factionId];
  const ref = await addDoc(collection(db, POSTS_COLLECTION), {
    type: input.type,
    factionId: input.factionId,
    characterId: input.characterId ?? "",
    title: input.title,
    body: input.body,
    images: input.images ?? [],
    media: input.media ?? [],
    poll: input.poll ?? null,
    pinned: input.pinned ?? false,
    mentions: emptyMentions(input.mentions ?? parseMentions(input.body)),
    cityIds,
    referencedPostIds: input.referencedPostIds ?? [],
    authorUid,
    status: input.status ?? "published",
    publishAt: input.publishAt ?? null,
    settlementYear: input.settlementYear ?? null,
    era: input.era ?? null,
    contentWarning: input.contentWarning ?? null,
    spoiler: input.spoiler === true,
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

async function fetchPostQuery(constraints: QueryConstraint[]): Promise<Post[]> {
  const db = getClientDb();
  const snap = await getDocs(query(collection(db, POSTS_COLLECTION), ...constraints));
  return snap.docs.map((d) => docToPost(d.id, d.data()));
}

export async function getPosts(options?: {
  factionId?: string | null;
}): Promise<Post[]> {
  const cityId = options?.factionId;
  let posts: Post[];

  if (cityId) {
    const [tagged, primary] = await Promise.all([
      fetchPostQuery([
        where("cityIds", "array-contains", cityId),
        where("status", "==", "published"),
        orderBy("createdAt", "desc"),
      ]),
      fetchPostQuery([
        where("factionId", "==", cityId),
        where("status", "==", "published"),
        orderBy("createdAt", "desc"),
      ]),
    ]);
    const byId = new Map<string, Post>();
    for (const post of [...tagged, ...primary]) byId.set(post.id, post);
    posts = [...byId.values()];
    posts.sort(
      (a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0)
    );
  } else {
    posts = await fetchPostQuery([
      where("status", "==", "published"),
      orderBy("createdAt", "desc"),
    ]);
  }

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
    media: images.map((url) => ({ url, type: "image" })),
    updatedAt: serverTimestamp(),
  });
}

export async function updatePostMedia(
  postId: string,
  media: PostMedia[]
): Promise<void> {
  const db = getClientDb();
  await updateDoc(doc(db, POSTS_COLLECTION, postId), {
    media,
    images: media.filter((item) => item.type === "image").map((item) => item.url),
    updatedAt: serverTimestamp(),
  });
}

export async function getMyPostsByStatus(
  authorUid: string,
  status: PostStatus
): Promise<Post[]> {
  return fetchPostQuery([
    where("authorUid", "==", authorUid),
    where("status", "==", status),
    orderBy("createdAt", "desc"),
  ]);
}

export async function publishDueScheduledPosts(authorUid: string): Promise<number> {
  const scheduled = await getMyPostsByStatus(authorUid, "scheduled");
  const db = getClientDb();
  const now = Date.now();
  let published = 0;
  for (const post of scheduled) {
    const at = post.publishAt?.toMillis?.() ?? Number.POSITIVE_INFINITY;
    if (at <= now) {
      await updateDoc(doc(db, POSTS_COLLECTION, post.id), {
        status: "published",
        updatedAt: serverTimestamp(),
      });
      published += 1;
    }
  }
  return published;
}

export async function getSettlementPosts(): Promise<Post[]> {
  return fetchPostQuery([
    where("status", "==", "published"),
    where("settlementYear", ">", 0),
    orderBy("settlementYear", "desc"),
  ]);
}

export async function getReferencingPosts(postId: string): Promise<Post[]> {
  const db = getClientDb();
  const snap = await getDocs(
    query(
      collection(db, POSTS_COLLECTION),
      where("referencedPostIds", "array-contains", postId),
      where("status", "==", "published")
    )
  );
  return snap.docs.map((d) => docToPost(d.id, d.data()));
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
    bio: d.data().description ?? d.data().bio,
    description: d.data().description ?? d.data().bio,
    lore: d.data().lore,
    mapImageUrl: d.data().mapImageUrl,
    ownerUids: d.data().ownerUids,
  }));
}

export async function getFaction(factionId: string): Promise<Faction | null> {
  if (!factionId) return null;
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
    bio: data.description ?? data.bio,
    description: data.description ?? data.bio,
    lore: data.lore,
    mapImageUrl: data.mapImageUrl,
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
  if (!characterId) return null;
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
  const unique = [...new Set(factionIds.filter(Boolean))];
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
  const unique = [...new Set(characterIds.filter(Boolean))];
  const characters = await Promise.all(unique.map((id) => getCharacter(id)));
  const map = new Map<string, Character>();
  characters.forEach((c) => {
    if (c) map.set(c.id, c);
  });
  return map;
}
