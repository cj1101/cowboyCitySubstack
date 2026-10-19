"use client";

/**
 * The member-facing preview (Phase 4 brief §2.2) — the landed
 * resolver's dry run, rendered exactly as stored on the action doc.
 *
 * The no-surprise rule is the contract: rules matched, the exact
 * deltas that will be applied, spillover to other cities, warnings
 * (including legal exposure) in the preview rather than after the
 * fact, and any pending the commit would create disclosed *as a
 * class* — delay arithmetic and preconditions, never a promised
 * outcome. This card renders the stored record and nothing else: it
 * computes no delta, predicts no outcome, and invents no number the
 * preview did not state.
 *
 * Layout follows the Phase 3 ActionBox shell's preview slots, filled:
 * parsed action · kind · predicted effects · other cities touched ·
 * confirmation path (the ConfirmationCard renders below this one).
 */

import {
  fieldLabel,
  formatFieldValue,
  formatSimValue,
  groupDeltasByCity,
  shortHash,
} from "@/lib/play/format";
import type { PlayPreview } from "@/lib/play/types";

export interface PreviewCardProps {
  preview: PlayPreview;
  actionType: string;
  actionText: string | null;
  /** Resolve a city id to its display name where the mount point
   * knows it; ids render as-is otherwise. */
  cityName?: (cityId: string) => string;
}

export function PreviewCard({ preview, actionType, actionText, cityName }: PreviewCardProps) {
  const nameOf = (cityId: string) => cityName?.(cityId) ?? cityId;
  const rejected = preview.outcome === "rejected";
  const deltaGroups = groupDeltasByCity(preview.deltas);

  return (
    <section
      aria-label="Action preview"
      className="rounded border border-darker-brown bg-glass-bg p-4 flex flex-col gap-3 text-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-bold">Preview</h4>
        <span
          className={`rounded border px-2 py-0.5 text-xs ${
            rejected ? "border-red-900 text-red-300" : "border-darker-brown text-text-muted"
          }`}
        >
          {rejected ? "Will be rejected if confirmed" : "Ready to confirm"}
        </span>
      </div>

      {/* Parsed action — the resolver's own summary of what it took
          the action to be, with the member's words kept visible. */}
      <div className="flex flex-col gap-1">
        <span className="text-text-muted">Parsed action</span>
        <p>{preview.summaryText || "The fabric recorded no summary for this preview."}</p>
        {actionText ? (
          <p className="text-text-muted">
            Your words: <span className="italic">“{actionText}”</span>
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-text-muted">Kind</span>
        <p>
          {actionType}
          {preview.rulesVersion ? (
            <span className="text-text-muted"> · rules {preview.rulesVersion}</span>
          ) : null}
          <span className="text-text-muted">
            {" "}
            · World Baseline: {preview.baselineVersion ?? "not yet ratified"}
          </span>
        </p>
      </div>

      {/* Predicted effects — the exact deltas, grouped by the city
          they land on. This is the whole list: confirmation applies
          exactly these, or (if the world moved) none of them. */}
      <div className="flex flex-col gap-2">
        <span className="text-text-muted">Predicted effects</span>
        {preview.deltas.length === 0 ? (
          <p>
            No state changes.{" "}
            {rejected
              ? "The resolution refuses this action — the reason is in the warnings below."
              : "This action is recorded in the Log as narrative; nothing in the world moves."}
          </p>
        ) : (
          deltaGroups.map((group) => (
            <div key={group.cityId} className="flex flex-col gap-1">
              <span className="font-bold">{nameOf(group.cityId)}</span>
              <ul className="flex flex-col gap-1">
                {group.deltas.map((delta, index) => (
                  <li
                    key={`${delta.field}-${index}`}
                    className="flex flex-wrap justify-between gap-x-3"
                  >
                    <span>{fieldLabel(delta.field)}</span>
                    <span>
                      {formatFieldValue(delta.field, delta.before)}
                      {" → "}
                      {formatFieldValue(delta.field, delta.after)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-text-muted">Other cities touched</span>
        <p>
          {preview.spillover.length === 0
            ? "None — this stays inside the cities you targeted."
            : preview.spillover.map(nameOf).join(", ")}
        </p>
      </div>

      {/* Pendings as a class: what sort of thing would be set in
          motion, on what delay arithmetic and preconditions. The
          discipline line is part of the surface, not fine print. */}
      {preview.pendingDisclosures.length > 0 ? (
        <div className="flex flex-col gap-2">
          <span className="text-text-muted">What this sets in motion</span>
          {preview.pendingDisclosures.map((pending) => (
            <div key={pending.pendingId} className="flex flex-col gap-1">
              <p>
                <span className="font-bold">{pending.kind}</span>
                {pending.targetCityId ? (
                  <span className="text-text-muted"> · {nameOf(pending.targetCityId)}</span>
                ) : null}
                {pending.generation !== null ? (
                  <span className="text-text-muted"> · generation {pending.generation}</span>
                ) : null}
              </p>
              {pending.conditionSummary ? <p>{pending.conditionSummary}</p> : null}
              {pending.delayDerivation ? (
                <ul className="text-xs text-text-muted flex flex-col gap-0.5">
                  {Object.entries(pending.delayDerivation).map(([key, value]) => (
                    <li key={key} className="flex justify-between gap-3">
                      <span>{key}</span>
                      <span>{formatSimValue(value)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}
          <p className="text-xs text-text-muted">
            This describes the class of what may follow — its delay arithmetic and
            preconditions — never a promised outcome. Whether it ripens, and into
            what, is decided when the world gets there, from your action.
          </p>
        </div>
      ) : null}

      {preview.warnings.length > 0 ? (
        <div className="flex flex-col gap-1" role="note" aria-label="Preview warnings">
          <span className="text-text-muted">Warnings</span>
          <ul className="flex flex-col gap-1">
            {preview.warnings.map((warning, index) => (
              <li key={index} className="flex gap-2">
                <span aria-hidden="true">⚠</span>
                <span>{warning}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {preview.recordsAffected.length > 0 ? (
        <details>
          <summary className="text-text-muted cursor-pointer">
            Records this touches ({preview.recordsAffected.length})
          </summary>
          <ul className="text-xs text-text-muted mt-1 flex flex-col gap-0.5">
            {preview.recordsAffected.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        </details>
      ) : null}

      <p className="text-xs text-text-muted">
        Preview {shortHash(preview.previewHash)} — a preview changes nothing by itself.
        It is a promise about the world as it stood when it was computed; confirming
        applies exactly this, and if the world has moved, nothing is applied and you
        get a fresh preview instead.
      </p>
    </section>
  );
}
