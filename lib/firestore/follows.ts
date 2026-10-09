import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  where,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";

export function followId(uid: string, cityId: string): string {
  return `${uid}_${cityId}`;
}

export async function followCity(uid: string, cityId: string): Promise<void> {
  await setDoc(doc(getClientDb(), "follows", followId(uid, cityId)), {
    uid,
    cityId,
    createdAt: serverTimestamp(),
  });
}

export async function unfollowCity(uid: string, cityId: string): Promise<void> {
  await deleteDoc(doc(getClientDb(), "follows", followId(uid, cityId)));
}

export async function getFollowedCityIds(uid: string): Promise<string[]> {
  const snap = await getDocs(query(collection(getClientDb(), "follows"), where("uid", "==", uid)));
  return snap.docs.map((d) => d.data().cityId as string);
}
