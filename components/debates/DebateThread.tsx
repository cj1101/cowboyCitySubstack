"use client";

import { useEffect, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";
import { subscribeReplies } from "@/lib/firestore/replies";
import { StanceTag } from "@/components/debates/StanceTag";
import { ReplyForm } from "@/components/debates/ReplyForm";
import { PollWidget } from "@/components/debates/PollWidget";
import type { Post, Reply } from "@/lib/types";

interface DebateThreadProps {
  post: Post;
  canCreatePoll?: boolean;
}

interface ReplyMeta {
  characterName: string;
  factionName: string;
}

function formatTimestamp(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const ts = value as { toDate?: () => Date };
  if (typeof ts.toDate === "function") {
    return ts.toDate().toLocaleString();
  }
  return "";
}

export function DebateThread({ post, canCreatePoll = false }: DebateThreadProps) {
  const [replies, setReplies] = useState<Reply[]>([]);
  const [meta, setMeta] = useState<Record<string, ReplyMeta>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = subscribeReplies(
      post.id,
      (data) => {
        setReplies(data);
        setLoading(false);
      },
      () => setLoading(false)
    );
    return unsubscribe;
  }, [post.id]);

  useEffect(() => {
    async function loadMeta() {
      const db = getClientDb();
      const next: Record<string, ReplyMeta> = {};

      for (const reply of replies) {
        const key = `${reply.factionId}_${reply.characterId}`;
        if (next[key]) continue;

        const [factionSnap, characterSnap] = await Promise.all([
          reply.factionId ? getDoc(doc(db, "factions", reply.factionId)) : Promise.resolve(null),
          reply.characterId ? getDoc(doc(db, "characters", reply.characterId)) : Promise.resolve(null),
        ]);

        next[key] = {
          factionName: factionSnap?.exists()
            ? (factionSnap.data().name as string)
            : reply.factionId,
          characterName: characterSnap?.exists()
            ? (characterSnap.data().name as string)
            : reply.characterId,
        };
      }

      setMeta(next);
    }

    if (replies.length > 0) {
      loadMeta().catch(() => {});
    }
  }, [replies]);

  const forCount = replies.filter((r) => r.stance === "for").length;
  const againstCount = replies.filter((r) => r.stance === "against").length;
  const neutralCount = replies.filter((r) => r.stance === "neutral").length;

  return (
    <section className="mt-8">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
        <h2 className="text-xl font-bold text-accent-gold">Debate Thread</h2>
        <div className="flex gap-3 text-sm text-text-muted">
          <span className="text-green-300">{forCount} for</span>
          <span className="text-red-300">{againstCount} against</span>
          <span>{neutralCount} neutral</span>
        </div>
      </div>

      <PollWidget postId={post.id} poll={post.poll} canCreate={canCreatePoll} />

      {loading ? (
        <p className="text-text-muted text-sm mt-6">Loading replies…</p>
      ) : replies.length === 0 ? (
        <p className="text-text-muted text-sm mt-6">
          No replies yet. Be the first to weigh in.
        </p>
      ) : (
        <ul className="mt-6 space-y-4">
          {replies.map((reply) => {
            const key = `${reply.factionId}_${reply.characterId}`;
            const replyMeta = meta[key];

            return (
              <li
                key={reply.id}
                className="glass-panel p-4 border border-primary-brown"
              >
                <div className="flex items-start justify-between gap-3 flex-wrap mb-2">
                  <div>
                    <span className="font-bold text-accent-gold">
                      {replyMeta?.characterName ?? "Unknown"}
                    </span>
                    <span className="text-text-muted text-sm ml-2">
                      of {replyMeta?.factionName ?? reply.factionId}
                    </span>
                  </div>
                  <StanceTag stance={reply.stance} size="sm" />
                </div>
                <p className="text-text-light whitespace-pre-wrap">{reply.body}</p>
                <p className="text-text-muted text-xs mt-2">
                  {formatTimestamp(reply.createdAt)}
                </p>
              </li>
            );
          })}
        </ul>
      )}

      <ReplyForm postId={post.id} postFactionId={post.factionId} />
    </section>
  );
}
