"use client";

import {
  POINT_BUDGET,
  isCommittable,
  remainingPoints,
  sumPoints,
  validateAllocation,
  type AllocationValues,
} from "@/lib/allocation";

interface AllocationSummaryProps {
  values: AllocationValues;
}

/**
 * Live pool summary: spent / remaining, a spend meter, and the current
 * validation state phrased the way R-35 requires the preview to surface it
 * ("N unspent" — never a silent loss). Commit readiness is derived from the
 * same pure validator the commit button gates on, so the two can never
 * disagree.
 */
export function AllocationSummary({ values }: AllocationSummaryProps) {
  const spent = sumPoints(values);
  const remaining = remainingPoints(values);
  const ready = isCommittable(values);
  const issues = validateAllocation(values, { requireExactSum: true });
  // A non-numeric field entry surfaces as NaN in the sum; the per-stat issue
  // list below names it, and the meter simply reads as unspent meanwhile.
  const safeSpent = Number.isFinite(spent) ? spent : 0;
  const meterPercent = Math.min(100, Math.max(0, (safeSpent / POINT_BUDGET) * 100));

  return (
    <div className="glass-panel p-4 space-y-3" aria-live="polite">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-semibold">Season-0 pool</h3>
        <p className="text-sm">
          <span className="font-mono">{spent}</span> of{" "}
          <span className="font-mono">{POINT_BUDGET}</span> spent
        </p>
      </div>

      <div
        className="h-2 w-full overflow-hidden rounded bg-white/10"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={POINT_BUDGET}
        aria-valuenow={Math.min(safeSpent, POINT_BUDGET)}
        aria-label="Points spent"
      >
        <div
          className={
            remaining < 0
              ? "h-full bg-red-500"
              : ready
                ? "h-full bg-emerald-500"
                : "h-full bg-amber-500"
          }
          style={{ width: `${meterPercent}%` }}
        />
      </div>

      {ready ? (
        <p className="text-sm text-emerald-400">
          Exactly {POINT_BUDGET} — this allocation can be committed. Every
          city&apos;s Season-0 index sum is exactly {POINT_BUDGET}; later
          differences are earned growth, traceable in the Log.
        </p>
      ) : remaining > 0 ? (
        <p className="text-sm text-amber-400">
          {remaining} unspent point{remaining === 1 ? "" : "s"} — the pool
          must be spent exactly. Unspent points are not banked.
        </p>
      ) : remaining < 0 ? (
        <p className="text-sm text-red-400">
          {-remaining} point{remaining === -1 ? "" : "s"} over the pool — take
          points back before this can be committed.
        </p>
      ) : null}

      {issues.filter((i) => i.code !== "sum-under" && i.code !== "sum-over").length >
      0 ? (
        <ul className="list-disc space-y-1 pl-5 text-sm text-red-400">
          {issues
            .filter((i) => i.code !== "sum-under" && i.code !== "sum-over")
            .map((issue) => (
              <li key={`${issue.code}-${issue.stat ?? ""}`}>{issue.message}</li>
            ))}
        </ul>
      ) : null}
    </div>
  );
}
