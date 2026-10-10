"use client";

import { useEffect, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";
import { subscribeReplies } from "@/lib/firestore/replies";
import { ReplyForm } from "@/components/debates/ReplyForm";
import { PersonName } from "@/components/profile/PersonName";
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
    <section className="space-y-3 border-t border-primary-brown pt-4">
      <p className="text-sm font-bold text-accent-gold">In-character replies</p>
      <div className="space-y-3">
        {replies.map((reply) => {
          const inCharacter = reply.inCharacter !== false;
          return (
            <article key={reply.id} className="border border-primary-brown rounded p-3">
              <p className="text-accent-gold text-sm font-bold">
                {inCharacter ? (
                  names[reply.id] || "Citizen"
                ) : reply.authorUid ? (
                  <PersonName uid={reply.authorUid} name={reply.authorName || "Member"} />
                ) : (
                  reply.authorName || "Member"
                )}
                <span className="text-text-muted font-normal"> · {inCharacter ? "in character" : "out of character"}</span>
              </p>
              <p className="text-text-light whitespace-pre-wrap mt-1">{reply.body}</p>
            </article>
          );
        })}
        {replies.length === 0 && <p className="text-text-muted text-sm">No in-character replies yet.</p>}
      </div>
      <ReplyForm postId={postId} postFactionId={postFactionId} showStance={false} heading="Add an in-character reply" />
    </section>
  );
}
