import {
  collection,
  doc,
  getDocs,
  updateDoc,
  writeBatch,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";

export interface AdminUser {
  uid: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
  createdAt?: unknown;
}

export async function getAllUsers(): Promise<AdminUser[]> {
  const db = getClientDb();
  const snap = await getDocs(collection(db, "users"));
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      uid: d.id,
      email: data.email ?? "",
      displayName: data.displayName ?? "",
      isAdmin: data.isAdmin === true,
      createdAt: data.createdAt,
    };
  });
}

export async function setUserAdmin(uid: string, isAdmin: boolean): Promise<void> {
  const db = getClientDb();
  await updateDoc(doc(db, "users", uid), { isAdmin });
}

export async function deletePost(postId: string): Promise<void> {
  const db = getClientDb();
  const batch = writeBatch(db);

  const repliesSnap = await getDocs(collection(db, "posts", postId, "replies"));
  repliesSnap.docs.forEach((d) => batch.delete(d.ref));

  const reactionsSnap = await getDocs(collection(db, "posts", postId, "reactions"));
  reactionsSnap.docs.forEach((d) => batch.delete(d.ref));

  batch.delete(doc(db, "posts", postId));
  await batch.commit();
}
