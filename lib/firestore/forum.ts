import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  type Timestamp,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";
import { uploadThreadImage } from "@/lib/storage/uploads";

export interface ForumThread {
  id: string;
  title: string;
  body: string;
  imageUrls: string[];
  authorUid: string;
  authorName: string;
  cityId: string | null;
  treatyId: string | null;
  replyCount: number;
  lastActivityAt?: Timestamp;
  createdAt?: Timestamp;
}

export interface ForumReply {
  id: string;
  body: string;
  imageUrls: string[];
  authorUid: string;
  authorName: string;
  quoteReplyId: string | null;
  quoteExcerpt: string;
  createdAt?: Timestamp;
}

function toThread(id: string, data: Record<string, unknown>): ForumThread {
  return {
    id,
    title: (data.title as string) || "Untitled",
    body: (data.body as string) || "",
    imageUrls: (data.imageUrls as string[]) || [],
    authorUid: (data.authorUid as string) || "",
    authorName: (data.authorName as string) || "Member",
    cityId: (data.cityId as string) || null,
    treatyId: (data.treatyId as string) || null,
    replyCount: Number(data.replyCount ?? 0),
    lastActivityAt: data.lastActivityAt as Timestamp | undefined,
    createdAt: data.createdAt as Timestamp | undefined,
  };
}

function toReply(id: string, data: Record<string, unknown>): ForumReply {
  return {
    id,
    body: (data.body as string) || "",
    imageUrls: (data.imageUrls as string[]) || [],
    authorUid: (data.authorUid as string) || "",
    authorName: (data.authorName as string) || "Member",
    quoteReplyId: (data.quoteReplyId as string) || null,
    quoteExcerpt: (data.quoteExcerpt as string) || "",
    createdAt: data.createdAt as Timestamp | undefined,
  };
}

export async function uploadForumImages(threadId: string, files: File[]): Promise<string[]> {
  const urls: string[] = [];
  for (let index = 0; index < files.length; index += 1) {
    urls.push(await uploadThreadImage(threadId, files[index], index));
  }
  return urls;
}

export async function createThread(input: {
  title: string;
  body: string;
  authorUid: string;
  authorName: string;
  cityId: string | null;
  treatyId: string | null;
  files: File[];
}): Promise<string> {
  const ref = doc(collection(getClientDb(), "threads"));
  let imageUrls: string[] = [];
  if (input.files.length > 0) {
    imageUrls = await uploadForumImages(ref.id, input.files);
  }
  await setDoc(ref, {
    title: input.title.trim(),
    body: input.body.trim(),
    imageUrls,
    authorUid: input.authorUid,
    authorName: input.authorName,
    cityId: input.cityId,
    treatyId: input.treatyId,
    replyCount: 0,
    lastActivityAt: serverTimestamp(),
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export async function listThreads(): Promise<ForumThread[]> {
  const snap = await getDocs(
    query(collection(getClientDb(), "threads"), orderBy("lastActivityAt", "desc"), limit(50))
  );
  return snap.docs.map((item) => toThread(item.id, item.data()));
}

export async function getThread(threadId: string): Promise<ForumThread | null> {
  const snap = await getDoc(doc(getClientDb(), "threads", threadId));
  if (!snap.exists()) return null;
  return toThread(snap.id, snap.data());
}

export async function listReplies(threadId: string): Promise<ForumReply[]> {
  const snap = await getDocs(
    query(collection(getClientDb(), "threads", threadId, "replies"), orderBy("createdAt", "asc"))
  );
  return snap.docs.map((item) => toReply(item.id, item.data()));
}

export async function addReply(input: {
  threadId: string;
  body: string;
  authorUid: string;
  authorName: string;
  quoteReplyId: string | null;
  quoteExcerpt: string;
  files: File[];
  replyCount: number;
}): Promise<void> {
  const ref = doc(collection(getClientDb(), "threads", input.threadId, "replies"));
  let imageUrls: string[] = [];
  if (input.files.length > 0) {
    imageUrls = await uploadForumImages(input.threadId, input.files);
  }
  await setDoc(ref, {
    body: input.body.trim(),
    imageUrls,
    authorUid: input.authorUid,
    authorName: input.authorName,
    quoteReplyId: input.quoteReplyId,
    quoteExcerpt: input.quoteExcerpt.slice(0, 240),
    createdAt: serverTimestamp(),
  });
  await updateDoc(doc(getClientDb(), "threads", input.threadId), {
    replyCount: input.replyCount + 1,
    lastActivityAt: serverTimestamp(),
  });
}

export async function deleteThread(threadId: string): Promise<void> {
  await deleteDoc(doc(getClientDb(), "threads", threadId));
}
