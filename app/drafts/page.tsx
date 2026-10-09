"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { useAuth } from "@/components/auth/AuthProvider";
import { getClientDb } from "@/lib/firebase";
import { getMyPostsByStatus } from "@/lib/firestore/posts";
import type { Post } from "@/lib/types";

export default function DraftsPage() {
  const { user } = useAuth();
  const [drafts, setDrafts] = useState<Post[]>([]);
  const [scheduled, setScheduled] = useState<Post[]>([]);

  const load = () => {
    if (!user) return;
    Promise.all([getMyPostsByStatus(user.uid, "draft"), getMyPostsByStatus(user.uid, "scheduled")])
      .then(([draftList, scheduledList]) => {
        setDrafts(draftList);
        setScheduled(scheduledList);
      })
      .catch(() => undefined);
  };

  useEffect(() => {
    load();
  }, [user]);

  if (!user) return null;

  const publishNow = async (postId: string) => {
    await updateDoc(doc(getClientDb(), "posts", postId), { status: "published", updatedAt: serverTimestamp() });
    load();
  };

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] p-6">
      <div className="max-w-2xl mx-auto space-y-6">
        <h1 className="text-3xl font-bold text-accent-gold">Drafts</h1>
        {[...drafts, ...scheduled].map((post) => (
          <article key={post.id} className="glass-panel p-4 flex justify-between gap-3">
            <div>
              <p className="text-xs uppercase text-accent-gold">{post.status}</p>
              <Link href={`/posts/${post.id}`} className="font-bold">{post.title}</Link>
            </div>
            <button type="button" className="btn text-sm px-3 py-1" onClick={() => publishNow(post.id)}>Publish</button>
          </article>
        ))}
        {drafts.length + scheduled.length === 0 && <p className="text-text-muted">No drafts or scheduled posts.</p>}
      </div>
    </div>
  );
}
