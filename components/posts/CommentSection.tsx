"use client";

import { useEffect, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";
import { subscribeReplies } from "@/lib/firestore/replies";
import { ReplyForm } from "@/components/debates/ReplyForm";
import type { Reply } from "@/lib/types";

export function CommentSection({ postId, postFactionId }: { postId: string; postFactionId: string }) {
  const [replies, setReplies] = useState<Reply[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});

  useEffect(() => {
    return subscribeReplies(postId, (data) => setReplies(data));
  }, [postId]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const db = getClientDb();
      const next: Record<string, string> = {};
      for (const reply of replies) {
        if (reply.inCharacter === false) {
          next[reply.id] = reply.authorName || "Member";
          continue;
        }
        if (reply.characterId) {
          const snap = await getDoc(doc(db, "characters", reply.characterId));
          next[reply.id] = snap.exists() ? (snap.data().name as string) : "Character";
        } else if (reply.factionId) {
          const snap = await getDoc(doc(db, "factions", reply.factionId));
          next[reply.id] = snap.exists() ? (snap.data().name as string) : "City";
        }
      }
      if (!cancelled) setNames(next);
    }
    load().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [replies]);

  return (
    <section className="mt-8">
      <h2 className="text-xl font-bold text-accent-gold mb-3">Comments</h2>
      <div className="space-y-3">
        {replies.map((reply) => (
          <article key={reply.id} className="border border-accent-gold/20 rounded p-3">
            <p className="text-accent-gold text-sm font-bold">
              {names[reply.id] || "Citizen"}
              {reply.inCharacter === false ? <span className="text-text-muted font-normal"> · out of character</span> : null}
            </p>
            <p className="text-text-light whitespace-pre-wrap mt-1">{reply.body}</p>
          </article>
        ))}
        {replies.length === 0 && <p className="text-text-muted text-sm">No comments yet.</p>}
      </div>
      <ReplyForm postId={postId} postFactionId={postFactionId} showStance={false} />
    </section>
  );
}
