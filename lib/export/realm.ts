import { collection, getDocs, query, where } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";
import { getWikiEntriesForCity } from "@/lib/firestore/wikiEntries";
import { getFactionById, getFactionsForUser } from "@/lib/firestore/factions";
import { zipStore } from "@/lib/export/zip";

function jsonReplacer(_key: string, value: unknown) {
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    return (value.toDate as () => Date)().toISOString();
  }
  return value;
}

export async function buildRealmExport(uid: string): Promise<{ json: string; zip: Blob }> {
  const db = getClientDb();
  const cities = await getFactionsForUser(uid);
  const postsSnap = await getDocs(query(collection(db, "posts"), where("authorUid", "==", uid)));
  const authored = postsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const seen = new Set(authored.map((post) => post.id as string));
  const cityPosts = [];
  for (const city of cities) {
    const snap = await getDocs(
      query(collection(db, "posts"), where("cityIds", "array-contains", city.id))
    );
    for (const docSnap of snap.docs) {
      if (seen.has(docSnap.id)) continue;
      seen.add(docSnap.id);
      cityPosts.push({ id: docSnap.id, ...docSnap.data() });
    }
  }

  const wiki = [];
  for (const city of cities) {
    const entries = await getWikiEntriesForCity(city.id);
    wiki.push(...entries);
    const full = await getFactionById(city.id);
    if (full) Object.assign(city, full);
  }

  const payload = {
    exportedAt: new Date().toISOString(),
    uid,
    cities,
    posts: [...authored, ...cityPosts],
    wiki,
  };
  const json = JSON.stringify(payload, jsonReplacer, 2);
  const bytes = new TextEncoder().encode(json);
  return {
    json,
    zip: zipStore([{ name: "cowboy-city-realm.json", data: bytes }]),
  };
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
