import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  setDoc,
  type Unsubscribe,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";
import type { Reaction, ReactionCounts, ReactionType } from "@/lib/types";

function reactionsRef(postId: string) {
  return collection(getClientDb(), "posts", postId, "reactions");
}

function reactionDoc(postId: string, uid: string) {
  return doc(getClientDb(), "posts", postId, "reactions", uid);
}

export function emptyReactionCounts(): ReactionCounts {
  return { agrees: 0, disputes: 0, witnessed: 0 };
}

export function subscribeReactions(
  postId: string,
  onData: (counts: ReactionCounts, userReaction: ReactionType | null) => void,
  uid: string | undefined,
  onError?: (error: Error) => void
): Unsubscribe {
  return onSnapshot(
    reactionsRef(postId),
    (snapshot) => {
      const counts = emptyReactionCounts();
      let userReaction: ReactionType | null = null;

      snapshot.docs.forEach((d) => {
        const data = d.data() as Reaction;
        if (data.type === "agrees") counts.agrees++;
        else if (data.type === "disputes") counts.disputes++;
        else if (data.type === "witnessed") counts.witnessed++;

        if (uid && d.id === uid) {
          userReaction = data.type;
        }
      });

      onData(counts, userReaction);
    },
    (err) => onError?.(err)
  );
}

export async function getReactionCounts(postId: string): Promise<ReactionCounts> {
  const snapshot = await getDocs(reactionsRef(postId));
  const counts = emptyReactionCounts();
  snapshot.docs.forEach((d) => {
    const data = d.data() as Reaction;
    if (data.type === "agrees") counts.agrees++;
    else if (data.type === "disputes") counts.disputes++;
    else if (data.type === "witnessed") counts.witnessed++;
  });
  return counts;
}

export async function getUserReaction(
  postId: string,
  uid: string
): Promise<ReactionType | null> {
  const snapshot = await getDocs(reactionsRef(postId));
  const userDoc = snapshot.docs.find((d) => d.id === uid);
  if (!userDoc) return null;
  return (userDoc.data() as Reaction).type;
}

export async function setReaction(
  postId: string,
  uid: string,
  type: ReactionType
): Promise<void> {
  await setDoc(reactionDoc(postId, uid), { type });
}

export async function removeReaction(postId: string, uid: string): Promise<void> {
  await deleteDoc(reactionDoc(postId, uid));
}

export async function toggleReaction(
  postId: string,
  uid: string,
  type: ReactionType,
  current: ReactionType | null
): Promise<void> {
  if (current === type) {
    await removeReaction(postId, uid);
  } else {
    await setReaction(postId, uid, type);
  }
}
