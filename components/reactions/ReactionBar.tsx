"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { actionError } from "@/lib/async";
import {
  subscribeForumReactions,
  subscribeReactions,
  toggleForumReaction,
  toggleReaction,
} from "@/lib/firestore/reactions";
import type { ReactionCounts, ReactionType } from "@/lib/types";

interface ReactionBarProps {
  postId?: string;
  threadId?: string;
  replyId?: string;
}

const REACTIONS: {
  type: ReactionType;
  label: string;
  icon: string;
  activeClass: string;
}[] = [
  {
    type: "likes",
    label: "Like",
    icon: "★",
    activeClass: "border-accent-yellow bg-accent-yellow/40 text-on-yellow",
  },
  {
    type: "agrees",
    label: "Agrees",
    icon: "🤝",
    activeClass: "border-green-500 bg-green-900/30 text-green-200",
  },
  {
    type: "disputes",
    label: "Disputes",
    icon: "⚔️",
    activeClass: "border-red-500 bg-red-900/30 text-red-200",
  },
  {
    type: "witnessed",
    label: "Witnessed",
    icon: "👁️",
    activeClass: "border-accent-gold bg-accent-gold/20 text-accent-gold",
  },
];

export function ReactionBar({ postId, threadId, replyId, compact }: ReactionBarProps & { compact?: boolean }) {
  const { user } = useAuth();
  const [counts, setCounts] = useState<ReactionCounts>({
    likes: 0,
    agrees: 0,
    disputes: 0,
    witnessed: 0,
  });
  const [userReaction, setUserReaction] = useState<ReactionType | null>(null);
  const [pending, setPending] = useState<ReactionType | null>(null);
  const [error, setError] = useState("");
  const forum = Boolean(threadId && replyId);

  useEffect(() => {
    const onData = (nextCounts: ReactionCounts, nextUserReaction: ReactionType | null) => {
      setCounts(nextCounts);
      setUserReaction(nextUserReaction);
    };
    const onError = () => setError("Could not load reactions.");
    if (forum && threadId && replyId) {
      return subscribeForumReactions(threadId, replyId, onData, user?.uid, onError);
    }
    if (!postId) return;
    return subscribeReactions(postId, onData, user?.uid, onError);
  }, [postId, threadId, replyId, forum, user?.uid]);

  const handleReaction = async (type: ReactionType) => {
    if (!user) return;

    setPending(type);
    setError("");
    try {
      if (forum && threadId && replyId) {
        await toggleForumReaction(threadId, replyId, user.uid, type, userReaction);
      } else if (postId) {
        await toggleReaction(postId, user.uid, type, userReaction);
      }
    } catch (err) {
      setError(actionError(err, "Could not save that reaction."));
    } finally {
      setPending(null);
    }
  };

  return (
    <div className={`flex flex-wrap gap-2 ${compact ? "mt-2" : "mt-6 pt-4 border-t border-primary-brown"}`}>
      {REACTIONS.map(({ type, label, icon, activeClass }) => {
        const isActive = userReaction === type;
        const count = counts[type];

        return (
          <button
            key={type}
            type="button"
            disabled={!user || pending !== null}
            onClick={() => handleReaction(type)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg border-2 text-sm font-bold transition-all ${
              isActive
                ? activeClass
                : "border-primary-brown text-text-muted hover:border-accent-gold hover:text-accent-gold"
            } ${!user ? "opacity-60 cursor-not-allowed" : "cursor-pointer"}`}
            title={user ? `Mark as ${label.toLowerCase()}` : "Sign in to react"}
          >
            <span aria-hidden>{icon}</span>
            <span>{label}</span>
            <span className="text-xs opacity-80">({count})</span>
          </button>
        );
      })}
      {!user && (
        <span className="text-text-muted text-xs self-center">
          Sign in to react
        </span>
      )}
      {error && <p className="text-sm font-bold w-full" role="alert">{error}</p>}
    </div>
  );
}
