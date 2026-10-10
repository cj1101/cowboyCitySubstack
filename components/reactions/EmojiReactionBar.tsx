"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { subscribeEmojiReactions, toggleEmojiReaction } from "@/lib/firestore/emojiReactions";
import { actionError } from "@/lib/async";
import { EMOJI_REACTIONS, type EmojiReactionId } from "@/lib/types";

type EmojiTarget =
  | { kind: "post"; postId: string; authorUid?: string; title: string }
  | { kind: "reply"; threadId: string; replyId: string; authorUid?: string; title: string };

function segmentsFor(target: EmojiTarget): string[] {
  if (target.kind === "post") return ["posts", target.postId, "emoji_reactions"];
  return ["threads", target.threadId, "replies", target.replyId, "emoji_reactions"];
}

function hrefFor(target: EmojiTarget): string {
  return target.kind === "post" ? `/posts/${target.postId}` : `/forum/${target.threadId}`;
}

export function EmojiReactionBar({ target }: { target: EmojiTarget }) {
  const { user, profile } = useAuth();
  const [counts, setCounts] = useState<Record<EmojiReactionId, number>>({
    heart: 0,
    pickaxe: 0,
    diamond: 0,
    emerald: 0,
    blaze: 0,
    crown: 0,
  });
  const [mine, setMine] = useState<EmojiReactionId[]>([]);
  const [pending, setPending] = useState<EmojiReactionId | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  const path = segmentsFor(target).join("/");

  useEffect(() => {
    return subscribeEmojiReactions(
      path.split("/"),
      user?.uid,
      (nextCounts, nextMine) => {
        setCounts(nextCounts);
        setMine(nextMine);
      },
      () => setError("Couldn't load reactions.")
    );
  }, [path, user?.uid]);

  const react = async (emoji: EmojiReactionId) => {
    if (!user || pending) return;
    const active = mine.includes(emoji);
    const glyph = EMOJI_REACTIONS.find((item) => item.id === emoji)?.glyph ?? "";
    const name = profile?.displayName || "Someone";
    setPending(emoji);
    setError("");
    setStatus("");
    try {
      await toggleEmojiReaction({
        segments: segmentsFor(target),
        uid: user.uid,
        emoji,
        active,
        notice: active
          ? undefined
          : {
              recipientUid: target.authorUid,
              actorUid: user.uid,
              summary: `${name} reacted ${glyph} to “${target.title}”`,
              href: hrefFor(target),
            },
      });
      setStatus(active ? "Reaction removed." : "Reaction saved.");
    } catch (err) {
      setError(actionError(err, "Could not save that reaction."));
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Likes and reactions">
        {EMOJI_REACTIONS.map((item) => {
          const active = mine.includes(item.id);
          const busy = pending === item.id;
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={active}
              aria-busy={busy}
              disabled={!user || pending !== null}
              title={user ? item.label : "Sign in to react"}
              onClick={() => react(item.id)}
              className={`inline-flex items-center gap-1.5 min-h-11 px-2.5 border-2 text-sm font-bold ${
                active
                  ? "border-ink bg-accent-yellow text-on-yellow"
                  : "border-primary-brown bg-white text-text-muted hover:border-accent-cyan"
              } disabled:opacity-60`}
            >
              <span aria-hidden>{item.glyph}</span>
              <span>{busy ? "…" : item.label}</span>
              <span className="text-xs">({counts[item.id]})</span>
            </button>
          );
        })}
      </div>
      {error && (
        <p className="text-sm font-bold" role="alert">
          {error}
        </p>
      )}
      {status && !error && (
        <p className="text-sm text-accent-gold" role="status">
          {status}
        </p>
      )}
    </div>
  );
}
