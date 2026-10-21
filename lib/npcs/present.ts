/**
 * Presentation copy for NPCs and mandates (Phase 5 brief §11.3;
 * June's npc-builder-ui-design §§4–6) — pure functions over the
 * landed `lib/npcs` shapes. Mode MEANING is never re-derived here:
 * `lib/npcs/modes.ts` (`MODE_SEMANTICS`, `modeSemantics`) is the one
 * definition the authority stage, the spawn contract, and these
 * surfaces all read; this file only turns it into the owner's words.
 *
 * The default shown for a new NPC is read from the builder default
 * (`DEFAULT_PERMISSION_MODE` in `lib/npcs/modes.ts`, P5-K3) — never
 * a hardcoded string in a component.
 */

import type { PermissionMode } from "@/lib/npcs/types";
import type { SimMandateVersion } from "@/lib/npcs/types";
import { DEFAULT_PERMISSION_MODE, modeSemantics } from "@/lib/npcs/modes";
import type { TeamActivityState } from "@/lib/npcs/npcs";

export { DEFAULT_PERMISSION_MODE };

/** The three modes in the owner's terms (design §4.1): labels are
 * verbs in the owner's voice; the machine name rides small beneath
 * so audit text, exports, and Log filters line up with what the
 * owner clicked. Each paragraph IS the contract — no tooltip-only
 * consequences. */
export interface ModeOption {
  mode: PermissionMode;
  label: string;
  paragraph: string;
}

export const MODE_OPTIONS: readonly ModeOption[] = [
  {
    mode: "act-for-me",
    label: "Act for me",
    paragraph:
      "Resolve routine matters inside the mandate and caps, in my name, through the " +
      "same rules as if I had acted. Every act is logged as theirs, on my behalf. " +
      "Binding steps are never included — those still come back to me as a " +
      "confirmation card.",
  },
  {
    mode: "ask-first",
    label: "Ask first",
    paragraph:
      "Draft the response and stop. Nothing changes until I confirm it. The draft " +
      "waits in my Situations as awaiting me.",
  },
  {
    mode: "silent",
    label: "Say nothing",
    paragraph:
      "Give no response at all. Where a response was asked for, the Log records the " +
      "non-response as an outcome: \u201cthe leader didn't say anything.\u201d No reminders " +
      "are sent — to anyone. (I can still task this NPC directly with an envelope; " +
      "my direct instruction is the permission for that one task.)",
  },
];

export function modeOption(mode: PermissionMode): ModeOption {
  return MODE_OPTIONS.find((o) => o.mode === mode) ?? MODE_OPTIONS[1];
}

/** Short label for chips and pickers: "ask-first" in the owner's
 * words. The mode travels WITH the name everywhere an NPC is named
 * as a potential actor (design §4.3). */
export function modeShortLabel(mode: PermissionMode): string {
  return modeOption(mode).label;
}

/** One-line consequence class for pickers, from the landed
 * semantics table — what routing a situation to this NPC yields. */
export function modeRoutingLine(mode: PermissionMode): string {
  const sem = modeSemantics(mode);
  switch (sem.situationRouting) {
    case "handle":
      return "handles matters routed to them, inside their mandate";
    case "draft-and-await":
      return "drafts a response and waits for your decision";
    case "refuse":
      return "gives no response — routing a matter to them is refused, with the reason stated";
  }
}

/** The attribution badge (countersign A-6): NPC output and acts are
 * badged "〈name〉, for 〈owner〉" at the same prominence as the change
 * itself — never a footnote. */
export function npcBadge(npcName: string, ownerName: string): string {
  return `${npcName}, for ${ownerName}`;
}

/**
 * Dana's three-part authority summary (design §5.2, from Petra spec
 * §3.4B): "〈NPC〉 may: … / may not: … / caps: …" — generated from the
 * current mandate version, in plain words, rendered above any
 * delegation or confirmation control that cites the mandate. If an
 * owner reads nothing else, they read this.
 */
export function authoritySummary(
  npcName: string,
  version: SimMandateVersion | null
): string {
  if (!version) {
    return (
      `${npcName} may: be tasked by you directly, one envelope at a time (the ` +
      `output is advice until you confirm anything binding). ${npcName} may not: ` +
      `act on standing authority — there is no mandate in force. Caps: none apply ` +
      `until a mandate sets them.`
    );
  }
  const may: string[] = [];
  if (version.structuredScope.allowedActionTypes.length > 0) {
    may.push(
      `resolve ${version.structuredScope.allowedActionTypes.join(", ")}`
    );
  }
  if (version.structuredScope.triggerKinds.length > 0) {
    may.push(
      `respond to ${version.structuredScope.triggerKinds.join(", ")}`
    );
  }
  if (version.structuredScope.namedRecordIds.length > 0) {
    may.push(
      `act on the named records: ${version.structuredScope.namedRecordIds.join(", ")}`
    );
  }
  if (may.length === 0) {
    may.push("be tasked by you directly (output is advice until you confirm)");
  }
  const mayNot: string[] = [
    "sign, accept, or adopt anything binding",
    "spend above the caps",
    "touch another city's records",
    "write canon",
  ];
  if (version.alwaysEscalate.length > 0) {
    mayNot.push(`decide ${version.alwaysEscalate.join(", ")} — those come back to you`);
  }
  const caps: string[] = [];
  caps.push(
    version.caps.perActionRubars !== null
      ? `${version.caps.perActionRubars} Rubars per action`
      : "no per-action Rubar cap set"
  );
  if (
    version.caps.perResolutionPeriodRubars !== null &&
    version.caps.periodDefinition
  ) {
    caps.push(
      `${version.caps.perResolutionPeriodRubars} Rubars per ${version.caps.periodDefinition.count} ${version.caps.periodDefinition.kind === "actions" ? "actions" : "Log entries"}`
    );
  }
  if (version.horizonActions !== null) {
    caps.push(`renewal after ${version.horizonActions} delegated resolutions`);
  }
  return (
    `${npcName} may: ${may.join("; ")}. ${npcName} may not: ${mayNot.join("; ")}. ` +
    `Caps: ${caps.join("; ")}.`
  );
}

/** The team activity state line (design §6.2), rendered from the
 * landed read-time derivation (`deriveTeamActivity` in
 * `lib/npcs/npcs.ts`) — a display, never a setting: there is no
 * "set city online" switch anywhere in these surfaces. */
export function teamActivityLine(
  state: TeamActivityState,
  cityName: string
): string {
  switch (state) {
    case "active":
      return `${cityName} responds when things pop up — at least one NPC on this team holds a current mandate, so the city answers even while you are away.`;
    case "staffed":
      return `${cityName}'s team is staffed but holds no current mandate — its NPCs can be tasked by you directly, and matters otherwise wait for you.`;
    case "resting":
      return `${cityName} has no active NPC right now — matters wait for you, and waiting is a complete outcome.`;
  }
}

/** Retire consequences (design §2.6), stated before the act. */
export const RETIRE_CONSEQUENCES =
  "Retiring stops trigger matching before the next fabric cycle. Envelopes already " +
  "claimed finish or fail on their own terms. The record and its full history " +
  "remain — retirement is a state, never a deletion. There is no delete control " +
  "for an NPC, anywhere.";

/** TC-N09 immediacy language for revocation / mode changes. */
export const NEXT_CYCLE_LINE = "Takes effect before the next fabric cycle.";
