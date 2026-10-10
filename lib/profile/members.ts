import { doc, getDoc } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";

export interface MemberCard {
  uid: string;
  displayName: string;
  email: string;
  avatarUrl: string;
  minecraftUsername: string;
  isAdmin: boolean;
  ownsCity: boolean;
}

const cache = new Map<string, MemberCard | null>();

export function rememberMember(card: MemberCard) {
  cache.set(card.uid, card);
}

export function cachedMember(uid: string): MemberCard | null | undefined {
  return cache.get(uid);
}

export async function loadMemberCard(uid: string): Promise<MemberCard | null> {
  if (!uid) return null;
  if (cache.has(uid)) return cache.get(uid) ?? null;
  try {
    const snap = await getDoc(doc(getClientDb(), "users", uid));
    if (!snap.exists()) {
      cache.set(uid, null);
      return null;
    }
    const data = snap.data();
    const card: MemberCard = {
      uid,
      displayName: (data.displayName as string) || "",
      email: (data.email as string) || "",
      avatarUrl: (data.avatarUrl as string) || "",
      minecraftUsername: (data.minecraftUsername as string) || "",
      isAdmin: data.isAdmin === true,
      ownsCity: data.ownsCity === true,
    };
    cache.set(uid, card);
    return card;
  } catch {
    return null;
  }
}
