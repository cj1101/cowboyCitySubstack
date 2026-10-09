import {
  collection,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  limit,
  where,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";

export interface Mentions {
  factions: string[];
  characters: string[];
  posts: string[];
}

export interface MentionTarget {
  type: "faction" | "character" | "post";
  id: string;
  label: string;
  slug?: string;
}

export interface FactionSummary {
  id: string;
  name: string;
  slug: string;
}

export interface CharacterSummary {
  id: string;
  name: string;
  factionId: string;
}

export interface PostSummary {
  id: string;
  title: string;
  type: string;
  factionId: string;
  body: string;
  mentions?: Mentions;
  createdAt?: { seconds: number } | Date | null;
}

export interface LoreGraphEdge {
  sourceType: "post" | "wiki";
  sourceId: string;
  sourceLabel: string;
  targetType: "faction" | "character" | "post";
  targetId: string;
  targetLabel: string;
  targetSlug?: string;
}

export interface TimelineEntry {
  id: string;
  type: "post" | "wiki";
  postType?: string;
  title: string;
  factionId?: string;
  factionName?: string;
  date: Date;
  summary: string;
}

const FACTION_PATTERN = /@faction:([a-z0-9-]+)/gi;
const CHARACTER_PATTERN = /@character:([a-zA-Z0-9_-]+)/gi;
const POST_PATTERN = /@post:([a-zA-Z0-9_-]+)/gi;

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function parseMentions(body: string): Mentions {
  const factions = unique(
    [...body.matchAll(FACTION_PATTERN)].map((match) => match[1].toLowerCase())
  );
  const characters = unique(
    [...body.matchAll(CHARACTER_PATTERN)].map((match) => match[1])
  );
  const posts = unique([...body.matchAll(POST_PATTERN)].map((match) => match[1]));

  return { factions, characters, posts };
}

export function mergeMentions(...mentionSets: Mentions[]): Mentions {
  return {
    factions: unique(mentionSets.flatMap((m) => m.factions)),
    characters: unique(mentionSets.flatMap((m) => m.characters)),
    posts: unique(mentionSets.flatMap((m) => m.posts)),
  };
}

export function buildMentionToken(type: MentionTarget["type"], id: string): string {
  return `@${type}:${id}`;
}

function toDate(value: unknown): Date {
  if (!value) return new Date(0);
  if (value instanceof Date) return value;
  if (typeof value === "object" && value !== null && "seconds" in value) {
    return new Date((value as { seconds: number }).seconds * 1000);
  }
  return new Date(0);
}

function truncate(text: string, max = 120): string {
  const plain = text.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  if (plain.length <= max) return plain;
  return `${plain.slice(0, max)}…`;
}

export async function getAllFactions(): Promise<FactionSummary[]> {
  const db = getClientDb();
  const snapshot = await getDocs(collection(db, "factions"));
  return snapshot.docs.map((docSnap) => {
    const data = docSnap.data();
    return {
      id: docSnap.id,
      name: (data.name as string) ?? "Unknown Faction",
      slug: (data.slug as string) ?? docSnap.id,
    };
  });
}

export async function getAllCharacters(): Promise<CharacterSummary[]> {
  const db = getClientDb();
  const snapshot = await getDocs(collection(db, "characters"));
  return snapshot.docs.map((docSnap) => {
    const data = docSnap.data();
    return {
      id: docSnap.id,
      name: (data.name as string) ?? "Unknown Character",
      factionId: (data.factionId as string) ?? "",
    };
  });
}

export async function getRecentPosts(max = 200): Promise<PostSummary[]> {
  const db = getClientDb();
  const postsQuery = query(
    collection(db, "posts"),
    orderBy("createdAt", "desc"),
    limit(max)
  );
  const snapshot = await getDocs(postsQuery);
  return snapshot.docs
    .filter((docSnap) => {
      const status = docSnap.data().status;
      return status !== "draft" && status !== "scheduled";
    })
    .map((docSnap) => {
      const data = docSnap.data();
      return {
        id: docSnap.id,
        title: (data.title as string) ?? "Untitled",
        type: (data.type as string) ?? "lore",
        factionId: (data.factionId as string) ?? "",
        body: (data.body as string) ?? "",
        mentions: data.mentions as Mentions | undefined,
        createdAt: data.createdAt as PostSummary["createdAt"],
      };
    });
}

export async function searchMentionTargets(
  searchQuery: string,
  maxPerType = 8
): Promise<MentionTarget[]> {
  const q = searchQuery.toLowerCase().trim();
  const [factions, characters, posts] = await Promise.all([
    getAllFactions(),
    getAllCharacters(),
    getRecentPosts(50),
  ]);

  const factionResults: MentionTarget[] = [];
  const characterResults: MentionTarget[] = [];
  const postResults: MentionTarget[] = [];

  for (const faction of factions) {
    if (
      !q ||
      faction.name.toLowerCase().includes(q) ||
      faction.slug.toLowerCase().includes(q)
    ) {
      factionResults.push({
        type: "faction",
        id: faction.slug,
        label: faction.name,
        slug: faction.slug,
      });
    }
  }

  for (const character of characters) {
    if (!q || character.name.toLowerCase().includes(q)) {
      characterResults.push({
        type: "character",
        id: character.id,
        label: character.name,
      });
    }
  }

  for (const post of posts) {
    if (!q || post.title.toLowerCase().includes(q)) {
      postResults.push({
        type: "post",
        id: post.id,
        label: post.title,
      });
    }
  }

  return [
    ...factionResults.slice(0, maxPerType),
    ...characterResults.slice(0, maxPerType),
    ...postResults.slice(0, maxPerType),
  ];
}

export async function getFactionBySlug(slug: string): Promise<FactionSummary | null> {
  const db = getClientDb();
  const factionsQuery = query(collection(db, "factions"), where("slug", "==", slug), limit(1));
  const snapshot = await getDocs(factionsQuery);
  if (snapshot.empty) return null;
  const docSnap = snapshot.docs[0];
  const data = docSnap.data();
  return {
    id: docSnap.id,
    name: (data.name as string) ?? "Unknown Faction",
    slug: (data.slug as string) ?? slug,
  };
}

export async function isFactionOwner(uid: string, factionId: string): Promise<boolean> {
  const db = getClientDb();
  const memberDoc = await getDoc(doc(db, "faction_members", `${uid}_${factionId}`));
  return memberDoc.exists() && memberDoc.data()?.role === "owner";
}

export async function buildLoreGraph(): Promise<LoreGraphEdge[]> {
  const [factions, characters, posts] = await Promise.all([
    getAllFactions(),
    getAllCharacters(),
    getRecentPosts(200),
  ]);

  const factionBySlug = new Map(factions.map((f) => [f.slug, f]));
  const characterById = new Map(characters.map((c) => [c.id, c]));
  const postById = new Map(posts.map((p) => [p.id, p]));

  const edges: LoreGraphEdge[] = [];

  for (const post of posts) {
    const mentions = post.mentions ?? parseMentions(post.body);
    for (const slug of mentions.factions) {
      const faction = factionBySlug.get(slug);
      edges.push({
        sourceType: "post",
        sourceId: post.id,
        sourceLabel: post.title,
        targetType: "faction",
        targetId: faction?.id ?? slug,
        targetLabel: faction?.name ?? slug,
        targetSlug: slug,
      });
    }
    for (const charId of mentions.characters) {
      const character = characterById.get(charId);
      edges.push({
        sourceType: "post",
        sourceId: post.id,
        sourceLabel: post.title,
        targetType: "character",
        targetId: charId,
        targetLabel: character?.name ?? charId,
      });
    }
    for (const postId of mentions.posts) {
      const targetPost = postById.get(postId);
      edges.push({
        sourceType: "post",
        sourceId: post.id,
        sourceLabel: post.title,
        targetType: "post",
        targetId: postId,
        targetLabel: targetPost?.title ?? postId,
      });
    }
  }

  return edges;
}

export async function buildTimeline(): Promise<TimelineEntry[]> {
  const [factions, posts] = await Promise.all([getAllFactions(), getRecentPosts(100)]);
  const factionById = new Map(factions.map((f) => [f.id, f]));

  const entries: TimelineEntry[] = posts.map((post) => ({
    id: post.id,
    type: "post",
    postType: post.type,
    title: post.title,
    factionId: post.factionId,
    factionName: factionById.get(post.factionId)?.name,
    date: toDate(post.createdAt),
    summary: truncate(post.body),
  }));

  return entries.sort((a, b) => b.date.getTime() - a.date.getTime());
}

export function attachMentionsToDocument<T extends { body: string }>(
  doc: T
): T & { mentions: Mentions } {
  return {
    ...doc,
    mentions: parseMentions(doc.body),
  };
}
