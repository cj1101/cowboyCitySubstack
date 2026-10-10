import {
  collection,
  getDocs,
  limit,
  query,
  where,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";
import { listReadablePending, type StoredTreaty } from "@/lib/firestore/treaties";
import { matchesQuery, queryProbe } from "@/lib/search/tokens";

export type SearchKind = "city" | "post" | "treaty" | "thread" | "wiki";

export interface SearchHit {
  id: string;
  kind: SearchKind;
  title: string;
  snippet: string;
  href: string;
}

export interface SearchResults {
  cities: SearchHit[];
  posts: SearchHit[];
  treaties: SearchHit[];
  threads: SearchHit[];
  wiki: SearchHit[];
}

const PER_KIND = 8;

function snippet(value: unknown): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (text.length <= 140) return text;
  return `${text.slice(0, 137)}…`;
}

function tokensOf(data: Record<string, unknown>): string[] {
  return Array.isArray(data.searchTokens) ? data.searchTokens.filter((item) => typeof item === "string") : [];
}

function hitFrom(
  kind: SearchKind,
  snap: QueryDocumentSnapshot,
  title: string,
  body: string,
  href: string,
  raw: string
): SearchHit | null {
  const data = snap.data() as Record<string, unknown>;
  const tokens = tokensOf(data);
  if (!matchesQuery(raw, `${title} ${body}`, tokens)) return null;
  return { id: snap.id, kind, title: title || "Untitled", snippet: snippet(body), href };
}

async function probe(collectionName: string, token: string) {
  const snap = await getDocs(
    query(collection(getClientDb(), collectionName), where("searchTokens", "array-contains", token), limit(PER_KIND))
  );
  return snap.docs;
}

export async function searchRealm(
  raw: string,
  access: { uid: string; ownsCity: boolean }
): Promise<SearchResults> {
  const probeToken = queryProbe(raw);
  if (!probeToken) {
    return { cities: [], posts: [], treaties: [], threads: [], wiki: [] };
  }
  const db = getClientDb();
  const treaties = collection(db, "treaties");
  const [cities, posts, threads, wiki, activeTreaties, brokenTreaties, pendingTreaties] = await Promise.all([
    probe("factions", probeToken),
    probe("posts", probeToken),
    probe("threads", probeToken),
    probe("wiki_entries", probeToken),
    getDocs(query(treaties, where("status", "==", "active"), where("searchTokens", "array-contains", probeToken), limit(PER_KIND))),
    getDocs(query(treaties, where("status", "==", "broken"), where("searchTokens", "array-contains", probeToken), limit(PER_KIND))),
    listReadablePending(access.uid, access.ownsCity).catch(() => [] as StoredTreaty[]),
  ]);

  const cityHits = cities
    .map((item) => {
      const data = item.data();
      return hitFrom("city", item, String(data.name || "City"), `${data.bio || data.description || ""} ${data.lore || ""}`, `/cities/${data.slug || item.id}`, raw);
    })
    .filter((item): item is SearchHit => item !== null);

  const postHits = posts
    .map((item) => {
      const data = item.data();
      return hitFrom("post", item, String(data.title || "Post"), String(data.body || data.era || ""), `/posts/${item.id}`, raw);
    })
    .filter((item): item is SearchHit => item !== null);

  const threadHits = threads
    .map((item) => {
      const data = item.data();
      return hitFrom("thread", item, String(data.title || "Thread"), String(data.body || ""), `/forum/${item.id}`, raw);
    })
    .filter((item): item is SearchHit => item !== null);

  const wikiHits = wiki
    .map((item) => {
      const data = item.data();
      const slug = String(data.citySlug || "");
      return hitFrom(
        "wiki",
        item,
        String(data.title || "Wiki"),
        `${data.summary || ""} ${data.body || ""}`,
        slug ? `/cities/${slug}/wiki#${data.slug || item.id}` : "/search",
        raw
      );
    })
    .filter((item): item is SearchHit => item !== null);

  const seen = new Set<string>();
  const treatyHits: SearchHit[] = [];
  for (const item of [...activeTreaties.docs, ...brokenTreaties.docs]) {
    const data = item.data();
    const hit = hitFrom(
      "treaty",
      item,
      String(data.name || "Treaty"),
      `${data.purpose || ""} ${data.nature || ""} ${data.status || ""}`,
      `/treaties/${item.id}`,
      raw
    );
    if (!hit || seen.has(hit.id)) continue;
    seen.add(hit.id);
    treatyHits.push(hit);
  }
  for (const treaty of pendingTreaties) {
    if (seen.has(treaty.id) || treatyHits.length >= PER_KIND) continue;
    const haystack = `${treaty.name} ${treaty.purpose} ${treaty.nature} ${treaty.terms}`;
    if (!matchesQuery(raw, haystack, treaty.searchTokens || [])) continue;
    seen.add(treaty.id);
    treatyHits.push({
      id: treaty.id,
      kind: "treaty",
      title: treaty.name,
      snippet: snippet(treaty.purpose),
      href: `/treaties/${treaty.id}`,
    });
  }

  return {
    cities: cityHits,
    posts: postHits,
    treaties: treatyHits.slice(0, PER_KIND),
    threads: threadHits,
    wiki: wikiHits,
  };
}
