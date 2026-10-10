"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useAuth } from "@/components/auth/AuthProvider";
import { addReply, getThread, listReplies, type ForumReply, type ForumThread } from "@/lib/firestore/forum";
import { StoredImage } from "@/components/media/StoredImage";
import { UPLOAD_FAILED_MESSAGE } from "@/lib/images";
import { actionError, withTimeout } from "@/lib/async";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { CameraRollInput } from "@/components/media/CameraRollInput";
import { ScreenStatus } from "@/components/layout/ScreenStatus";
import { PersonName } from "@/components/profile/PersonName";

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
  const [busy, setBusy] = useState(false);

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
    setBusy(true);
    try {
      await withTimeout(addReply({
        threadId: thread.id,
        body,
        authorUid: user.uid,
        authorName: profile?.displayName || "Member",
        quoteReplyId: quote?.id || null,
        quoteExcerpt: quote ? `${quote.authorName}: ${quote.body}` : "",
        files,
        replyCount: thread.replyCount,
      }), 20000);
      setBody("");
      setFiles([]);
      setQuote(null);
      load();
    } catch (err) {
      const message = actionError(err, "Could not post that reply.");
      setError(files.length > 0 && !message.includes("under") && !message.includes("too long") ? UPLOAD_FAILED_MESSAGE : message);
    } finally {
      setBusy(false);
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
          <p className="text-sm text-text-muted"><PersonName uid={thread.authorUid} name={thread.authorName} /></p>
          <p className="whitespace-pre-wrap">{thread.body}</p>
          {thread.imageUrls.map((url) => (
            <StoredImage key={url} src={url} alt="" className="rounded border border-primary-brown max-h-96 max-w-full w-auto" />
          ))}
        </article>
        {replies.map((reply) => (
          <article key={reply.id} className="glass-panel p-4 space-y-2">
            {reply.quoteExcerpt && (
              <blockquote className="border-l-2 border-accent-gold pl-3 text-sm text-text-muted">{reply.quoteExcerpt}</blockquote>
            )}
            <p className="text-sm font-bold"><PersonName uid={reply.authorUid} name={reply.authorName} /></p>
            <p className="whitespace-pre-wrap">{reply.body}</p>
            {reply.imageUrls.map((url) => (
              <StoredImage key={url} src={url} alt="" className="rounded border border-primary-brown max-h-80 max-w-full w-auto" />
            ))}
            {user && (
              <button type="button" className="text-sm text-accent-gold min-h-11 inline-flex items-center" onClick={() => setQuote(reply)}>Quote</button>
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
            <CameraRollInput accept="image/*" label="Add a photo" onFiles={setFiles} />
            {error && <p className="text-sm font-bold" role="alert">{error}</p>}
            <SubmitButton busy={busy} busyLabel="Replying…" className="btn text-sm px-4 py-2">Reply</SubmitButton>
          </form>
        ) : (
          <p className="text-text-muted">Sign in to reply.</p>
        )}
      </div>
    </div>
  );
}
