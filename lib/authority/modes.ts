/**
 * Permission-mode arithmetic (brief §2.4). The narrowest mode always
 * wins: NPC snapshot vs. cited version vs. fired delegation rule —
 * disagreement does not error, it escalates downstream exactly the way
 * the narrowest mode behaves (§2.4 table). No path in this module ever
 * widens a mode.
 */

import type { PermissionMode } from "./types";

/** Power ordering: silent (0) < ask-first (1) < act-for-me (2). */
export const MODE_POWER: Readonly<Record<PermissionMode, number>> = {
  silent: 0,
  "ask-first": 1,
  "act-for-me": 2,
};

export function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "act-for-me" || value === "ask-first" || value === "silent";
}

/** The narrowest of the given modes; nulls (no snapshot, no rule) abstain. */
export function narrowestMode(
  ...modes: (PermissionMode | null | undefined)[]
): PermissionMode {
  let result: PermissionMode = "act-for-me";
  for (const mode of modes) {
    if (mode == null) continue;
    if (MODE_POWER[mode] < MODE_POWER[result]) result = mode;
  }
  return result;
}

/** Fresh NPCs (and fresh mandate versions with no mode stated upstream)
 * default to ask-first (P5-K3) — never a wider default anywhere. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "ask-first";
