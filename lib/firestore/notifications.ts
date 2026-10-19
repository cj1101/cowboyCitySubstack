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
  writeBatch,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";
import type { AppNotification, NotificationType } from "@/lib/types";

const LABELS: Record<NotificationType, string> = {
  mention: "Mention",
  reference: "Reference",
  reply: "Reply",
  dm: "Message",
  approval: "Approval",
  treaty: "Treaty",
  reaction: "Reaction",
  comment: "Comment",
  report: "Bug report",
};

export function notificationLabel(item: Pick<AppNotification, "type" | "kind">): string {
  if (item.type === "treaty") {
    if (item.kind === "invite") return "Treaty invite";
    if (item.kind === "counter") return "Counter-proposal";
    if (item.kind === "ratified") return "Ratification";
  }
  return LABELS[item.type] || "Notice";
}

export async function notify(input: {
  recipientUid: string;
  type: NotificationType;
  summary: string;
  href: string;
  actorUid?: string;
  kind?: string;
}): Promise<void> {
  if (!input.recipientUid || input.recipientUid === input.actorUid) return;
  const db = getClientDb();
  const payload: Record<string, unknown> = {
    recipientUid: input.recipientUid,
    type: input.type,
    summary: input.summary.slice(0, 500),
    href: input.href,
    read: false,
    actorUid: input.actorUid ?? null,
    createdAt: serverTimestamp(),
  };
  if (input.kind) payload.kind = input.kind.slice(0, 40);
  await addDoc(collection(db, "notifications"), payload);
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

export async function markAllNotificationsRead(uid: string): Promise<number> {
  const snap = await getDocs(notificationsQuery(uid));
  const unread = snap.docs.filter((d) => d.data().read !== true);
  if (unread.length === 0) return 0;
  const batch = writeBatch(getClientDb());
  unread.forEach((item) => batch.update(item.ref, { read: true }));
  await batch.commit();
  return unread.length;
}

/** The notices list lives at /notifications. Older links used /notices. */
export function notificationHref(href: string | undefined): string {
  const value = href || "/";
  if (value === "/notices" || value.startsWith("/notices/") || value.startsWith("/notices?") || value.startsWith("/notices#")) {
    return `/notifications${value.slice("/notices".length)}`;
  }
  return value;
}

export function toNotification(id: string, data: Record<string, unknown>): AppNotification {
  return {
    id,
    recipientUid: data.recipientUid as string,
    type: data.type as NotificationType,
    summary: (data.summary as string) || "",
    href: notificationHref(data.href as string | undefined),
    read: data.read === true,
    actorUid: (data.actorUid as string) || undefined,
    kind: (data.kind as string) || undefined,
    createdAt: data.createdAt as AppNotification["createdAt"],
  };
}
