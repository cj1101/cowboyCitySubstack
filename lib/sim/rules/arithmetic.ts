/**
 * Deterministic rulings arithmetic (Phase 2 brief §5.2; Felix's delay
 * derivation, consequence-chains design §2.3).
 *
 * Every helper here is a pure function of stored state. The resolver
 * never invents a number: delays are DERIVED from the action's own
 * parameters and the target city's stored stats by the formulas below,
 * and the derivation's inputs are stored on the pending
 * (`delayDerivation`) and disclosed in the preview.
 *
 * One deliberate exclusion: Felix's sketch floated a seeded random
 * component inside delay derivation. CJ §7.7 forecloses seeded-odds
 * mechanisms; derivation here is formula-only (brief §7.2).
 */

export class RuleArithmeticError extends Error {
  code = "RULE_ARITHMETIC";
}

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RuleArithmeticError(`${label} is not a finite number`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Felix §2.3 delay derivation.
//   minWallElapsedHours = round(baseHours × fundScale × infra × connectivity)
//   minSeqAdvance       = round(hours / 6)
// ---------------------------------------------------------------------------

/** clamp(1.5 − fundSize / (2 × referenceFund), 0.5, 1.5): a fund at the
 * reference size runs at factor 1.0; larger funds run FASTER (more
 * parallel workstreams), smaller slower. Non-fund pendings pass
 * fundSize = null and get factor 1. */
export function fundScaleFactor(fundSize: number | null, referenceFund: number): number {
  if (fundSize === null) return 1;
  return clampNumber(1.5 - fundSize / (2 * referenceFund), 0.5, 1.5);
}

/** Unbuilt infrastructure (null — the Phase 1 null discipline: no index
 * value exists) counts as the <40 band: an unbuilt city is a slow city. */
export function infraFactor(infrastructure: number | null): number {
  if (infrastructure === null || infrastructure < 40) return 1.25;
  if (infrastructure < 70) return 1.0;
  return 0.85;
}

/** A live connection is recorded on the city doc as a trait string
 * `connection:<cityId>:live` (WB-7.2 connectivity as data). */
export function hasLiveConnection(traits: unknown): boolean {
  return (
    Array.isArray(traits) &&
    traits.some(
      (t) => typeof t === "string" && t.startsWith("connection:") && t.endsWith(":live")
    )
  );
}

export function connectivityFactor(connected: boolean): number {
  return connected ? 0.9 : 1.0;
}

export interface DelayDerivation {
  baseHours: number;
  fundSize: number | null;
  referenceFund: number | null;
  fundScaleFactor: number;
  infrastructure: number | null;
  infraFactor: number;
  connectivityFactor: number;
  minWallElapsedHours: number;
  minSeqAdvance: number;
}

export function deriveDelay(input: {
  baseHours: number;
  fundSize: number | null;
  referenceFund: number | null;
  infrastructure: number | null;
  connected: boolean;
}): DelayDerivation {
  const fundScale = fundScaleFactor(
    input.fundSize,
    input.referenceFund ?? Number.MAX_SAFE_INTEGER
  );
  const infra = infraFactor(input.infrastructure);
  const connectivity = connectivityFactor(input.connected);
  const hours = Math.round(input.baseHours * fundScale * infra * connectivity);
  return {
    baseHours: input.baseHours,
    fundSize: input.fundSize,
    referenceFund: input.referenceFund,
    fundScaleFactor: fundScale,
    infrastructure: input.infrastructure,
    infraFactor: infra,
    connectivityFactor: connectivity,
    minWallElapsedHours: hours,
    minSeqAdvance: Math.round(hours / 6),
  };
}
