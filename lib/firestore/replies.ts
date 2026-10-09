import {
  addDoc,
  collection,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  type Unsubscribe,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";
import { notify } from "@/lib/firestore/notifications";
import { getPost } from "@/lib/firestore/posts";
import type { Reply, Stance } from "@/lib/types";

function repliesRef(postId: string) {
  return collection(getClientDb(), "posts", postId, "replies");
}

export function subscribeReplies(
  postId: string,
  onData: (replies: Reply[]) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  const q = query(repliesRef(postId), orderBy("createdAt", "asc"));
  return onSnapshot(
    q,
    (snapshot) => {
      const replies = snapshot.docs.map((d) => ({
        id: d.id,
        ...d.data(),
      })) as Reply[];
      onData(replies);
    },
    (err) => onError?.(err)
  );
}

export async function getReplies(postId: string): Promise<Reply[]> {
  const q = query(repliesRef(postId), orderBy("createdAt", "asc"));
  const snapshot = await getDocs(q);
  return snapshot.docs.map((d) => ({
    id: d.id,
    ...d.data(),
  })) as Reply[];
}

export interface CreateReplyInput {
  postId: string;
  factionId: string;
  characterId: string;
  body: string;
  stance: Stance;
  authorUid: string;
  authorName?: string;
  inCharacter?: boolean;
}

export async function createReply(input: CreateReplyInput): Promise<string> {
  const { postId, ...data } = input;
  const ref = await addDoc(repliesRef(postId), {
    ...data,
    characterId: data.characterId || "",
    inCharacter: data.inCharacter !== false,
    createdAt: serverTimestamp(),
  });
  try {
    const post = await getPost(postId);
    if (post?.authorUid) {
      await notify({
        recipientUid: post.authorUid,
        actorUid: input.authorUid,
        type: "reply",
        summary: `${input.authorName || "Someone"} replied to “${post.title}”`,
        href: `/posts/${postId}`,
      });
    }
  } catch {
    // The reply itself succeeded.
  }
  return ref.id;
}
