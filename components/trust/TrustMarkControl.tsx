"use client";

/**
 * The mark control (June §7.4): on any rendered publication, the
 * signed-in member sees THEIR OWN assessment control — "Your
 * assessment: — / credible / bullshit / unsure" + an optional note.
 * Other viewers' marks are never shown on the claim itself, and the
 * control writes only the member's own sim_trust_assessments doc
 * (through lib/trust/store, as their own browser session — an NPC
 * cannot write these, TC-P12(v)).
 *
 * Guests get no control at all: the connected variant renders nothing
 * for a signed-out viewer, and placement for guests is the caller's
 * responsibility on top of the rules fence.
 */

import { useEffect, useId, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import {
  MAX_TRUST_NOTE_LENGTH,
  TRUST_STANCES,
  attributedStanceLabel,
  isTrustStance,
  type TrustMark,
  type TrustStance,
} from "@/lib/trust/assessments";
import {
  clearTrustMark,
  loadOwnTrustAssessments,
  saveTrustMark,
} from "@/lib/trust/store";
import { actionError } from "@/lib/async";

interface TrustMarkControlProps {
  mark: TrustMark | null;
  busy?: boolean;
  disabled?: boolean;
  onSave: (stance: TrustStance, note: string | null) => void | Promise<void>;
  onClear: () => void | Promise<void>;
}

export function TrustMarkControl({
  mark,
  busy = false,
  disabled = false,
  onSave,
  onClear,
}: TrustMarkControlProps) {
  const [stance, setStance] = useState<TrustStance | null>(mark?.stance ?? null);
  const [note, setNote] = useState(mark?.note ?? "");
  const [error, setError] = useState("");
  // One control renders per publication on a city sheet — the note
  // input's id must be unique per instance or labels mis-associate.
  const noteInputId = useId();

  useEffect(() => {
    setStance(mark?.stance ?? null);
    setNote(mark?.note ?? "");
  }, [mark]);

  return (
    <div className="space-y-2">
      <p className="text-sm text-text-muted">
        {mark
          ? attributedStanceLabel("Your", mark.stance)
          : "Your assessment: —"}
      </p>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Your assessment">
        {TRUST_STANCES.map((option) => (
          <button
            key={option}
            type="button"
            className={stance === option ? "btn" : "btn-secondary"}
            disabled={busy || disabled}
            aria-pressed={stance === option}
            onClick={() => setStance(option)}
          >
            {option}
          </button>
        ))}
        {mark ? (
          <button
            type="button"
            className="btn-secondary"
            disabled={busy || disabled}
            onClick={async () => {
              setError("");
              try {
                await onClear();
                setStance(null);
                setNote("");
              } catch (err) {
                setError(actionError(err, "Could not clear your assessment."));
              }
            }}
          >
            Clear
          </button>
        ) : null}
      </div>
      <div>
        <label className="form-label" htmlFor={noteInputId}>
          Note (your words, optional)
        </label>
        <input
          id={noteInputId}
          className="form-input"
          value={note}
          maxLength={MAX_TRUST_NOTE_LENGTH}
          disabled={busy || disabled}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Why you read it this way"
        />
      </div>
      <button
        type="button"
        className="btn"
        disabled={busy || disabled || stance === null}
        onClick={async () => {
          if (!isTrustStance(stance)) return;
          setError("");
          try {
            await onSave(stance, note.trim() ? note.trim() : null);
          } catch (err) {
            setError(actionError(err, "Could not save your assessment."));
          }
        }}
      >
        Save your assessment
      </button>
      {error ? <p className="text-sm text-red-300">{error}</p> : null}
      <p className="text-xs text-text-muted">
        This is your personal read of the claim — private to you unless you
        share your separated view. It is never a system verdict.
      </p>
    </div>
  );
}

/** Connected variant: loads the signed-in member's own doc and wires
 * the control to their own assessments. Renders nothing signed-out. */
export function TrustMarkControlConnected({
  publicationId,
  subjectCityId,
}: {
  publicationId: string;
  subjectCityId: string;
}) {
  const { user } = useAuth();
  const [mark, setMark] = useState<TrustMark | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    loadOwnTrustAssessments(user.uid)
      .then((loaded) => {
        if (!cancelled) setMark(loaded.marks[publicationId] ?? null);
      })
      .catch(() => {
        if (!cancelled) setLoadError("Your assessments could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, [user, publicationId]);

  if (!user) return null;
  if (loadError) return <p className="text-sm text-text-muted">{loadError}</p>;

  return (
    <TrustMarkControl
      mark={mark}
      busy={busy}
      onSave={async (stance, note) => {
        setBusy(true);
        try {
          const next = await saveTrustMark(user.uid, publicationId, {
            stance,
            note,
            subjectCityId,
          });
          setMark(next.marks[publicationId] ?? null);
        } finally {
          setBusy(false);
        }
      }}
      onClear={async () => {
        setBusy(true);
        try {
          const next = await clearTrustMark(user.uid, publicationId);
          setMark(next.marks[publicationId] ?? null);
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}
