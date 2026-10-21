/**
 * NPC records — builders, roster derivation, and the activation
 * transition (brief §§2.1, 2.2; module map §1.1).
 *
 * Write discipline (brief §1.2): owners author `pending_activation`
 * records through action flows; only the fabric flips `status` and
 * stamps seq fields, in the resolution that logs the change. The plan
 * builders here assemble `ResolutionPlan`s with the landed helpers
 * (`planWrite`, `summaryDraft`, `fieldChange`) so their plans are
 * byte-shaped like every other resolver plan.
 *
 * Definition fields are freeform (CJ openness): `titleFreeform`,
 * `roleTemplate`, and `scopeFreeform` accept any string — including
 * template labels nobody has ever used (TC-N14) and titles of any
 * reasonable length (TC-N17; size caps live at the rules fence, not
 * here). The one content rule is Vera §8.2's: personality carries no
 * numbers, anywhere — enforced by `validatePersonality`.
 */

import {
  emptyPlan,
  snapshotDoc,
  type ResolutionPlan,
  type SimSnapshot,
} from "../sim/state";
import { fieldChange, planWrite, summaryDraft } from "../sim/rules/planHelpers";
import { memberActor } from "./actors";
import { DEFAULT_PERMISSION_MODE, isPermissionMode } from "./modes";
import {
  NpcCoreError,
  type NpcCreateInput,
  type NpcPersonality,
  type PermissionMode,
  type SimMandateRoot,
  type SimMandateVersion,
  type SimNpc,
  type SimTeam,
} from "./types";

export const NPC_COLLECTION = "sim_npcs";
export const TEAM_COLLECTION = "sim_teams";

export function npcPath(npcId: string): string {
  return `${NPC_COLLECTION}/${npcId}`;
}

export function teamPath(cityId: string): string {
  return `${TEAM_COLLECTION}/${cityId}`;
}

/**
 * Vera §8.2 enforcement: personality is character, not math. Rejects
 * any numeric value anywhere inside the personality object, non-string
 * traits, and non-string notes. (A numeric personality field fails
 * V02 review; this makes the failure mechanical at build time.)
 */
export function validatePersonality(personality: NpcPersonality): void {
  if (typeof personality !== "object" || personality === null) {
    throw new NpcCoreError("INVALID_PERSONALITY", "personality must be an object");
  }
  if (!Array.isArray(personality.traits) || personality.traits.some((t) => typeof t !== "string")) {
    throw new NpcCoreError("INVALID_PERSONALITY", "personality.traits must be an array of strings");
  }
  for (const key of ["voiceNotes", "characterNotes"] as const) {
    const value = personality[key];
    if (value !== null && typeof value !== "string") {
      throw new NpcCoreError("INVALID_PERSONALITY", `personality.${key} must be a string or null`);
    }
  }
  const walk = (value: unknown, path: string): void => {
    if (typeof value === "number") {
      throw new NpcCoreError(
        "NUMERIC_PERSONALITY",
        `personality.${path} is numeric — personality is character, not math (Vera §8.2)`
      );
    }
    if (Array.isArray(value)) value.forEach((item, i) => walk(item, `${path}[${i}]`));
    else if (typeof value === "object" && value !== null) {
      for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k);
    }
  };
  walk(personality, "");
}

function requireFreeformString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new NpcCoreError("INVALID_DEFINITION", `${field} must be a string (freeform — any content passes)`);
  }
  return value;
}

/**
 * Build the `sim_npcs` record an owner's `npc.create` action authors,
 * in `pending_activation` posture. The doc ID is the linked character's
 * ID; where no persona exists yet, the creation mints one ID used in
 * both places in the same resolution (brief §2.1) — pass it as
 * `mintedCharacterId`. The default permission mode is applied HERE and
 * nowhere else (P5-K3): omitted mode → `DEFAULT_PERMISSION_MODE`.
 */
