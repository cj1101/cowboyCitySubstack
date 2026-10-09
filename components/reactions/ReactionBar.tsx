"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import {
  subscribeReactions,
  toggleReaction,
} from "@/lib/firestore/reactions";
import type { ReactionCounts, ReactionType } from "@/lib/types";

interface ReactionBarProps {
  postId: string;
}

const REACTIONS: {
  type: ReactionType;
  label: string;
  icon: string;
  activeClass: string;
}[] = [
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

export function ReactionBar({ postId }: ReactionBarProps) {
  const { user } = useAuth();
  const [counts, setCounts] = useState<ReactionCounts>({
    agrees: 0,
    disputes: 0,
    witnessed: 0,
  });
  const [userReaction, setUserReaction] = useState<ReactionType | null>(null);
  const [pending, setPending] = useState<ReactionType | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeReactions(
      postId,
      (nextCounts, nextUserReaction) => {
        setCounts(nextCounts);
        setUserReaction(nextUserReaction);
      },
      user?.uid
    );
    return unsubscribe;
  }, [postId, user?.uid]);

  const handleReaction = async (type: ReactionType) => {
    if (!user) return;

    setPending(type);
    try {
      await toggleReaction(postId, user.uid, type, userReaction);
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="flex flex-wrap gap-3 mt-6 pt-4 border-t border-primary-brown">
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
    </div>
  );
}
