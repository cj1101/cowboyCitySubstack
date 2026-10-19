/**
 * The intake's action-kind catalog (Phase 4 brief §2.1).
 *
 * Two ways to act, both producing a `sim_actions` doc through the
 * landed `buildActionDoc` (lib/play/intake.ts):
 *
 * 1. **Free text** — the member describes the action in their own
 *    words. It submits under the `FREE_TEXT_KIND` marker with the
 *    prose in `actionText`. The fabric's translate step may classify
 *    the prose into a registered kind before preview; prose that
 *    classifies to nothing reaches the resolver as-is and resolves
 *    narrative-only under the landed unruled path (Phase 2 §5.5:
 *    logged, flagged unruled, no state change). The intake itself
 *    never guesses a kind for the member's words — no keyword
 *    heuristics, no invented parse (the Phase 3 shell's prohibition
 *    carries into the live surface).
 *
 * 2. **Structured forms** — one declarative form per registered kind,
 *    described by `PlayActionKind` entries below. The form is data:
 *    adding a kind when its catalogue step lands is adding an entry,
 *    not new component code.
 */

import type { PlayActionKind } from "./types";

/** The `actionType` free prose submits under. Not a registry kind and
 * never offered as a structured form. */
export const FREE_TEXT_KIND = "free_text";

/**
 * Structured kinds the intake offers.
 *
 * EMPTY at step 2, deliberately: the only handlers in the landed
 * registry today are Phase 2 fixtures (`fixture_fund`,
 * `fixture_adjust`, `fixture_schedule`), and fixture kinds are test
 * machinery, never a product offering. Product entries land here as
 * the Phase 4 catalogue steps register their handlers (steps 3–11),
 * and the Build Lead reconciles this list against the registry's
 * `actionKinds[]` at assembly — per brief §2.1, a kind with no
 * registered handler is not offered, whatever this file says.
 */
export const PLAY_ACTION_KINDS: PlayActionKind[] = [];

/** The kinds a surface may actually offer: the catalog filtered to
 * the kinds the caller confirms are registered. The mount point (the
 * Build Lead's assembly) passes the registry's live kind set; until
 * then the parameter is the honesty mechanism, not a formality. */
export function offeredKinds(
  registeredKinds: Iterable<string>,
  catalog: PlayActionKind[] = PLAY_ACTION_KINDS
): PlayActionKind[] {
  const registered = new Set(registeredKinds);
  return catalog.filter((entry) => registered.has(entry.kind));
}

export function kindById(
  kind: string,
  catalog: PlayActionKind[] = PLAY_ACTION_KINDS
): PlayActionKind | null {
  return catalog.find((entry) => entry.kind === kind) ?? null;
}

/**
 * Catalog integrity, checked by the module harness and cheap enough
 * to run anywhere: duplicate kinds, duplicate field keys within a
 * kind, selects without options, and inverted number bounds are
 * authoring errors that should fail loudly at build time rather than
 * render a broken form in front of a member.
 */
export function validateKindCatalog(
  catalog: PlayActionKind[] = PLAY_ACTION_KINDS
): string[] {
  const problems: string[] = [];
  const seenKinds = new Set<string>();
  for (const entry of catalog) {
    if (seenKinds.has(entry.kind)) {
      problems.push(`duplicate kind "${entry.kind}"`);
    }
    seenKinds.add(entry.kind);
    if (entry.kind === FREE_TEXT_KIND) {
      problems.push(`"${FREE_TEXT_KIND}" is the free-text marker, not a form`);
    }
    const seenFields = new Set<string>();
    for (const field of entry.fields) {
      if (seenFields.has(field.key)) {
        problems.push(`kind "${entry.kind}": duplicate field "${field.key}"`);
      }
      seenFields.add(field.key);
      if (field.kind === "select" && (!field.options || field.options.length === 0)) {
        problems.push(`kind "${entry.kind}": select field "${field.key}" has no options`);
      }
      if (
        field.kind === "number" &&
        field.min !== undefined &&
        field.max !== undefined &&
        field.min > field.max
      ) {
        problems.push(`kind "${entry.kind}": number field "${field.key}" has min > max`);
      }
    }
  }
  return problems;
}
