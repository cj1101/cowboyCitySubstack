import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";
import { searchTokensFrom } from "@/lib/search/tokens";
import type { WikiEntry, WikiEntryKind, WikiEntryStats } from "@/lib/types";

function toEntry(id: string, data: Record<string, unknown>): WikiEntry {
  return {
    id,
    cityId: (data.cityId as string) || "",
    citySlug: (data.citySlug as string) || "",
    kind: (data.kind as WikiEntryKind) || "place",
    title: (data.title as string) || "Untitled",
    slug: (data.slug as string) || id,
    summary: (data.summary as string) || "",
    body: (data.body as string) || "",
    stats: (data.stats as WikiEntryStats | null) ?? null,
    updatedAt: data.updatedAt as WikiEntry["updatedAt"],
  };
}

export async function getWikiEntriesForCity(cityId: string): Promise<WikiEntry[]> {
  const snap = await getDocs(
    query(collection(getClientDb(), "wiki_entries"), where("cityId", "==", cityId))
  );
  return snap.docs
    .map((d) => toEntry(d.id, d.data()))
    .sort((a, b) => a.title.localeCompare(b.title));
}

export async function getAllWikiEntries(): Promise<WikiEntry[]> {
  const snap = await getDocs(collection(getClientDb(), "wiki_entries"));
  return snap.docs.map((d) => toEntry(d.id, d.data()));
}

export async function resolveWikiLink(ref: string): Promise<WikiEntry | null> {
  const clean = ref.trim();
  const entries = await getAllWikiEntries();
  const [cityPart, entryPart] = clean.includes("/") ? clean.split("/", 2) : ["", clean];
  const needle = (entryPart || clean).toLowerCase();
  const match = entries.find((entry) => {
    const slugOk = entry.slug.toLowerCase() === needle || entry.title.toLowerCase() === needle;
    if (!slugOk) return false;
    if (!cityPart) return true;
    return entry.citySlug.toLowerCase() === cityPart.toLowerCase();
  });
  return match ?? null;
}

export async function saveWikiEntry(
  input: Omit<WikiEntry, "id" | "updatedAt"> & { id?: string }
): Promise<string> {
  const db = getClientDb();
  const payload = {
    cityId: input.cityId,
    citySlug: input.citySlug,
    kind: input.kind,
    title: input.title.trim(),
    slug: input.slug.trim(),
    summary: input.summary ?? "",
    body: input.body ?? "",
    stats: input.stats ?? null,
    searchTokens: searchTokensFrom({
      title: `${input.title} ${input.slug} ${input.kind}`,
      body: `${input.summary || ""} ${input.body || ""}`,
    }),
    updatedAt: serverTimestamp(),
  };
  if (input.id) {
    await updateDoc(doc(db, "wiki_entries", input.id), payload);
    return input.id;
  }
  const ref = await addDoc(collection(db, "wiki_entries"), payload);
  return ref.id;
}

export async function deleteWikiEntry(id: string): Promise<void> {
  await deleteDoc(doc(getClientDb(), "wiki_entries", id));
}
