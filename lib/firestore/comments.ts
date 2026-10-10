import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  type Unsubscribe,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";
import { notify } from "@/lib/firestore/notifications";
import type { PostComment } from "@/lib/types";

function commentsQuery(postId: string) {
  return query(
    collection(getClientDb(), "posts", postId, "comments"),
    orderBy("createdAt", "asc")
  );
}

export function subscribeComments(
  postId: string,
  onData: (comments: PostComment[]) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  return onSnapshot(
    commentsQuery(postId),
    (snapshot) => {
      onData(
        snapshot.docs.map((item) => {
          const data = item.data();
          return {
            id: item.id,
            authorUid: (data.authorUid as string) || "",
            authorName: (data.authorName as string) || "Member",
            body: (data.body as string) || "",
            createdAt: data.createdAt as PostComment["createdAt"],
          };
        })
      );
    },
    (err) => onError?.(err)
  );
}

export async function addComment(input: {
  postId: string;
  authorUid: string;
  authorName: string;
  body: string;
  postAuthorUid?: string;
  postTitle: string;
}): Promise<string> {
  const ref = await addDoc(collection(getClientDb(), "posts", input.postId, "comments"), {
    authorUid: input.authorUid,
    authorName: input.authorName.slice(0, 80),
    body: input.body.trim(),
    createdAt: serverTimestamp(),
  });
  if (input.postAuthorUid) {
    await notify({
      recipientUid: input.postAuthorUid,
      actorUid: input.authorUid,
      type: "comment",
      summary: `${input.authorName} commented on “${input.postTitle}”`.slice(0, 500),
      href: `/posts/${input.postId}#comments`,
    }).catch(() => undefined);
  }
  return ref.id;
}

export async function deleteComment(postId: string, commentId: string): Promise<void> {
  await deleteDoc(doc(getClientDb(), "posts", postId, "comments", commentId));
}
