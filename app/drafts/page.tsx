"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/components/auth/AuthProvider";
import { getMyPostsByStatus, publishStoredPost } from "@/lib/firestore/posts";
import { ScreenStatus } from "@/components/layout/ScreenStatus";
import { actionError } from "@/lib/async";
import { LoadNotice } from "@/components/ui/LoadNotice";
import type { Post } from "@/lib/types";

export default function DraftsPage() {
  const { user } = useAuth();
  const [drafts, setDrafts] = useState<Post[]>([]);
  const [scheduled, setScheduled] = useState<Post[]>([]);
  const [error, setError] = useState("");

  const load = () => {
    if (!user) return;
    setError("");
    Promise.all([getMyPostsByStatus(user.uid, "draft"), getMyPostsByStatus(user.uid, "scheduled")])
      .then(([draftList, scheduledList]) => {
        setDrafts(draftList);
        setScheduled(scheduledList);
      })
      .catch((err) => setError(actionError(err, "Could not load drafts.")));
  };

  useEffect(() => {
    load();
  }, [user]);

  if (!user) return <ScreenStatus>Sign in to see drafts.</ScreenStatus>;

  const publishNow = async (postId: string) => {
    await publishStoredPost(postId);
    load();
  };

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] p-6">
      <div className="max-w-2xl mx-auto space-y-6">
        <h1 className="text-3xl font-bold text-accent-gold">Drafts</h1>
        <LoadNotice message={error} onRetry={load} />
        {[...drafts, ...scheduled].map((post) => (
          <article key={post.id} className="glass-panel p-4 flex justify-between gap-3">
            <div>
              <p className="text-xs uppercase text-accent-gold">{post.status}</p>
              <Link href={`/posts/${post.id}`} className="font-bold">{post.title}</Link>
            </div>
            <button type="button" className="btn text-sm px-3 py-1" onClick={() => publishNow(post.id)}>Publish</button>
          </article>
        ))}
        {!error && drafts.length + scheduled.length === 0 && <p className="text-text-muted">No drafts or scheduled posts.</p>}
      </div>
    </div>
  );
}
