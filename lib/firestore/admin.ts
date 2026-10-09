import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";

export interface AdminUser {
  uid: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
  status: string;
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
      status: data.status ?? "pending",
      createdAt: data.createdAt,
    };
  });
}

export async function setUserAdmin(uid: string, isAdmin: boolean): Promise<void> {
  const db = getClientDb();
  await updateDoc(doc(db, "users", uid), { isAdmin });
}

export async function setUserStatus(uid: string, status: string): Promise<void> {
  const db = getClientDb();
  await updateDoc(doc(db, "users", uid), { status });
}

export async function removeUserRecord(uid: string): Promise<void> {
  await deleteDoc(doc(getClientDb(), "users", uid));
}

export async function inviteEmail(email: string, invitedBy: string): Promise<void> {
  const normalized = email.trim().toLowerCase();
  await setDoc(doc(getClientDb(), "invites", normalized), {
    email: normalized,
    invitedBy,
    status: "pending",
    createdAt: serverTimestamp(),
  });
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