export function buildNpcCreate(input: NpcCreateInput, now: Date): SimNpc {
  const characterId = input.characterId ?? input.mintedCharacterId ?? null;
  if (characterId === null) {
    throw new NpcCoreError(
      "MISSING_CHARACTER_LINK",
      "an NPC record links a characterId — supply an existing character or a mintedCharacterId"
    );
  }
  if (input.characterId !== null && input.mintedCharacterId) {
    throw new NpcCoreError(
      "AMBIGUOUS_CHARACTER_LINK",
      "supply either an existing characterId or a mintedCharacterId, not both"
    );
  }
  validatePersonality(input.personality);
  const permissionMode = input.permissionMode ?? DEFAULT_PERMISSION_MODE;
  if (!isPermissionMode(permissionMode)) {
    throw new NpcCoreError("INVALID_MODE", `unknown permission mode: ${String(permissionMode)}`);
  }
  return {
    npcId: characterId,
    characterId,
    cityId: input.cityId,
    ownerUid: input.ownerUid,
    displayNameSnapshot: requireFreeformString(input.displayNameSnapshot, "displayNameSnapshot"),
    titleFreeform: requireFreeformString(input.titleFreeform, "titleFreeform"),
    roleTemplate: input.roleTemplate ?? null,
    personality: {
      traits: [...input.personality.traits],
      voiceNotes: input.personality.voiceNotes ?? null,
      characterNotes: input.personality.characterNotes ?? null,
    },
    scopeFreeform: requireFreeformString(input.scopeFreeform, "scopeFreeform"),
    permissionMode,
    status: "pending_activation",
    currentMandateId: null,
    currentMandateVersion: null,
    activationSeq: null,
    retiredSeq: null,
    stateVersion: 1,
    createdAt: now,
    updatedAt: now,
  };
}

/** Owner edit payload (`npc.edit`): definition fields only — an NPC's
 * record never edits its own status, mandate pointer, or mode through
 * this path (those are their own actions; Vera §8.7). */
export function buildNpcEdit(
  npc: SimNpc,
  edit: Partial<Pick<SimNpc, "displayNameSnapshot" | "titleFreeform" | "roleTemplate" | "scopeFreeform">> & {
    personality?: NpcPersonality;
  },
  now: Date
): SimNpc {
  if (npc.status === "retired") {
    throw new NpcCoreError("NPC_RETIRED", "a retired NPC record is not editable");
  }
  if (edit.personality) validatePersonality(edit.personality);
  return {
    ...npc,
    ...(edit.displayNameSnapshot !== undefined
      ? { displayNameSnapshot: requireFreeformString(edit.displayNameSnapshot, "displayNameSnapshot") }
      : {}),
    ...(edit.titleFreeform !== undefined
      ? { titleFreeform: requireFreeformString(edit.titleFreeform, "titleFreeform") }
      : {}),
    ...(edit.roleTemplate !== undefined ? { roleTemplate: edit.roleTemplate } : {}),
    ...(edit.scopeFreeform !== undefined
      ? { scopeFreeform: requireFreeformString(edit.scopeFreeform, "scopeFreeform") }
      : {}),
    ...(edit.personality
      ? {
          personality: {
            traits: [...edit.personality.traits],
            voiceNotes: edit.personality.voiceNotes ?? null,
            characterNotes: edit.personality.characterNotes ?? null,
          },
        }
      : {}),
    stateVersion: npc.stateVersion + 1,
    updatedAt: now,
  };
}

/** The fabric's activation transition payload: `pending_activation →
 * active`, stamping the seq of the resolution that logs it. */
export function buildNpcActivation(npc: SimNpc, activationSeq: number, now: Date): SimNpc {
  if (npc.status !== "pending_activation") {
    throw new NpcCoreError(
      "INVALID_TRANSITION",
      `only a pending_activation NPC can activate (got "${npc.status}")`
    );
  }
  return {
    ...npc,
    status: "active",
    activationSeq,
    stateVersion: npc.stateVersion + 1,
    updatedAt: now,
  };
}

