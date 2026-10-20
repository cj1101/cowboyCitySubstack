"use client";

import {
  ALLOCATION_MAX,
  ALLOCATION_MIN,
  clampAllocationValue,
  parseAllocationInput,
  type StatMeta,
} from "@/lib/allocation";

interface StatAllocatorRowProps {
  meta: StatMeta;
  value: number;
  disabled?: boolean;
  /** Per-stat validation message (integer/bounds), if any. */
  issue?: string;
  onChange: (value: number) => void;
}

/**
 * One index's allocation control: slider + numeric input, kept in sync,
 * with the stat's plain-language explanation and any published mechanics
 * note. Values are clamped to the allocation bounds on the way in; the
 * exact-sum rule lives in the summary/commit layer, not here — a row only
 * ever refuses what R-35 refuses per-value (non-integer, out of bounds).
 */
export function StatAllocatorRow({
  meta,
  value,
  disabled = false,
  issue,
  onChange,
}: StatAllocatorRowProps) {
  const sliderId = `alloc-${meta.key}-slider`;
  const inputId = `alloc-${meta.key}-input`;
  const noteId = `alloc-${meta.key}-note`;

  return (
    <div className="glass-panel p-4 space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={sliderId} className="form-label mb-0">
          {meta.label}
        </label>
        <div className="flex items-center gap-2">
          <input
            id={inputId}
            type="number"
            className="form-input w-20 text-right"
            min={ALLOCATION_MIN}
            max={ALLOCATION_MAX}
            step={1}
            value={Number.isNaN(value) ? "" : value}
            disabled={disabled}
            aria-label={`${meta.label} value`}
            aria-describedby={noteId}
            aria-invalid={issue ? true : undefined}
            onChange={(e) => {
              const parsed = parseAllocationInput(e.target.value);
              onChange(Number.isNaN(parsed) ? Number.NaN : clampAllocationValue(parsed));
            }}
          />
          <span className="text-xs opacity-70">/ {ALLOCATION_MAX} at founding</span>
        </div>
      </div>

      <input
        id={sliderId}
        type="range"
        className="w-full accent-amber-500"
        min={ALLOCATION_MIN}
        max={ALLOCATION_MAX}
        step={1}
        value={Number.isNaN(value) ? 0 : value}
        disabled={disabled}
        aria-label={`${meta.label} slider`}
        aria-describedby={noteId}
        onChange={(e) => onChange(Number(e.target.value))}
      />

      <p id={noteId} className="text-sm opacity-80">
        {meta.explanation}
      </p>
      {meta.mechanicsNote ? (
        <p className="text-xs opacity-60">{meta.mechanicsNote}</p>
      ) : null}
      {issue ? (
        <p role="alert" className="text-sm text-red-400">
          {issue}
        </p>
      ) : null}
    </div>
  );
}
