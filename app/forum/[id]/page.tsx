"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useAuth } from "@/components/auth/AuthProvider";
import { addReply, getThread, listReplies, type ForumReply, type ForumThread } from "@/lib/firestore/forum";
import { StoredImage } from "@/components/media/StoredImage";
import { UPLOAD_FAILED_MESSAGE } from "@/lib/images";
import { ScreenStatus } from "@/components/layout/ScreenStatus";

export default function ThreadPage() {
  const params = useParams<{ id: string }>();
  const { user, profile } = useAuth();
  const [thread, setThread] = useState<ForumThread | null>(null);
  const [replies, setReplies] = useState<ForumReply[]>([]);
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [quote, setQuote] = useState<ForumReply | null>(null);
  const [error, setError] = useState("");
  const [missing, setMissing] = useState(false);

  const load = () => {
    if (!params.id) return;
    Promise.all([getThread(params.id), listReplies(params.id)])
      .then(([item, items]) => {
        if (!item) setMissing(true);
        setThread(item);
        setReplies(items);
      })
      .catch(() => setMissing(true));
  };

  useEffect(() => {
    load();
  }, [params.id]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!user || !thread || !body.trim()) return;
    setError("");
    try {
      await addReply({
        threadId: thread.id,
        body,
        authorUid: user.uid,
        authorName: profile?.displayName || "Member",
        quoteReplyId: quote?.id || null,
        quoteExcerpt: quote ? `${quote.authorName}: ${quote.body}` : "",
        files,
        replyCount: thread.replyCount,
      });
      setBody("");
      setFiles([]);
      setQuote(null);
      load();
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      setError(
        files.length > 0
          ? message.includes("under")
            ? message
            : UPLOAD_FAILED_MESSAGE
          : message || "Could not post that reply."
      );
    }
  };

  if (missing) return <ScreenStatus>That thread is not available.</ScreenStatus>;
  if (!thread) return <ScreenStatus>Loading…</ScreenStatus>;

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] p-6">
      <div className="max-w-3xl mx-auto space-y-4">
        <Link href="/forum" className="text-accent-gold text-sm">← Forum</Link>
        <article className="glass-panel p-6 space-y-3">
          <h1 className="text-3xl font-bold text-accent-gold">{thread.title}</h1>
          <p className="text-sm text-text-muted">{thread.authorName}</p>
          <p className="whitespace-pre-wrap">{thread.body}</p>
          {thread.imageUrls.map((url) => (
            <StoredImage key={url} src={url} alt="" className="rounded border border-primary-brown max-h-96 w-auto" />
          ))}
        </article>
        {replies.map((reply) => (
          <article key={reply.id} className="glass-panel p-4 space-y-2">
            {reply.quoteExcerpt && (
              <blockquote className="border-l-2 border-accent-gold pl-3 text-sm text-text-muted">{reply.quoteExcerpt}</blockquote>
            )}
            <p className="text-sm font-bold">{reply.authorName}</p>
            <p className="whitespace-pre-wrap">{reply.body}</p>
            {reply.imageUrls.map((url) => (
              <StoredImage key={url} src={url} alt="" className="rounded border border-primary-brown max-h-80 w-auto" />
            ))}
            {user && (
              <button type="button" className="text-sm text-accent-gold" onClick={() => setQuote(reply)}>Quote</button>
            )}
          </article>
        ))}
        {user ? (
          <form onSubmit={submit} className="glass-panel p-4 space-y-3">
            {quote && (
              <p className="text-sm text-text-muted">
                Quoting {quote.authorName}. <button type="button" className="text-accent-gold" onClick={() => setQuote(null)}>Clear</button>
              </p>
            )}
            <textarea className="form-input" rows={4} value={body} onChange={(event) => setBody(event.target.value)} required placeholder="Reply" />
            <input className="form-input" type="file" accept="image/*" multiple onChange={(event) => setFiles([...(event.target.files || [])])} />
            {error && <p className="text-sm font-bold" role="alert">{error}</p>}
            <button className="btn text-sm px-4 py-2" type="submit">Reply</button>
          </form>
        ) : (
          <p className="text-text-muted">Sign in to reply.</p>
        )}
      </div>
    </div>
  );
}
