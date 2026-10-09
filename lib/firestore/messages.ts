import {
  addDoc,
  collection,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type Unsubscribe,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";
import { notify } from "@/lib/firestore/notifications";
import type { Conversation, DirectMessage } from "@/lib/types";

export function conversationIdFor(uids: string[]): string {
  return [...uids].sort().join("__");
}

export function subscribeConversations(
  uid: string,
  onData: (conversations: Conversation[]) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  const q = query(
    collection(getClientDb(), "conversations"),
    where("participantUids", "array-contains", uid),
    orderBy("lastMessageAt", "desc")
  );
  return onSnapshot(
    q,
    (snap) => {
      onData(
        snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<Conversation, "id">),
        }))
      );
    },
    (err) => onError?.(err)
  );
}

export function subscribeMessages(
  conversationId: string,
  onData: (messages: DirectMessage[]) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  const q = query(
    collection(getClientDb(), "conversations", conversationId, "messages"),
    orderBy("createdAt", "asc")
  );
  return onSnapshot(
    q,
    (snap) => {
      onData(
        snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<DirectMessage, "id">),
        }))
      );
    },
    (err) => onError?.(err)
  );
}

export async function sendDirectMessage(input: {
  participantUids: string[];
  senderUid: string;
  body: string;
}): Promise<string> {
  const participants = [...new Set(input.participantUids)];
  if (!participants.includes(input.senderUid)) participants.push(input.senderUid);
  if (participants.length < 2 || participants.length > 8) {
    throw new Error("A conversation needs 2 to 8 people.");
  }

  const db = getClientDb();
  const id = conversationIdFor(participants);
  const ref = doc(db, "conversations", id);
  const existing = await getDoc(ref);
  const preview = input.body.trim().slice(0, 140);
  if (!existing.exists()) {
    await setDoc(ref, {
      participantUids: participants,
      lastMessageAt: serverTimestamp(),
      lastMessagePreview: preview,
      lastSenderUid: input.senderUid,
      createdAt: serverTimestamp(),
    });
  } else {
    await updateDoc(ref, {
      lastMessageAt: serverTimestamp(),
      lastMessagePreview: preview,
      lastSenderUid: input.senderUid,
    });
  }

  await addDoc(collection(db, "conversations", id, "messages"), {
    senderUid: input.senderUid,
    body: input.body.trim(),
    createdAt: serverTimestamp(),
  });

  await notifyManySafe(
    participants.filter((uid) => uid !== input.senderUid),
    input.senderUid,
    preview,
    id
  );
  return id;
}

async function notifyManySafe(uids: string[], actorUid: string, preview: string, conversationId: string) {
  await Promise.all(
    uids.map((recipientUid) =>
      notify({
        recipientUid,
        actorUid,
        type: "dm",
        summary: preview || "New message",
        href: `/messages?c=${conversationId}`,
      }).catch(() => undefined)
    )
  );
}

export async function markConversationRead(uid: string, conversationId: string): Promise<void> {
  await setDoc(
    doc(getClientDb(), "users", uid, "reads", conversationId),
    { lastReadAt: serverTimestamp() },
    { merge: true }
  );
}
