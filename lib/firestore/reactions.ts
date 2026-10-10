import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  setDoc,
  type CollectionReference,
  type Unsubscribe,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";
import type { ReactionCounts, ReactionType } from "@/lib/types";

function reactionsRef(postId: string) {
  return collection(getClientDb(), "posts", postId, "reactions");
}

function reactionDoc(postId: string, uid: string) {
  return doc(getClientDb(), "posts", postId, "reactions", uid);
}

export function forumReactionsRef(threadId: string, replyId: string) {
  return collection(getClientDb(), "threads", threadId, "replies", replyId, "reactions");
}

export function emptyReactionCounts(): ReactionCounts {
  return { likes: 0, agrees: 0, disputes: 0, witnessed: 0 };
}

function tally(snapshot: { docs: { id: string; data: () => { type?: ReactionType } }[] }, uid: string | undefined) {
  const counts = emptyReactionCounts();
  let userReaction: ReactionType | null = null;
  snapshot.docs.forEach((item) => {
    const data = item.data();
    if (data.type === "likes") counts.likes += 1;
    else if (data.type === "agrees") counts.agrees += 1;
    else if (data.type === "disputes") counts.disputes += 1;
    else if (data.type === "witnessed") counts.witnessed += 1;
    if (uid && item.id === uid && data.type) userReaction = data.type;
  });
  return { counts, userReaction };
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
      const next = tally(snapshot, uid);
      onData(next.counts, next.userReaction);
    },
    (err) => onError?.(err)
  );
}

export function subscribeForumReactions(
  threadId: string,
  replyId: string,
  onData: (counts: ReactionCounts, userReaction: ReactionType | null) => void,
  uid: string | undefined,
  onError?: (error: Error) => void
): Unsubscribe {
  return onSnapshot(
    forumReactionsRef(threadId, replyId),
    (snapshot) => {
      const next = tally(snapshot, uid);
      onData(next.counts, next.userReaction);
    },
    (err) => onError?.(err)
  );
}

async function toggleIn(
  reactions: CollectionReference,
  uid: string,
  type: ReactionType,
  current: ReactionType | null
) {
  const ref = doc(reactions, uid);
  if (current === type) await deleteDoc(ref);
  else await setDoc(ref, { type });
}

export async function toggleForumReaction(
  threadId: string,
  replyId: string,
  uid: string,
  type: ReactionType,
  current: ReactionType | null
): Promise<void> {
  await toggleIn(forumReactionsRef(threadId, replyId), uid, type, current);
}

export async function getReactionCounts(postId: string): Promise<ReactionCounts> {
  const snapshot = await getDocs(reactionsRef(postId));
  return tally(snapshot, undefined).counts;
}

export async function getUserReaction(
  postId: string,
  uid: string
): Promise<ReactionType | null> {
  const snapshot = await getDocs(reactionsRef(postId));
  const userDoc = snapshot.docs.find((d) => d.id === uid);
  if (!userDoc) return null;
  const type = userDoc.data().type as ReactionType | undefined;
  return type ?? null;
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
