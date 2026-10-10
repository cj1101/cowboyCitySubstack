import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  setDoc,
  type Unsubscribe,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";
import { notify } from "@/lib/firestore/notifications";
import { EMOJI_REACTIONS, type EmojiReactionId } from "@/lib/types";

export function emojiReactionId(uid: string, emoji: EmojiReactionId): string {
  return `${uid}_${emoji}`;
}

export function emptyEmojiCounts(): Record<EmojiReactionId, number> {
  return { heart: 0, pickaxe: 0, diamond: 0, emerald: 0, blaze: 0, crown: 0 };
}

function isEmoji(value: string): value is EmojiReactionId {
  return EMOJI_REACTIONS.some((item) => item.id === value);
}

export function subscribeEmojiReactions(
  segments: string[],
  uid: string | undefined,
  onData: (counts: Record<EmojiReactionId, number>, mine: EmojiReactionId[]) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  return onSnapshot(
    collection(getClientDb(), segments[0], ...segments.slice(1)),
    (snapshot) => {
      const counts = emptyEmojiCounts();
      const mine: EmojiReactionId[] = [];
      snapshot.docs.forEach((item) => {
        const emoji = item.data().emoji as string;
        if (!isEmoji(emoji)) return;
        counts[emoji] += 1;
        if (uid && item.data().uid === uid) mine.push(emoji);
      });
      onData(counts, mine);
    },
    (err) => onError?.(err)
  );
}

export async function toggleEmojiReaction(input: {
  segments: string[];
  uid: string;
  emoji: EmojiReactionId;
  active: boolean;
  notice?: { recipientUid?: string; actorUid: string; summary: string; href: string };
}): Promise<void> {
  const ref = doc(
    getClientDb(),
    input.segments[0],
    ...input.segments.slice(1),
    emojiReactionId(input.uid, input.emoji)
  );
  if (input.active) {
    await deleteDoc(ref);
    return;
  }
  await setDoc(ref, { uid: input.uid, emoji: input.emoji });
  if (!input.notice?.recipientUid) return;
  await notify({
    recipientUid: input.notice.recipientUid,
    actorUid: input.notice.actorUid,
    type: "reaction",
    summary: input.notice.summary,
    href: input.notice.href,
  }).catch(() => undefined);
}
