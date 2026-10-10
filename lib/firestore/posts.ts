import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getDocsFromServer,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type DocumentData,
  type QueryConstraint,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";
import { readCityRecord } from "@/lib/cities/record";
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
const DRAFTS_COLLECTION = "drafts";
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
  const ref = await addDoc(collection(db, postCollectionFor(input.status)), {
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
  const published = await getDoc(doc(db, POSTS_COLLECTION, postId));
  if (published.exists()) return docToPost(published.id, published.data());
  const draft = await getDoc(doc(db, DRAFTS_COLLECTION, postId));
  if (!draft.exists()) return null;
  return docToPost(draft.id, draft.data());
}

function isPrivateStatus(status: PostStatus | undefined): boolean {
  return status === "draft" || status === "scheduled";
}

function postCollectionFor(status: PostStatus | undefined): string {
  return isPrivateStatus(status) ? DRAFTS_COLLECTION : POSTS_COLLECTION;
}

async function fetchPostQuery(constraints: QueryConstraint[], fromServer = false): Promise<Post[]> {
  const db = getClientDb();
  const read = fromServer ? getDocsFromServer : getDocs;
  const snap = await read(query(collection(db, POSTS_COLLECTION), ...constraints));
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
        orderBy("createdAt", "desc"),
      ], true),
      fetchPostQuery([
        where("factionId", "==", cityId),
        orderBy("createdAt", "desc"),
      ], true),
    ]);
    const byId = new Map<string, Post>();
    for (const post of [...tagged, ...primary]) byId.set(post.id, post);
    posts = [...byId.values()];
    posts.sort(
      (a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0)
    );
  } else {
    posts = await fetchPostQuery([orderBy("createdAt", "desc")], true);
  }

  posts = posts.filter((post) => !isPrivateStatus(post.status));

  const pinned = posts.filter((p) => p.pinned && p.type === "announcement");
  const rest = posts.filter((p) => !(p.pinned && p.type === "announcement"));

  pinned.sort(
    (a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0)
  );

  return [...pinned, ...rest];
}

async function locatePost(postId: string) {
  const db = getClientDb();
  const published = doc(db, POSTS_COLLECTION, postId);
  const snap = await getDoc(published);
  if (snap.exists()) return published;
  return doc(db, DRAFTS_COLLECTION, postId);
}

export async function updatePostImages(
  postId: string,
  images: string[]
): Promise<void> {
  await updateDoc(await locatePost(postId), {
    images,
    media: images.map((url) => ({ url, type: "image" })),
    updatedAt: serverTimestamp(),
  });
}

export async function updatePostMedia(
  postId: string,
  media: PostMedia[]
): Promise<void> {
  await updateDoc(await locatePost(postId), {
    media,
    images: media.filter((item) => item.type === "image").map((item) => item.url),
    updatedAt: serverTimestamp(),
  });
}

export async function getMyPostsByStatus(
  authorUid: string,
  status: PostStatus
): Promise<Post[]> {
  const db = getClientDb();
  if (status === "published") {
    return (await fetchPostQuery([
      where("authorUid", "==", authorUid),
      orderBy("createdAt", "desc"),
    ], true)).filter((post) => !isPrivateStatus(post.status));
  }
  const snap = await getDocsFromServer(query(
    collection(db, DRAFTS_COLLECTION),
    where("authorUid", "==", authorUid),
    where("status", "==", status),
    orderBy("createdAt", "desc"),
  ));
  return snap.docs.map((d) => docToPost(d.id, d.data()));
}

export async function publishStoredPost(postId: string): Promise<void> {
  const db = getClientDb();
  const draftRef = doc(db, DRAFTS_COLLECTION, postId);
  const draft = await getDoc(draftRef);
  if (draft.exists()) {
    await setDoc(doc(db, POSTS_COLLECTION, postId), {
      ...draft.data(),
      status: "published",
      updatedAt: serverTimestamp(),
    });
    await deleteDoc(draftRef);
    return;
  }
  await updateDoc(doc(db, POSTS_COLLECTION, postId), {
    status: "published",
    updatedAt: serverTimestamp(),
  });
}

export async function publishDueScheduledPosts(authorUid: string): Promise<number> {
  const scheduled = await getMyPostsByStatus(authorUid, "scheduled");
  const now = Date.now();
  let published = 0;
  for (const post of scheduled) {
    const at = post.publishAt?.toMillis?.() ?? Number.POSITIVE_INFINITY;
    if (at <= now) {
      await publishStoredPost(post.id);
      published += 1;
    }
  }
  return published;
}

export async function getSettlementPosts(): Promise<Post[]> {
  const posts = await fetchPostQuery([
    where("settlementYear", ">", 0),
    orderBy("settlementYear", "desc"),
  ]);
  return posts.filter((post) => !isPrivateStatus(post.status));
}

export async function getReferencingPosts(postId: string): Promise<Post[]> {
  const db = getClientDb();
  const snap = await getDocs(
    query(
      collection(db, POSTS_COLLECTION),
      where("referencedPostIds", "array-contains", postId)
    )
  );
  return snap.docs.map((d) => docToPost(d.id, d.data())).filter((post) => !isPrivateStatus(post.status));
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
    ...readCityRecord(d.data()),
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
    ...readCityRecord(data),
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
