"use client";

/**
 * The decision lifecycle runner (Phase 5 surfaces) — one governance
 * decision, submitted as one play-intake action, followed through
 * the fabric's own loop: submit → preview → the owner's hash-bound
 * confirmation (the Phase 4 `ConfirmationCard`/`PreviewCard` pair)
 * → wake → Log. This is ActionBox's lifecycle, factored for the
 * many small decision points the Phase 5 surfaces carry (a
 * situation's three decisions, a rule toggle, a mode change, a
 * mandate version) — the loop is identical; only the payload
 * differs. Nothing here writes sim collections directly, and
 * nothing is decided by the click that submits: the preview is
 * shown, and only the confirmation on that preview binds.
 */

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { SubmitButton } from "@/components/ui/SubmitButton";
import {
  confirmPlayAction,
  subscribePlayAction,
} from "@/lib/play/intake";
import type { PlayActionView } from "@/lib/play/types";
import { ConfirmationCard } from "@/components/play/ConfirmationCard";
import { PreviewCard } from "@/components/play/PreviewCard";

export interface ActionRunnerProps {
  /** The submit button's label — named for the decision itself. */
  ctaLabel: string;
  /** Builds and submits the action; called once per attempt. */
  submit: () => Promise<{ actionId: string }>;
  cityName: (cityId: string) => string;
  /** Fires once when the action resolves (e.g. refresh the queue). */
  onResolved?: () => void;
  /** Render the trigger as a quiet secondary button. */
  subtle?: boolean;
  /** Submit immediately on mount (the caller already gated the
   * decision behind its own review step — e.g. the §4.3 card). */
  autoStart?: boolean;
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "permission-denied") {
      return "That write was refused by the site's rules — members submit and confirm only their own actions, and only while signed in as a full member. Nothing was recorded.";
    }
  }
  return error instanceof Error
    ? error.message
    : "Something went wrong. Nothing was recorded.";
}

export function ActionRunner({
  ctaLabel,
  submit,
  cityName,
  onResolved,
  subtle,
  autoStart,
}: ActionRunnerProps) {
  const { user } = useAuth();
  const [actionId, setActionId] = useState<string | null>(null);
  const [view, setView] = useState<PlayActionView | null | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolvedFired = useRef(false);
  const submitRef = useRef(submit);
  submitRef.current = submit;

  const start = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await submitRef.current();
      setActionId(result.actionId);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const startedRef = useRef(false);
  useEffect(() => {
    if (autoStart && user && !startedRef.current) {
      startedRef.current = true;
      void start();
    }
  }, [autoStart, user]);

  useEffect(() => {
    if (!actionId) return;
    setView(undefined);
    resolvedFired.current = false;
    return subscribePlayAction(
      actionId,
      (next) => setView(next),
      (err) => setError(errorMessage(err))
    );
  }, [actionId]);

  useEffect(() => {
    if (view && view.status === "resolved" && !resolvedFired.current) {
      resolvedFired.current = true;
      onResolved?.();
    }
  }, [view, onResolved]);

  if (!user) return null;

  const reset = () => {
    setActionId(null);
    setView(undefined);
    setError(null);
  };

  if (actionId === null) {
    if (autoStart) {
      return (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-text-muted">
            {submitting ? "Submitting…" : "Submitting your decision…"}
          </p>
          {error ? (
            <p role="alert" className="text-sm text-red-300">
              {error}
            </p>
          ) : null}
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-2">
        <SubmitButton
          type="button"
          busy={submitting}
          busyLabel="Submitting…"
          onClick={start}
          className={subtle ? "btn btn-secondary min-h-11" : "btn min-h-11"}
        >
          {ctaLabel}
        </SubmitButton>
        {error ? (
          <p role="alert" className="text-sm text-red-300">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" aria-live="polite">
      <Lifecycle
        view={view}
        cityName={cityName}
        confirming={confirming}
        error={error}
        onConfirm={async () => {
          if (!view?.preview) return;
          setConfirming(true);
          setError(null);
          try {
            await confirmPlayAction({
              actionId: view.actionId,
              uid: user.uid,
              previewHash: view.preview.previewHash,
            });
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setConfirming(false);
          }
        }}
      />
      {(view === null ||
        (view &&
          (view.status === "resolved" ||
            view.status === "rejected" ||
            view.status === "failed"))) && (
        <button type="button" className="btn btn-secondary min-h-11" onClick={reset}>
          Done
        </button>
      )}
    </div>
  );
}

function Lifecycle({
  view,
  cityName,
  confirming,
  error,
  onConfirm,
}: {
  view: PlayActionView | null | undefined;
  cityName: (cityId: string) => string;
  confirming: boolean;
  error: string | null;
  onConfirm: () => void;
}) {
  if (view === undefined) {
    return <p className="text-sm text-text-muted">Following your decision…</p>;
  }
  if (view === null) {
    return (
      <p className="text-sm">
        This decision is gone — it was undone and erased from the world and the
        Log, as if it never happened.
      </p>
    );
  }
  switch (view.status) {
    case "received":
      return (
        <p className="text-sm">
          Submitted. The fabric has it and a preview comes next — nothing has
          been decided, and nothing in the world has changed.
        </p>
      );
    case "preview_pending":
      return <p className="text-sm">The fabric is computing your preview…</p>;
    case "awaiting_confirmation":
      return view.preview ? (
        <div className="flex flex-col gap-3">
          <PreviewCard
            preview={view.preview}
            actionType={view.actionType}
            actionText={view.actionText}
            cityName={cityName}
          />
          <ConfirmationCard
            preview={view.preview}
            cityName={cityName}
            busy={confirming}
            error={error}
            onConfirm={onConfirm}
          />
        </div>
      ) : (
        <p className="text-sm">
          The fabric marked this ready to confirm, but its preview could not be
          read back. Nothing can be confirmed from here.
        </p>
      );
    case "confirmed":
      return (
        <p className="text-sm">
          Confirmed. It takes effect at the next fabric cycle — the world moves
          only when the fabric runs on confirmed actions, never on its own.
        </p>
      );
    case "queued":
      return <p className="text-sm">Confirmed and queued for the next fabric cycle.</p>;
    case "resolving":
      return <p className="text-sm">Taking effect now…</p>;
    case "resolved": {
      const seq =
        view.firstLogSeq !== null && view.lastLogSeq !== null
          ? view.firstLogSeq === view.lastLogSeq
            ? ` (Log seq ${view.firstLogSeq})`
            : ` (Log seq ${view.firstLogSeq}–${view.lastLogSeq})`
          : "";
      return (
        <p className="text-sm">
          Done, and written to the Log{seq}. The Log is the record of what
          happened.
        </p>
      );
    }
    case "rejected":
      return (
        <p role="alert" className="text-sm">
          Refused{view.failure ? `: ${view.failure.message}` : "."} Nothing was
          recorded beyond the refusal itself.
        </p>
      );
    case "failed":
      return (
        <p role="alert" className="text-sm">
          This decision failed
          {view.failure ? `: ${view.failure.message}` : "."} The failure is on
          the record; nothing was half-applied.
        </p>
      );
    default:
      return <p className="text-sm">Status: {view.status}</p>;
  }
}
