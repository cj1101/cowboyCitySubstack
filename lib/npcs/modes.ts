/**
 * Permission modes — where they live and what they mean (brief §2.4).
 *
 * The adopted default for a newly created NPC is `ask-first` (P5-K3,
 * brief §2.1 proposal): permission is granted, never assumed (TC-N15).
 * `DEFAULT_PERMISSION_MODE` is defined here and ONLY here — the
 * `npc.create` builder consumes it — so a future ruling flipping the
 * default is a one-line change plus a gate-fixture update.
 *
 * Mode precedence (brief §2.4): when sources disagree (NPC snapshot vs
 * mandate version vs delegation rule) the NARROWEST wins. Disagreement
 * is not an error; it resolves narrow.
 */

import type { PermissionMode } from "./types";

export const PERMISSION_MODES: readonly PermissionMode[] = [
  "act-for-me",
  "ask-first",
  "silent",
];

/** P5-K3: the less powerful of the two acting modes; a fresh NPC may
 * draft and propose, and commits nothing. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "ask-first";

/** Power ranking: higher = broader authority. `silent` < `ask-first` <
 * `act-for-me` in power (brief §2.4). */
export const MODE_POWER: Readonly<Record<PermissionMode, number>> = {
  silent: 0,
  "ask-first": 1,
  "act-for-me": 2,
};

export function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "act-for-me" || value === "ask-first" || value === "silent";
}

/** The narrower (less powerful) of two modes. */
export function narrowerMode(a: PermissionMode, b: PermissionMode): PermissionMode {
  return MODE_POWER[a] <= MODE_POWER[b] ? a : b;
}

/**
 * Narrowest-wins across any set of mode sources (brief §2.4, P5-D3).
 * Absent sources (null/undefined) do not vote. No source at all means
 * no grant exists anywhere, which is `silent` — "the leader didn't say
 * anything" is the floor of the ladder, not an error.
 */
export function narrowestMode(
  sources: ReadonlyArray<PermissionMode | null | undefined>
): PermissionMode {
  let result: PermissionMode | null = null;
  for (const source of sources) {
    if (source === null || source === undefined) continue;
    result = result === null ? source : narrowerMode(result, source);
  }
  return result ?? "silent";
}

export type StandingTriggerPosture = "resolve" | "draft" | "no-response";
export type SituationRoutingPosture = "handle" | "draft-and-await" | "refuse";

/**
 * The brief §2.4 mode table, as data — the one definition the authority
 * stage, the spawn contract, and the settings surfaces all read, so the
 * three columns can never drift apart in separate code.
 */
export interface ModeSemantics {
  mode: PermissionMode;
  /** Standing team, on a mandate trigger match (brief §1.3 step 5). */
  standingTrigger: StandingTriggerPosture;
  /** What an envelope (spawned task) yields under this mode. Envelopes
   * are tasks, not standing authority; output is advisory under every
   * mode (never-bind is mode-independent, P5-K4). */
  envelopeOutput: "advisory";
  /** A situation routed to an NPC in this mode (brief §2.4). */
  situationRouting: SituationRoutingPosture;
  /** A `silent` NPC can still be envelope-tasked: the owner's direct,
   * logged instruction IS the permission for that task (P5-K4). */
  envelopeTaskable: boolean;
}

export const MODE_SEMANTICS: Readonly<Record<PermissionMode, ModeSemantics>> = {
  "act-for-me": {
    mode: "act-for-me",
    standingTrigger: "resolve",
    envelopeOutput: "advisory",
    situationRouting: "handle",
    envelopeTaskable: true,
  },
  "ask-first": {
    mode: "ask-first",
    standingTrigger: "draft",
    envelopeOutput: "advisory",
    situationRouting: "draft-and-await",
    envelopeTaskable: true,
  },
  silent: {
    mode: "silent",
    standingTrigger: "no-response",
    envelopeOutput: "advisory",
    situationRouting: "refuse",
    envelopeTaskable: true,
  },
};

export function modeSemantics(mode: PermissionMode): ModeSemantics {
  return MODE_SEMANTICS[mode];
}
