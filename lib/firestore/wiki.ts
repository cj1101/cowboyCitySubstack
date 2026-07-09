import {
  collection,
  doc,
  getDocs,
  setDoc,
  deleteDoc,
  serverTimestamp,
  writeBatch,
  query,
  orderBy,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";
import { parseMentions, type Mentions } from "@/lib/mentions";

export interface WikiSection {
  id: string;
  title: string;
  body: string;
  order: number;
  updatedAt?: unknown;
}

export interface WikiDocument {
  factionId: string;
  mentions: Mentions;
  updatedAt?: unknown;
}

function sectionsCollection(factionId: string) {
  return collection(getClientDb(), "wiki", factionId, "wiki_sections");
}

export async function getWikiSections(factionId: string): Promise<WikiSection[]> {
  const sectionsQuery = query(sectionsCollection(factionId), orderBy("order", "asc"));
  const snapshot = await getDocs(sectionsQuery);
  return snapshot.docs.map((docSnap) => ({
    id: docSnap.id,
    ...(docSnap.data() as Omit<WikiSection, "id">),
  }));
}

export async function getWikiDocument(factionId: string): Promise<WikiDocument | null> {
  const sections = await getWikiSections(factionId);
  if (sections.length === 0) return null;
  const allMentions = sections.reduce(
    (acc, section) => {
      const sectionMentions = parseMentions(section.body);
      return {
        factions: [...acc.factions, ...sectionMentions.factions],
        characters: [...acc.characters, ...sectionMentions.characters],
        posts: [...acc.posts, ...sectionMentions.posts],
      };
    },
    { factions: [] as string[], characters: [] as string[], posts: [] as string[] }
  );

  return {
    factionId,
    mentions: {
      factions: [...new Set(allMentions.factions)],
      characters: [...new Set(allMentions.characters)],
      posts: [...new Set(allMentions.posts)],
    },
  };
}

export async function saveWikiSection(
  factionId: string,
  section: Omit<WikiSection, "updatedAt">
): Promise<void> {
  const db = getClientDb();
  const sectionRef = doc(db, "wiki", factionId, "wiki_sections", section.id);

  await setDoc(sectionRef, {
    title: section.title,
    body: section.body,
    order: section.order,
    factionId,
    updatedAt: serverTimestamp(),
  });

  await updateWikiMentionsMeta(factionId);
}

export async function deleteWikiSection(factionId: string, sectionId: string): Promise<void> {
  const db = getClientDb();
  await deleteDoc(doc(db, "wiki", factionId, "wiki_sections", sectionId));
  await updateWikiMentionsMeta(factionId);
}

export async function reorderWikiSections(
  factionId: string,
  orderedSectionIds: string[]
): Promise<void> {
  const db = getClientDb();
  const batch = writeBatch(db);

  orderedSectionIds.forEach((sectionId, index) => {
    const sectionRef = doc(db, "wiki", factionId, "wiki_sections", sectionId);
    batch.update(sectionRef, { order: index, updatedAt: serverTimestamp() });
  });

  await batch.commit();
}

export async function saveAllWikiSections(
  factionId: string,
  sections: WikiSection[]
): Promise<void> {
  const db = getClientDb();
  const batch = writeBatch(db);

  sections.forEach((section, index) => {
    const sectionRef = doc(db, "wiki", factionId, "wiki_sections", section.id);
    batch.set(sectionRef, {
      title: section.title,
      body: section.body,
      order: index,
      factionId,
      updatedAt: serverTimestamp(),
    });
  });

  const wikiMetaRef = doc(db, "wiki", factionId);
  const allBodies = sections.map((s) => s.body).join("\n");
  const mentions = parseMentions(allBodies);

  batch.set(
    wikiMetaRef,
    {
      factionId,
      mentions,
      sectionCount: sections.length,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );

  await batch.commit();
}

async function updateWikiMentionsMeta(factionId: string): Promise<void> {
  const sections = await getWikiSections(factionId);
  const db = getClientDb();
  const allBodies = sections.map((s) => s.body).join("\n");
  const mentions = parseMentions(allBodies);

  await setDoc(
    doc(db, "wiki", factionId),
    {
      factionId,
      mentions,
      sectionCount: sections.length,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

export function createEmptySection(order: number): WikiSection {
  return {
    id: `section_${Date.now()}_${order}`,
    title: "",
    body: "",
    order,
  };
}
