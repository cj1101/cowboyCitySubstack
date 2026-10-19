"use client";

/**
 * The gated compare view (Phase 3 brief §7.3, shipped under Theo's
 * TC-P03 ruling — Reading A, Vera's six clauses;
 * workstreams/tc-p03-ruling-memo.md §6).
 *
 * Renders exactly three things: the owner-published CLAIM, the
 * viewer's own SOURCE figure, and their arithmetic delta
 * (source − claim). Both figures carry their tier labels at figure
 * prominence. There is no third figure, no consensus, and no verdict
 * language anywhere in this component — a difference between two
 * shown figures is arithmetic, not a judgment of either side.
 * The view persists nothing and confers nothing: it renders only
 * what the host's eligibility predicate (lib/dashboard/trust.ts)
 * already established the viewer legitimately holds.
 */

import {
  compareDelta,
  type CompareSource,
  type PublicationClaim,
} from "@/lib/dashboard/trust";

function formatValue(value: number | string | null): string {
  if (value === null) return "—";
  if (typeof value === "number") return value.toLocaleString();
  return value;
}

export function ClaimCompare({
  claim,
  publisherLabel,
  sources,
}: {
  claim: PublicationClaim;
  publisherLabel: string;
  sources: CompareSource[];
}) {
  return (
    <div className="mt-2 border border-black/10 rounded p-3 space-y-3 bg-black/[0.02]">
      <div>
        <p className="text-xs uppercase tracking-wide text-text-muted">
          Owner-published claim — published by {publisherLabel}
        </p>
        <p className="text-lg">
          {claim.metric}: <strong>{formatValue(claim.claimedValue)}</strong>
          {claim.unit ? <span className="text-text-muted"> {claim.unit}</span> : null}
          {claim.periodLabel ? (
            <span className="text-text-muted"> · {claim.periodLabel}</span>
          ) : null}
        </p>
      </div>
      {sources.map((source) => {
        const delta = compareDelta(claim, source);
        return (
          <div key={source.kind} className="border-t border-black/5 pt-2">
            <p className="text-xs uppercase tracking-wide text-text-muted">
              {source.tierLabel} — your source
            </p>
            <p className="text-lg">
              {claim.metric}: <strong>{formatValue(source.value)}</strong>
              {claim.unit ? <span className="text-text-muted"> {claim.unit}</span> : null}
            </p>
            <p className="text-xs text-text-muted">{source.detail}</p>
            {delta !== null ? (
              <p className="text-sm mt-1">
                Difference (your source − the claim):{" "}
                <strong>
                  {delta > 0 ? "+" : ""}
                  {delta.toLocaleString()}
                </strong>
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
