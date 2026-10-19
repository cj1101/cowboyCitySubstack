"use client";

/**
 * The never-bind confirmation card (Phase 4 brief §2.3, Petra's
 * pattern).
 *
 * A preview binds nothing: it is the fabric saying "this is exactly
 * what would happen." Confirmation is the member's separate,
 * deliberate act — this card exists so that act is made with open
 * eyes. It names, in order:
 *
 * - **what will happen** (the preview's own summary),
 * - **what it costs** (the preview's Rubar movements, verbatim —
 *   no total is invented beyond the lines themselves),
 * - **what cannot be undone** (the kind's own terms where the
 *   catalogue states them, over the standing undo rule: erasure is
 *   possible only while nothing downstream depends on the change).
 *
 * Confirmation binds to the exact preview hash; if the world has
 * moved by the wake, the commit refuses as stale, applies nothing,
 * and the member gets a fresh preview. No NPC, mandate, or
 * auto-delegation confirms in Phase 4 — this button is the member's
 * hand, or nobody's.
 */

import { SubmitButton } from "@/components/ui/SubmitButton";
import { formatSignedRubars, rubarMovements } from "@/lib/play/format";
import type { PlayActionKind, PlayPreview } from "@/lib/play/types";

export interface ConfirmationCardProps {
  preview: PlayPreview;
  /** The catalog entry for the action's kind, when structured. Its
   * `irreversibleNote` is stated in the kind's own terms. */
  kind?: PlayActionKind | null;
  cityName?: (cityId: string) => string;
  busy: boolean;
  error?: string | null;
  onConfirm: () => void;
}

export function ConfirmationCard({
  preview,
  kind,
  cityName,
  busy,
  error,
  onConfirm,
}: ConfirmationCardProps) {
  const nameOf = (cityId: string) => cityName?.(cityId) ?? cityId;
  const rejected = preview.outcome === "rejected";
  const movements = rubarMovements(preview.deltas);

  return (
    <section
      aria-label="Confirm this action"
      className="rounded border border-darker-brown bg-glass-bg p-4 flex flex-col gap-3 text-sm"
    >
      <h4 className="font-bold">Confirm this action</h4>

      <div className="flex flex-col gap-1">
        <span className="text-text-muted">What will happen</span>
        <p>
          {rejected
            ? "Nothing — the fabric will refuse this action, and the refusal is what gets recorded. Confirming puts the decision on the record; it does not force the action through."
            : preview.summaryText || "The preview recorded no summary."}
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-text-muted">What it costs</span>
        {movements.length === 0 ? (
          <p>No money moves in this preview.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {movements.map((movement, index) => (
              <li
                key={`${movement.cityId}-${movement.field}-${index}`}
                className="flex flex-wrap justify-between gap-x-3"
              >
                <span>
                  {nameOf(movement.cityId)} · {movement.field}
                </span>
                <span>{formatSignedRubars(movement.amount)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-text-muted">What cannot be undone</span>
        {kind?.irreversibleNote ? <p>{kind.irreversibleNote}</p> : null}
        <p>
          Once this resolves, it stands in the Log. An action can be undone — erased as
          if it never happened — only while nothing else depends on it. The moment
          another action, a ripening, or another city builds on it, it is permanent,
          and recovery is a new action of your own, at its own cost.
        </p>
      </div>

      <p className="text-xs text-text-muted">
        The preview above is not binding — this confirmation is. It applies exactly
        that preview, nothing more and nothing different. This is your act: no
        character, NPC, or standing instruction can confirm in your place.
      </p>

      {error ? (
        <p role="alert" className="text-red-300">
          {error}
        </p>
      ) : null}

      <SubmitButton
        type="button"
        busy={busy}
        busyLabel="Confirming…"
        onClick={onConfirm}
        className="btn min-h-11"
      >
        {rejected ? "Confirm — record the refusal" : "Confirm — apply this preview"}
      </SubmitButton>
    </section>
  );
}
