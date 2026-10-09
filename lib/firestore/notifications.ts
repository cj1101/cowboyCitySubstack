import {
  addDoc,
  collection,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";
import type { AppNotification, NotificationType } from "@/lib/types";

export async function notify(input: {
  recipientUid: string;
  type: NotificationType;
  summary: string;
  href: string;
  actorUid?: string;
}): Promise<void> {
  if (!input.recipientUid || input.recipientUid === input.actorUid) return;
  const db = getClientDb();
  await addDoc(collection(db, "notifications"), {
    recipientUid: input.recipientUid,
    type: input.type,
    summary: input.summary.slice(0, 500),
    href: input.href,
    read: false,
    actorUid: input.actorUid ?? null,
    createdAt: serverTimestamp(),
  });
}

export async function notifyMany(
  recipientUids: string[],
  input: Omit<Parameters<typeof notify>[0], "recipientUid">
): Promise<void> {
  const unique = [...new Set(recipientUids)];
  await Promise.all(unique.map((recipientUid) => notify({ ...input, recipientUid }).catch(() => undefined)));
}

export function notificationsQuery(uid: string) {
  return query(
    collection(getClientDb(), "notifications"),
    where("recipientUid", "==", uid),
    orderBy("createdAt", "desc"),
    limit(40)
  );
}

export async function markNotificationRead(id: string): Promise<void> {
  await updateDoc(doc(getClientDb(), "notifications", id), { read: true });
}

export async function markAllNotificationsRead(uid: string): Promise<void> {
  const snap = await getDocs(notificationsQuery(uid));
  await Promise.all(
    snap.docs
      .filter((d) => d.data().read !== true)
      .map((d) => updateDoc(d.ref, { read: true }))
  );
}

export function toNotification(id: string, data: Record<string, unknown>): AppNotification {
  return {
    id,
    recipientUid: data.recipientUid as string,
    type: data.type as NotificationType,
    summary: (data.summary as string) || "",
    href: (data.href as string) || "/",
    read: data.read === true,
    actorUid: (data.actorUid as string) || undefined,
    createdAt: data.createdAt as AppNotification["createdAt"],
  };
}
