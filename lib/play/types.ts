/**
 * Client view types for the play loop (Phase 4 brief §2, module a).
 *
 * These are *views* over the landed fabric records — the `sim_actions`
 * doc and the preview record the dispatcher stores on it (Phase 2
 * `lib/sim/preview.ts`, stored as `{ ...preview, previewHash }`). The
 * UI never invents fields the fabric did not write: anything absent
 * from the stored record is absent here, and renders as absence, not
 * as a fabricated default.
 */

import type { ActionStatus } from "@/lib/sim/state";

/** An acting-city option, in the exact shape the Phase 3 dashboard
 * ActionBox shell established (`ActionBoxData.cities`) so the live
 * intake drops into that surface without an adapter. */
export interface PlayCityOption {
  factionId: string;
  name: string;
  /** The shared city (Cowboy City): acting there routes through the
   * sitting Mayor, with Town Hall able to intervene — the Phase 3
   * shell's copy posture carries over unchanged. */
  isShared: boolean;
}

/** One exact state change from the stored preview's `deltas` list:
 * the field on one city's sim record moves `before` → `after` if the
 * preview is confirmed and still fresh at the wake. */
export interface PlayDelta {
  cityId: string;
  field: string;
  before: unknown;
  after: unknown;
}

/** A pending the commit would create, disclosed *as a class* (brief
 * §2.2): kind, target, generation, the delay derivation numbers, and
 * the human condition summary. Never an outcome promise — the stored
 * record carries no seed and no odds, and neither does this view. */
export interface PlayPendingDisclosure {
  pendingId: string;
  kind: string;
  targetCityId: string | null;
  generation: number | null;
  delayDerivation: Record<string, unknown> | null;
  conditionSummary: string;
}

/** The member-facing preview, parsed from the stored preview record. */
export interface PlayPreview {
  /** The resolver's outcome for this preview ("resolved" plans apply
   * on confirm; "rejected" plans are shown so the member sees the
   * refusal *before* confirming anything). */
  outcome: string;
  summaryText: string;
  deltas: PlayDelta[];
  /** Cities the resolution touches beyond the action's own targets. */
  spillover: string[];
  pendingDisclosures: PlayPendingDisclosure[];
  recordsAffected: string[];
  /** Warnings ride in the stored preview — the rejection notice and
   * legal-exposure warnings (e.g. R-18 / R-27) surface here, in the
   * preview, never as a post-hoc surprise (brief §2.2). */
  warnings: string[];
  /** The citable World Baseline version, or null pre-ratification
   * (the registry fails closed; the card says so rather than hiding
   * it). */
  baselineVersion: string | null;
  rulesVersion: string | null;
  /** The volatile display instant the preview was computed at. Never
   * hashed, never bound — shown only so a member can tell a fresh
   * preview from a stale one at a glance. */
  computedAt: string | null;
  /** The hash the confirmation binds to (brief §2.3). The stored
   * preview record carries it; the confirmation write must repeat it
   * exactly or the rules fence refuses the write. */
  previewHash: string;
}

/** The member-facing view of one `sim_actions` doc across its whole
 * lifecycle: received → awaiting_confirmation → confirmed → resolved /
 * rejected / failed. */
export interface PlayActionView {
  actionId: string;
  status: ActionStatus;
  actionType: string;
  actionText: string | null;
  targetCityIds: string[];
  preview: PlayPreview | null;
  /** Terminal failure detail on `rejected` / `failed`, as the fabric
   * recorded it. */
  failure: { code: string; message: string } | null;
  resolutionId: string | null;
  /** Where the resolution landed in the Log, once committed. The Log
   * is the record; these seqs are the member's pointer into it. */
  firstLogSeq: number | null;
  lastLogSeq: number | null;
}

// ---------------------------------------------------------------------------
// Structured-form catalog types (see kinds.ts)
// ---------------------------------------------------------------------------

export type PlayFieldKind = "text" | "textarea" | "number" | "select" | "city";

export interface PlayFieldSpec {
  /** Key in the submitted `structuredAction` record. */
  key: string;
  label: string;
  kind: PlayFieldKind;
  required?: boolean;
  help?: string;
  placeholder?: string;
  /** For `select` fields. Values are what the handler receives. */
  options?: { value: string; label: string }[];
  /** For `number` fields — the form enforces the same bounds the
   * handler will, so a member meets the limit here, not in a
   * rejection. */
  min?: number;
  max?: number;
  step?: number;
}

/** One structured action kind the intake offers. An entry here is a
 * *form*, not a handler: a kind is offered only when a handler is
 * registered for it in the fabric registry (brief §2.1 — "an action
 * kind with no registered handler is not offered in the UI"). The
 * Build Lead reconciles this catalog against the registry's
 * `actionKinds[]` at assembly; entries land as catalogue steps
 * register their handlers. */
export interface PlayActionKind {
  /** The registry action-kind id this form submits as `actionType`. */
  kind: string;
  label: string;
  /** What this action *is*, in plain words. Descriptive only — the
   * intake never recommends, suggests, or prompts an action (CJ's
   * causality rule: everything is player-initiated). */
  blurb: string;
  fields: PlayFieldSpec[];
  /** How the submitted action's `targetCityIds` are derived:
   * "acting-city" (the composer's selected city), "form" (a `city`
   * field in the form names it), or "none". */
  target: "acting-city" | "form" | "none";
  /** What cannot be undone once this action resolves, in the kind's
   * own terms, for the confirmation card (brief §2.3: the card names
   * what will happen, what it costs, and what cannot be undone). */
  irreversibleNote?: string;
}
