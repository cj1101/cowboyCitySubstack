"use client";

import { FormEvent, useEffect, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { addComment, deleteComment, subscribeComments } from "@/lib/firestore/comments";
import { actionError } from "@/lib/async";
import { isSheriff } from "@/lib/membership";
import type { PostComment } from "@/lib/types";

export function PostComments({
  postId,
  postAuthorUid,
  postTitle,
  anchor,
  variant = "section",
}: {
  postId: string;
  postAuthorUid?: string;
  postTitle: string;
  anchor?: string;
  variant?: "section" | "member";
}) {
  const { user, profile } = useAuth();
  const [comments, setComments] = useState<PostComment[]>([]);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [loadError, setLoadError] = useState("");
  const sheriff = isSheriff(profile, user?.email);

  useEffect(() => {
    return subscribeComments(
      postId,
      (next) => {
        setComments(next);
        setLoadError("");
      },
      () => setLoadError("Couldn't load comments.")
    );
  }, [postId]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!user || busy) return;
    const text = body.trim();
    if (!text) {
      setError("Write a comment first.");
      setStatus("");
      return;
    }
    if (text.length > 2000) {
      setError("Comments can be up to 2,000 characters.");
      setStatus("");
      return;
    }
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await addComment({
        postId,
        authorUid: user.uid,
        authorName: profile?.displayName || "Member",
        body: text,
        postAuthorUid,
        postTitle,
      });
      setBody("");
      setStatus("Comment posted.");
    } catch (err) {
      setError(actionError(err, "Could not post that comment."));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (commentId: string) => {
    if (deletingId) return;
    setDeletingId(commentId);
    setError("");
    setStatus("");
    try {
      await deleteComment(postId, commentId);
      setStatus("Comment removed.");
    } catch (err) {
      setError(actionError(err, "Could not remove that comment."));
    } finally {
      setDeletingId(null);
    }
  };

  const member = variant === "member";

  return (
    <section id={anchor} className={member ? "space-y-3 scroll-mt-24" : "space-y-3 border-t border-primary-brown pt-3 scroll-mt-24"}>
      <p className="text-sm font-bold text-accent-gold">
        {member ? "Member comments" : "Comments"} ({comments.length})
      </p>
      {loadError && (
        <p className="text-sm font-bold" role="alert">
          {loadError}
        </p>
      )}
      <div className="space-y-2 max-h-72 overflow-y-auto">
        {comments.map((comment) => {
          const canDelete = !!user && (comment.authorUid === user.uid || sheriff);
          const removing = deletingId === comment.id;
          return (
            <article key={comment.id} className="border border-primary-brown bg-white px-3 py-2">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-bold text-accent-gold break-words">{comment.authorName}</p>
                {canDelete && (
                  <button
                    type="button"
                    className="text-sm font-bold text-ink min-h-11 px-2 shrink-0"
                    disabled={deletingId !== null}
                    aria-busy={removing}
                    onClick={() => remove(comment.id)}
                  >
                    {removing ? "Removing…" : "Delete"}
                  </button>
                )}
              </div>
              <p className="text-sm whitespace-pre-wrap break-words">{comment.body}</p>
            </article>
          );
        })}
        {comments.length === 0 && !loadError && (
          <p className="text-sm text-text-muted">No comments yet.</p>
        )}
      </div>
      {user ? (
        <form onSubmit={submit} className="space-y-2">
          <label className="sr-only" htmlFor={`comment-${postId}`}>
            Comment on {postTitle}
          </label>
          <textarea
            id={`comment-${postId}`}
            className="form-input"
            rows={2}
            maxLength={2000}
            value={body}
            placeholder="Add a comment"
            onChange={(event) => setBody(event.target.value)}
          />
          {error && (
            <p className="text-sm font-bold" role="alert">
              {error}
            </p>
          )}
          {status && !error && (
            <p className="text-sm text-accent-gold" role="status">
              {status}
            </p>
          )}
          <SubmitButton busy={busy} busyLabel="Posting…" className="btn text-sm px-4 py-2">
            Post comment
          </SubmitButton>
        </form>
      ) : (
        <p className="text-sm text-text-muted">Sign in to comment.</p>
      )}
    </section>
  );
}
