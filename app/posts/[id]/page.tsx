"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { collection, doc, onSnapshot, query, where, getDocs } from "firebase/firestore";
import { useAuth } from "@/components/auth/AuthProvider";
import { MediaCarousel } from "@/components/posts/MediaCarousel";
import { CommentSection } from "@/components/posts/CommentSection";
import { RichText } from "@/components/wiki/RichText";
import { PostTypeBadge } from "@/components/posts/PostTypeBadge";
import { DebateThread } from "@/components/debates/DebateThread";
import { ReactionBar } from "@/components/reactions/ReactionBar";
import { EmojiReactionBar } from "@/components/reactions/EmojiReactionBar";
import { PostComments } from "@/components/posts/PostComments";
import { getClientDb } from "@/lib/firebase";
import {
  getCharacter,
  getFaction,
  getPost,
  getReferencingPosts,
} from "@/lib/firestore/posts";
import type { Character, Faction, Post } from "@/lib/types";
import type { Timestamp } from "firebase/firestore";

function formatDateTime(ts: Timestamp | undefined): string {
  if (!ts?.toDate) return "";
  return ts.toDate().toLocaleString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function PostDetailPage() {
  const params = useParams();
  const postId = params.id as string;
  const { user, loading: authLoading } = useAuth();

  const [post, setPost] = useState<Post | null>(null);
  const [faction, setFaction] = useState<Faction | null>(null);
  const [character, setCharacter] = useState<Character | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [canCreatePoll, setCanCreatePoll] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [referenced, setReferenced] = useState<Post[]>([]);
  const [backlinks, setBacklinks] = useState<Post[]>([]);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setLoading(false);
      return;
    }

    const db = getClientDb();
    let unsubscribe = () => {};

    const watch = (collectionName: "posts" | "drafts") => {
      unsubscribe();
      unsubscribe = onSnapshot(
        doc(db, collectionName, postId),
        async (snapshot) => {
          if (!snapshot.exists()) {
            if (collectionName === "posts") {
              watch("drafts");
              return;
            }
            setError("Post not found.");
            setPost(null);
            setLoading(false);
            return;
          }

          const data = snapshot.data();
          const fetched = {
            id: snapshot.id,
            ...data,
            status: data.status ?? "published",
          } as Post;
          setPost(fetched);
          setError(null);

          const [f, c] = await Promise.all([
            getFaction(fetched.factionId),
            getCharacter(fetched.characterId),
          ]);
          setFaction(f);
          setCharacter(c);
          setLoading(false);
        },
        () => {
          setError("Could not load this post.");
          setLoading(false);
        }
      );
    };

    watch("posts");
    return () => unsubscribe();
  }, [postId, user, authLoading]);

  useEffect(() => {
    if (!user || !post || post.poll) {
      setCanCreatePoll(false);
      return;
    }

    async function checkPollPermission() {
      const db = getClientDb();
      const memberSnap = await getDocs(
        query(
          collection(db, "faction_members"),
          where("uid", "==", user!.uid),
          where("factionId", "==", post!.factionId)
        )
      );
      setCanCreatePoll(!memberSnap.empty);
    }

    checkPollPermission().catch(() => setCanCreatePoll(false));
  }, [user, post]);

  useEffect(() => {
    if (!post) return;
    Promise.all([
      Promise.all((post.referencedPostIds ?? []).map((id) => getPost(id))),
      getReferencingPosts(post.id),
    ])
      .then(([refs, incoming]) => {
        setReferenced(refs.filter((item): item is Post => Boolean(item)));
        setBacklinks(incoming);
      })
      .catch(() => undefined);
  }, [post]);

  if (authLoading || loading) {
    return <div className="text-center py-16 text-text-muted">Loading…</div>;
  }

  if (!user) {
    return (
      <div className="max-w-lg mx-auto py-16 px-4 text-center">
        <p className="text-text-muted mb-4">Sign in to view posts.</p>
        <Link href="/login" className="btn">
          Sign In
        </Link>
      </div>
    );
  }

  if (error || !post) {
    return (
      <div className="max-w-lg mx-auto py-16 px-4 text-center">
        <p className="text-text-muted mb-4">{error ?? "Post not found."}</p>
        <Link href="/" className="btn">
          Back to feed
        </Link>
      </div>
    );
  }

  const factionColor = faction?.colors?.primary ?? "#169C9C";
  const hidden = Boolean(post.spoiler || post.contentWarning) && !revealed;
  const media = post.media?.length
    ? post.media
    : (post.images ?? []).map((url) => ({ url, type: "image" as const }));

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] py-8 px-4">
      <div className="max-w-3xl mx-auto">
        <Link
          href="/"
          className="text-accent-gold text-sm hover:text-accent-gold-hover mb-6 inline-block"
        >
          ← Back to feed
        </Link>

        <article
          className={`glass-panel p-6 md:p-8 ${post.pinned ? "ring-2 ring-accent-gold" : ""}`}
          style={{ borderLeftColor: factionColor, borderLeftWidth: "4px" }}
        >
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <PostTypeBadge type={post.type} />
            {post.pinned && (
              <span className="text-xs font-bold text-accent-gold uppercase">
                Pinned
              </span>
            )}
            <span className="text-text-muted text-sm ml-auto">
              {formatDateTime(post.createdAt)}
            </span>
          </div>

          <h1 className="text-3xl md:text-4xl font-bold text-text-light mb-3">
            {post.title}
          </h1>

          <p className="text-accent-gold mb-6">
            {character?.name ?? faction?.name ?? "City"}
            {character?.title && (
              <span className="text-text-muted"> · {character.title}</span>
            )}
            <span className="text-text-muted"> · </span>
            {faction ? <Link href={`/cities/${faction.slug}`}>{faction.name}</Link> : "Unknown city"}
            {post.settlementYear ? <span className="text-text-muted"> · Year {post.settlementYear}</span> : null}
            {post.era ? <span className="text-text-muted"> · {post.era}</span> : null}
          </p>

          {hidden && (
            <button type="button" className="btn mb-6" onClick={() => setRevealed(true)}>
              {post.contentWarning ? `Content warning: ${post.contentWarning}. Show post` : "Show spoiler"}
            </button>
          )}

          <div className={hidden ? "blur-xl select-none pointer-events-none" : ""}>
          {media.length > 0 && (
            <div className="mb-8">
              <MediaCarousel media={media} title={post.title} />
            </div>
          )}

          {post.body && (
            <div className="mb-8">
              <RichText html={post.body} />
            </div>
          )}
          </div>

          {referenced.length > 0 && (
            <div className="mb-6 space-y-2">
              <h2 className="text-accent-gold font-bold">References</h2>
              {referenced.map((item) => (
                <Link key={item.id} href={`/posts/${item.id}`} className="block border border-primary-brown rounded p-3 hover:border-accent-gold">
                  {item.title}
                </Link>
              ))}
            </div>
          )}

          {backlinks.length > 0 && (
            <div className="mb-6 space-y-2">
              <h2 className="text-accent-gold font-bold">Referenced by</h2>
              {backlinks.map((item) => (
                <Link key={item.id} href={`/posts/${item.id}`} className="block text-sm hover:text-accent-gold">
                  {item.title}
                </Link>
              ))}
            </div>
          )}

          <EmojiReactionBar target={{ kind: "post", postId: post.id, authorUid: post.authorUid, title: post.title }} />
          <div className="mt-4">
            <PostComments postId={post.id} postAuthorUid={post.authorUid} postTitle={post.title} anchor="comments" />
          </div>

          <ReactionBar postId={post.id} />

          {post.type === "debate" ? (
            <DebateThread post={post} canCreatePoll={canCreatePoll} />
          ) : (
            <CommentSection postId={post.id} postFactionId={post.factionId} />
          )}

          {post.type === "event" && (
            <p className="text-text-muted text-sm italic border-t border-primary-brown pt-4">
              Realm event
            </p>
          )}

          {post.type === "wiki" && (
            <p className="text-text-muted text-sm italic border-t border-primary-brown pt-4">
              Wiki entry — full wiki sections on faction pages in Phase 4.
            </p>
          )}
        </article>
      </div>
    </div>
  );
}
