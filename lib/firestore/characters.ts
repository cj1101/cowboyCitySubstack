import {
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";
import type { Character, CharacterInput } from "@/lib/types";

const CHARACTERS = "characters";

function docToCharacter(id: string, data: Record<string, unknown>): Character {
  return {
    id,
    factionId: data.factionId as string,
    name: data.name as string,
    title: data.title as string | undefined,
    avatarUrl: data.avatarUrl as string | undefined,
    isActive: data.isActive !== false,
  };
}

export async function getCharactersForFaction(factionId: string): Promise<Character[]> {
  const db = getClientDb();
  const q = query(collection(db, CHARACTERS), where("factionId", "==", factionId));
  const snapshot = await getDocs(q);
  return snapshot.docs.map((d) => docToCharacter(d.id, d.data()));
}

export async function getActiveCharactersForFaction(factionId: string): Promise<Character[]> {
  const characters = await getCharactersForFaction(factionId);
  return characters.filter((c) => c.isActive);
}

export async function getCharacterById(id: string): Promise<Character | null> {
  const db = getClientDb();
  const snap = await getDoc(doc(db, CHARACTERS, id));
  if (!snap.exists()) return null;
  return docToCharacter(snap.id, snap.data());
}

export async function createCharacter(
  factionId: string,
  input: CharacterInput
): Promise<Character> {
  const db = getClientDb();
  const ref = await addDoc(collection(db, CHARACTERS), {
    factionId,
    name: input.name,
    title: input.title ?? null,
    avatarUrl: input.avatarUrl ?? null,
    isActive: input.isActive !== false,
  });
  return {
    id: ref.id,
    factionId,
    name: input.name,
    title: input.title,
    avatarUrl: input.avatarUrl,
    isActive: input.isActive !== false,
  };
}

export async function updateCharacter(
  characterId: string,
  input: Partial<CharacterInput>
): Promise<void> {
  const db = getClientDb();
  const updates: Record<string, unknown> = {};
  if (input.name !== undefined) updates.name = input.name;
  if (input.title !== undefined) updates.title = input.title;
  if (input.avatarUrl !== undefined) updates.avatarUrl = input.avatarUrl;
  if (input.isActive !== undefined) updates.isActive = input.isActive;
  await updateDoc(doc(db, CHARACTERS, characterId), updates);
}

export async function deleteCharacter(characterId: string): Promise<void> {
  const db = getClientDb();
  await deleteDoc(doc(db, CHARACTERS, characterId));
}