/** Retirement payload (`npc.retire` resolution): terminal; the record
 * stays readable, the roster derivation drops it. */
export function buildNpcRetirement(npc: SimNpc, retiredSeq: number, now: Date): SimNpc {
  if (npc.status === "retired") {
    throw new NpcCoreError("INVALID_TRANSITION", "NPC is already retired");
  }
  return {
    ...npc,
    status: "retired",
    retiredSeq,
    stateVersion: npc.stateVersion + 1,
    updatedAt: now,
  };
}

/** `npc.setMode` payload: the owner's direct mode change, effective
 * from its seq (TC-N09 timing). Where a mandate is in force, the
 * assembly ALSO rolls a mandate version (P5-D3: the version's mode is
 * operative; this snapshot follows it) — `buildNpcMandateSnapshot`
 * below is the mandate-driven form of the same update. */
export function buildNpcSetMode(npc: SimNpc, mode: PermissionMode, now: Date): SimNpc {
  if (!isPermissionMode(mode)) {
    throw new NpcCoreError("INVALID_MODE", `unknown permission mode: ${String(mode)}`);
  }
  if (npc.status === "retired") {
    throw new NpcCoreError("NPC_RETIRED", "a retired NPC has no mode to set");
  }
  return { ...npc, permissionMode: mode, stateVersion: npc.stateVersion + 1, updatedAt: now };
}

/** The fabric-maintained snapshot update (P5-D3): when a mandate
 * version becomes effective, the NPC doc's mandate pointer and mode
 * snapshot move to it, in the same resolution. */
export function buildNpcMandateSnapshot(
  npc: SimNpc,
  root: SimMandateRoot,
  version: SimMandateVersion,
  now: Date
): SimNpc {
  if (root.npcId !== npc.npcId || version.npcId !== npc.npcId) {
    throw new NpcCoreError("MANDATE_NPC_MISMATCH", "mandate root/version belong to a different NPC");
  }
  return {
    ...npc,
    currentMandateId: root.mandateId,
    currentMandateVersion: version.version,
    permissionMode: version.permissionMode,
    stateVersion: npc.stateVersion + 1,
    updatedAt: now,
  };
}

/**
 * Team roster derivation (brief §2.2): the roster is DERIVED from the
 * city's NPC records by the committer inside activation/retirement
 * resolutions — owners never edit this doc. One owner per team, by
 * construction (TC-N08): records of another owner serving this city
 * (there are none lawfully) are excluded and reported, never absorbed.
 * The owner's lead pick survives while that NPC remains on the roster.
 */
export function deriveTeamRoster(
  cityId: string,
  ownerUid: string,
  npcs: ReadonlyArray<SimNpc>,
  previous: SimTeam | null,
  changedSeq: number,
  now: Date
): { team: SimTeam; foreignRecords: SimNpc[] } {
  const foreignRecords: SimNpc[] = [];
  const members: SimNpc[] = [];
  for (const npc of npcs) {
    if (npc.cityId !== cityId || npc.status === "retired") continue;
    if (npc.ownerUid !== ownerUid) {
      foreignRecords.push(npc);
      continue;
    }
    members.push(npc);
  }
  members.sort((a, b) => {
    const seqA = a.activationSeq ?? Number.POSITIVE_INFINITY;
    const seqB = b.activationSeq ?? Number.POSITIVE_INFINITY;
    if (seqA !== seqB) return seqA - seqB;
    return a.npcId < b.npcId ? -1 : a.npcId > b.npcId ? 1 : 0;
  });
  const npcIds = members.map((n) => n.npcId);
  const leadNpcId =
    previous && previous.leadNpcId !== null && npcIds.includes(previous.leadNpcId)
      ? previous.leadNpcId
      : null;
  return {
    team: {
      cityId,
      npcIds,
      leadNpcId,
      displayNote: previous?.displayNote ?? null,
      stateVersion: (previous?.stateVersion ?? 0) + 1,
      lastChangedSeq: changedSeq,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    },
    foreignRecords,
  };
}

