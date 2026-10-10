import {
  collection,
  documentId,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter,
  updateDoc,
  type QueryConstraint,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";
import { searchTokensFrom } from "@/lib/search/tokens";

const PAGE = 40;
const MAX_PER_COLLECTION = 240;

function text(data: Record<string, unknown>, keys: string[]): string {
  return keys.map((key) => (typeof data[key] === "string" ? data[key] : "")).join(" ");
}

function needsTokens(data: Record<string, unknown>): boolean {
  return !Array.isArray(data.searchTokens) || data.searchTokens.length === 0;
}

const COLLECTIONS: { name: string; title: string[]; body: string[] }[] = [
  { name: "factions", title: ["name", "slug"], body: ["bio", "description", "lore"] },
  { name: "posts", title: ["title", "era"], body: ["body"] },
  { name: "treaties", title: ["name", "type", "purpose"], body: ["nature", "terms"] },
  { name: "threads", title: ["title"], body: ["body"] },
  { name: "wiki_entries", title: ["title", "slug", "kind"], body: ["summary", "body"] },
];

async function backfillCollection(
  name: string,
  titleKeys: string[],
  bodyKeys: string[]
): Promise<{ scanned: number; updated: number }> {
  const db = getClientDb();
  let scanned = 0;
  let updated = 0;
  let cursor: QueryDocumentSnapshot | null = null;
  while (scanned < MAX_PER_COLLECTION) {
    const constraints: QueryConstraint[] = cursor
      ? [orderBy(documentId()), startAfter(cursor), limit(PAGE)]
      : [orderBy(documentId()), limit(PAGE)];
    const snap = await getDocs(query(collection(db, name), ...constraints));
    if (snap.empty) break;
    cursor = snap.docs[snap.docs.length - 1];
    scanned += snap.size;
    const missing = snap.docs.filter((item) => needsTokens(item.data()));
    await Promise.all(
      missing.map(async (item) => {
        const data = item.data() as Record<string, unknown>;
        await updateDoc(item.ref, {
          searchTokens: searchTokensFrom({ title: text(data, titleKeys), body: text(data, bodyKeys) }),
        });
        updated += 1;
      })
    );
    if (snap.size < PAGE) break;
  }
  return { scanned, updated };
}

export async function backfillSearchTokens(): Promise<{ scanned: number; updated: number }> {
  let scanned = 0;
  let updated = 0;
  for (const target of COLLECTIONS) {
    const result = await backfillCollection(target.name, target.title, target.body);
    scanned += result.scanned;
    updated += result.updated;
  }
  return { scanned, updated };
}
