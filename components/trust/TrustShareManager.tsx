"use client";

/**
 * Share management for the separated view (June §7.4): the owner lists
 * who may READ their trust-assessment view. The copy states exactly
 * what a share confers — this view only, not intel, not exports, not
 * prefs — because TC-P12(iii) scopes the grant to the view and to
 * nothing else. Removal stops the read at the next rules evaluation.
 */

import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { MAX_TRUST_SHARED_WITH } from "@/lib/trust/assessments";
import {
  loadOwnTrustAssessments,
  saveTrustSharedWith,
} from "@/lib/trust/store";
import { actionError } from "@/lib/async";

interface TrustShareManagerProps {
  sharedWith: string[];
  memberLabels?: Record<string, string>;
  busy?: boolean;
  onChange: (next: string[]) => void | Promise<void>;
}

export function TrustShareManager({
  sharedWith,
  memberLabels,
  busy = false,
  onChange,
}: TrustShareManagerProps) {
  const [uidInput, setUidInput] = useState("");
  const [error, setError] = useState("");

  const apply = async (next: string[]) => {
    setError("");
    try {
      await onChange(next);
    } catch (err) {
      setError(actionError(err, "Could not update sharing."));
    }
  };

  return (
    <div className="space-y-3">
      <h3 className="font-semibold">Who can see this view</h3>
      <p className="text-sm text-text-muted">
        Sharing lets a named member READ this separated view — and nothing
        else: not your intel, not your exports, not your dashboard prefs.
        They cannot export your assessments from a shared view. Removing
        someone stops their access at once.
      </p>
      {sharedWith.length === 0 ? (
        <p className="text-text-muted text-sm">Not shared with anyone.</p>
      ) : (
        <ul className="space-y-2">
          {sharedWith.map((uid) => (
            <li key={uid} className="flex items-center justify-between gap-3">
              <span>{memberLabels?.[uid] ?? uid}</span>
              <button
                type="button"
                className="btn-secondary"
                disabled={busy}
                onClick={() => void apply(sharedWith.filter((item) => item !== uid))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex gap-2"
        onSubmit={async (event) => {
          event.preventDefault();
          const uid = uidInput.trim();
          if (!uid || sharedWith.includes(uid)) return;
          if (sharedWith.length >= MAX_TRUST_SHARED_WITH) {
            setError(`A view can be shared with at most ${MAX_TRUST_SHARED_WITH} members.`);
            return;
          }
          await apply([...sharedWith, uid]);
          setUidInput("");
        }}
      >
        <input
          className="form-input"
          value={uidInput}
          onChange={(event) => setUidInput(event.target.value)}
          placeholder="Member ID to share with"
          aria-label="Member ID to share with"
        />
        <button type="submit" className="btn" disabled={busy}>
          Share view
        </button>
      </form>
      {error ? <p className="text-sm text-red-300">{error}</p> : null}
    </div>
  );
}

/** Connected variant: the signed-in member manages their own shares. */
export function TrustShareManagerConnected({
  memberLabels,
}: {
  memberLabels?: Record<string, string>;
}) {
  const { user } = useAuth();
  const [sharedWith, setSharedWith] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    loadOwnTrustAssessments(user.uid)
      .then((loaded) => {
        if (!cancelled) setSharedWith(loaded.sharedWith);
      })
      .catch(() => {
        if (!cancelled) setLoadError("Sharing could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  if (!user) return null;
  if (loadError) return <p className="text-sm text-text-muted">{loadError}</p>;

  return (
    <TrustShareManager
      sharedWith={sharedWith}
      memberLabels={memberLabels}
      busy={busy}
      onChange={async (next) => {
        setBusy(true);
        try {
          const saved = await saveTrustSharedWith(user.uid, next);
          setSharedWith(saved.sharedWith);
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}