export type TeamActivityState = "active" | "staffed" | "resting";

/**
 * Derived activity state (brief §2.2; Vera §1.4) — computed at read
 * time, stored nowhere, mutating nothing:
 * - `resting`: no active NPC on the roster.
 * - `staffed`: active NPCs, none holding a current mandate.
 * - `active`: at least one active NPC holds a current mandate.
 */
export function deriveTeamActivity(
  team: SimTeam | null,
  npcsById: ReadonlyMap<string, SimNpc>
): TeamActivityState {
  if (!team) return "resting";
  let anyActive = false;
  for (const npcId of team.npcIds) {
    const npc = npcsById.get(npcId);
    if (!npc || npc.status !== "active") continue;
    anyActive = true;
    if (npc.currentMandateId !== null) return "active";
  }
  return anyActive ? "staffed" : "resting";
}

// ---------------------------------------------------------------------------
// Plan builders — ResolutionPlans assembled with the landed helpers, so
// Phase 5 governance resolutions are byte-shaped like every other
// resolver plan (rule entries first if any, summary last, `planHash`
// left for the committer's finalizePlan).
// ---------------------------------------------------------------------------

/** Plan for the `npc.create` resolution: writes the pending record. */
export function planNpcCreate(
  snapshot: SimSnapshot,
  input: NpcCreateInput,
  now: Date
): ResolutionPlan {
  const npc = buildNpcCreate(input, now);
  const plan = emptyPlan("npc.create");
  planWrite(plan, snapshot, npcPath(npc.npcId), { ...npc }, "state", [
    "status",
    "permissionMode",
    "characterId",
  ]);
  plan.entries.push(
    summaryDraft({
      summaryText: `${npc.displayNameSnapshot} created as an NPC for city ${npc.cityId} (pending activation).`,
      actor: memberActor(input.ownerUid),
      cityId: npc.cityId,
      cityIds: [npc.cityId],
      changes: [
        fieldChange("sim_npcs.status", null, "pending_activation", "npc.create"),
        fieldChange("sim_npcs.permissionMode", null, npc.permissionMode, "npc.create"),
      ],
      recordsCreated: [npcPath(npc.npcId)],
    })
  );
  return plan;
}

/** Plan for the activation resolution: flips the record and re-derives
 * the team roster in the same Resolution Event (brief §1.2). */
export function planNpcActivate(
  snapshot: SimSnapshot,
  npc: SimNpc,
  cityNpcs: ReadonlyArray<SimNpc>,
  activationSeq: number,
  now: Date
): ResolutionPlan {
  const activated = buildNpcActivation(npc, activationSeq, now);
  const rosterNpcs = cityNpcs.map((n) => (n.npcId === npc.npcId ? activated : n));
  const previousTeam = snapshotDoc(snapshot, teamPath(npc.cityId)) as unknown as SimTeam | null;
  const { team } = deriveTeamRoster(npc.cityId, npc.ownerUid, rosterNpcs, previousTeam, activationSeq, now);
  const plan = emptyPlan("npc.create");
  planWrite(plan, snapshot, npcPath(npc.npcId), { ...activated }, "state", [
    "status",
    "activationSeq",
  ]);
  planWrite(plan, snapshot, teamPath(npc.cityId), { ...team }, "state", ["npcIds", "lastChangedSeq"]);
  plan.entries.push(
    summaryDraft({
      summaryText: `${npc.displayNameSnapshot} activated as an NPC for city ${npc.cityId}.`,
      actor: memberActor(npc.ownerUid),
      cityId: npc.cityId,
      cityIds: [npc.cityId],
      changes: [
        fieldChange("sim_npcs.status", "pending_activation", "active", "npc activation"),
      ],
      recordsUpdated: [npcPath(npc.npcId), teamPath(npc.cityId)],
    })
  );
  return plan;
}
