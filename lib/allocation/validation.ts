/**
 * Pure validation + arithmetic for Season-0 allocations (R-35).
 *
 * No imports from Firebase, React, or the sim layer: every function here is
 * deterministic and unit-testable in isolation (see validation.test.ts).
 * The rules these functions encode are Vera's locks in
 * workstreams/stat-model-amendment.md §3.1/§3.3:
 *
 * - keys must be a subset of the eight allocatable indices (§3.2);
 * - every value is an integer within [ALLOCATION_MIN, ALLOCATION_MAX];
 * - COMMIT additionally requires the values to sum to exactly POINT_BUDGET —
 *   unspent points are not banked, they are a validation error the preview
 *   surfaces before confirmation (the no-surprise rule).
 *
 * Drafts may be saved freely before commit (R-35), so draft validation runs
 * WITHOUT the exact-sum rule; the sum is still reported so the UI can show
 * live remaining/overspent counts while drafting.
 */

import {
  ALLOCATABLE_STATS,
  ALLOCATION_MAX,
  ALLOCATION_MIN,
  NEUTRAL_VALUE,
  POINT_BUDGET,
  type AllocatableStat,
} from "./stats";

/** A complete allocation: one integer value per allocatable index. */
export type AllocationValues = Record<AllocatableStat, number>;

export type AllocationIssueCode =
  | "unknown-key"
  | "non-integer"
  | "below-min"
  | "above-max"
  | "sum-under"
  | "sum-over";

export interface AllocationIssue {
  code: AllocationIssueCode;
  /** The offending stat, for per-stat codes; absent for sum codes. */
  stat?: AllocatableStat | string;
  message: string;
}

export interface ValidationOptions {
  /** Commit-grade validation: also require sum === POINT_BUDGET (R-35). */
  requireExactSum?: boolean;
}

export function isAllocatableStat(key: string): key is AllocatableStat {
  return (ALLOCATABLE_STATS as readonly string[]).includes(key);
}

/** The untouched starting point: every index at 0 (nothing chosen yet). */
export function emptyAllocation(): AllocationValues {
  return {
    spirit: 0,
    culture: 0,
    infrastructure: 0,
    stability: 0,
    law: 0,
    influence: 0,
    military: 0,
    defense: 0,
  };
}

/** The neutral city: 50 in every index — sums to exactly the pool. */
export function neutralAllocation(): AllocationValues {
  return {
    spirit: NEUTRAL_VALUE,
    culture: NEUTRAL_VALUE,
    infrastructure: NEUTRAL_VALUE,
    stability: NEUTRAL_VALUE,
    law: NEUTRAL_VALUE,
    influence: NEUTRAL_VALUE,
    military: NEUTRAL_VALUE,
    defense: NEUTRAL_VALUE,
  };
}

export function sumPoints(values: AllocationValues): number {
  let total = 0;
  for (const stat of ALLOCATABLE_STATS) total += values[stat];
  return total;
}

/** Points left to spend (negative when overspent). */
export function remainingPoints(values: AllocationValues): number {
  return POINT_BUDGET - sumPoints(values);
}

/**
 * Coerce a raw stored/input map (e.g. a Firestore draft's `allocations`,
 * which starts as `{}`) into a complete AllocationValues. Missing keys read
 * as 0 ("not chosen yet"); non-number values are passed through as NaN so
 * validation can flag them instead of silently inventing a number.
 * Unknown keys are NOT copied — validateAllocationMap reports them.
 */
export function normalizeAllocation(
  input: Partial<Record<string, unknown>> | null | undefined
): AllocationValues {
  const out = emptyAllocation();
  if (!input) return out;
  for (const stat of ALLOCATABLE_STATS) {
    const raw = input[stat];
    if (raw === undefined) continue;
    out[stat] = typeof raw === "number" ? raw : Number.NaN;
  }
  return out;
}

/** Per-value checks only (integer + bounds), for one stat. */
export function validateValue(
  stat: AllocatableStat,
  value: number
): AllocationIssue[] {
  if (!Number.isInteger(value)) {
    return [
      {
        code: "non-integer",
        stat,
        message: `${stat} must be a whole number (got ${String(value)}).`,
      },
    ];
  }
  if (value < ALLOCATION_MIN) {
    return [
      {
        code: "below-min",
        stat,
        message: `${stat} cannot go below ${ALLOCATION_MIN} (got ${value}).`,
      },
    ];
  }
  if (value > ALLOCATION_MAX) {
    return [
      {
        code: "above-max",
        stat,
        message:
          `${stat} cannot start above ${ALLOCATION_MAX} (got ${value}). ` +
          `The top fifth of every index (81-100) is earned in play, never allocated.`,
      },
    ];
  }
  return [];
}

/**
 * Validate a complete allocation. With requireExactSum (the commit rule,
 * R-35), also emits exactly one sum issue when the total is off, phrased the
 * way the preview must surface it: the owner sees "N unspent" and fixes it,
 * rather than discovering a silent loss.
 */
export function validateAllocation(
  values: AllocationValues,
  options: ValidationOptions = {}
): AllocationIssue[] {
  const issues: AllocationIssue[] = [];
  for (const stat of ALLOCATABLE_STATS) {
    issues.push(...validateValue(stat, values[stat]));
  }
  if (options.requireExactSum) {
    const remaining = remainingPoints(values);
    if (remaining > 0) {
      issues.push({
        code: "sum-under",
        message:
          `${remaining} unspent point${remaining === 1 ? "" : "s"} — ` +
          `the allocation must spend exactly ${POINT_BUDGET}. Unspent points are not banked.`,
      });
    } else if (remaining < 0) {
      issues.push({
        code: "sum-over",
        message:
          `${-remaining} point${remaining === -1 ? "" : "s"} over the pool — ` +
          `the allocation must spend exactly ${POINT_BUDGET}.`,
      });
    }
  }
  return issues;
}

/**
 * Validate a raw map as stored in a draft/commit (subset keys, unknown keys
 * rejected). Draft validation: no exact-sum requirement. Commit validation:
 * pass requireExactSum — the same rule the Phase 4 fabric validator must
 * re-check server-side; the UI check is a preview, never the authority.
 */
export function validateAllocationMap(
  input: Partial<Record<string, unknown>> | null | undefined,
  options: ValidationOptions = {}
): AllocationIssue[] {
  const issues: AllocationIssue[] = [];
  if (input) {
    for (const key of Object.keys(input)) {
      if (!isAllocatableStat(key)) {
        issues.push({
          code: "unknown-key",
          stat: key,
          message:
            `"${key}" is not an allocatable index. Only the eight indices ` +
            `(${ALLOCATABLE_STATS.join(", ")}) can be allocated; stocks are never allocatable.`,
        });
      }
    }
  }
  issues.push(...validateAllocation(normalizeAllocation(input), options));
  return issues;
}

/** True only when the allocation may be committed (R-35 commit validation). */
export function isCommittable(values: AllocationValues): boolean {
  return validateAllocation(values, { requireExactSum: true }).length === 0;
}

/** Clamp a UI-entered value into the allocation bounds, integer-rounded. */
export function clampAllocationValue(value: number): number {
  if (!Number.isFinite(value)) return ALLOCATION_MIN;
  return Math.min(ALLOCATION_MAX, Math.max(ALLOCATION_MIN, Math.round(value)));
}

/** Parse a number-input's raw text; empty text reads as 0 (field cleared). */
export function parseAllocationInput(text: string): number {
  const trimmed = text.trim();
  if (trimmed === "") return 0;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? Math.round(parsed) : Number.NaN;
}
