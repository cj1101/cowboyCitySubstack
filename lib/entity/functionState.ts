/**
 * Function availability — DERIVED, never stored (Phase 3 brief §8.3;
 * spec §6.2.5, ruling R-15).
 *
 * A building's function state is computed from its recorded status and
 * condition every time it is rendered. No collection carries a
 * "functionAvailable" flag written by this module, and no UI surface
 * may persist one.
 *
 * Damage threshold: the numeric threshold past which damage takes a
 * building out of function is Vera's Phase 4 lock (brief §8.3: "Phase 3
 * derives from status/condition fields as recorded and invents no
 * threshold" — spec §10 item 6 fallback). This module therefore takes
 * the threshold as an input: callers pass a published threshold when
 * one exists, or `null` (the Phase 3 posture), in which case a complete
 * building derives "in function" and its condition renders as the
 * recorded fact it is. The single exception is condition 0 — a building
 * recorded at zero condition has no function left to derive; that is
 * the record speaking, not a threshold.
 */

import type { CorporationStatus, SimCorporation, SimStructure, StructureStatus } from "./types";

export type FunctionState =
  | "in-function"
  | "out-of-function-damaged"
  | "not-yet-in-function"
  | "paused-mothballed"
  | "gone";

export interface DerivedFunction {
  state: FunctionState;
  /** Short badge label, e.g. "In function". */
  label: string;
  /** One-line plain-language statement of why, from the record alone. */
  detail: string;
  /** Whether the entity's recorded effects currently apply. When false
   * for a damaged building, the page shows the effects as suspended
   * (struck through, pre-damage values visible — spec §6.2.5). */
  effectsActive: boolean;
}

export function deriveStructureFunction(
  structure: Pick<SimStructure, "status" | "condition">,
  damageThreshold: number | null
): DerivedFunction {
  switch (structure.status) {
    case "planned":
      return {
        state: "not-yet-in-function",
        label: "Not yet in function — planned",
        detail: "Planned — not yet built. Its function is an intention until it is built.",
        effectsActive: false,
      };
    case "under-construction":
      return {
        state: "not-yet-in-function",
        label: "Not yet in function — under construction",
        detail: "Under construction. Its function begins when the building is complete.",
        effectsActive: false,
      };
    case "mothballed":
      return {
        state: "paused-mothballed",
        label: "Out of function — mothballed",
        detail:
          "Mothballed by its owner. Return to function requires an owner action — nothing un-mothballs itself.",
        effectsActive: false,
      };
    case "demolished":
      return {
        state: "gone",
        label: "Gone — demolished",
        detail: "Demolished. The function is gone; this page remains as the record of what stood here.",
        effectsActive: false,
      };
    case "ruined":
      return {
        state: "gone",
        label: "Gone — ruined",
        detail: "Ruined. The function is gone; this page remains as the record of what stood here.",
        effectsActive: false,
      };
    case "complete": {
      const condition = structure.condition;
      if (condition !== null && condition <= 0) {
        return {
          state: "out-of-function-damaged",
          label: "Out of function — damaged",
          detail: "Recorded condition is 0 — nothing of the building's function remains until it is repaired or rebuilt.",
          effectsActive: false,
        };
      }
      if (condition !== null && damageThreshold !== null && condition < damageThreshold) {
        return {
          state: "out-of-function-damaged",
          label: "Out of function — damaged",
          detail: `Recorded condition ${condition} is below the published working threshold of ${damageThreshold}. Its function is stopped until repaired.`,
          effectsActive: false,
        };
      }
      return {
        state: "in-function",
        label: "In function",
        detail:
          condition !== null
            ? `Complete and in function, at recorded condition ${condition}.`
            : "Complete and in function.",
        effectsActive: true,
      };
    }
  }
}

export function deriveCorporationFunction(
  corporation: Pick<SimCorporation, "status">
): DerivedFunction {
  switch (corporation.status) {
    case "active":
      return { state: "in-function", label: "Operating", detail: "Active and operating.", effectsActive: true };
    case "contracted":
      return {
        state: "in-function",
        label: "Operating — contracted",
        detail: "Operating under contract.",
        effectsActive: true,
      };
    case "relocated":
      return {
        state: "paused-mothballed",
        label: "Relocated",
        detail: "Relocated — no longer operating from this city.",
        effectsActive: false,
      };
    case "dissolved":
      return {
        state: "gone",
        label: "Dissolved",
        detail: "Dissolved. This page remains as the record of the business.",
        effectsActive: false,
      };
  }
}

export const STRUCTURE_STATUS_LABELS: Record<StructureStatus, string> = {
  planned: "Planned — not yet built",
  "under-construction": "Under construction",
  complete: "Complete",
  mothballed: "Mothballed",
  demolished: "Demolished",
  ruined: "Ruined",
};

export const CORPORATION_STATUS_LABELS: Record<CorporationStatus, string> = {
  active: "Active",
  contracted: "Contracted",
  relocated: "Relocated",
  dissolved: "Dissolved",
};

/**
 * The Phase 3 threshold posture: no published threshold exists yet, so
 * pages pass `null` (see module header). When Vera's Phase 4 lock
 * publishes one, it is supplied here — the derivation does not change.
 */
export const PUBLISHED_DAMAGE_THRESHOLD: number | null = null;
