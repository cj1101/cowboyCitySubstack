/**
 * Client reads + governance submissions for the NPC settings
 * surfaces (Phase 5 brief §11.3). Reads run as the requester under
 * the §9 fences: NPC records, teams, and mandates are group-readable
 * presentation (§9.1–§9.3); what the settings surface EDITS is
 * fenced to the owner by the governance handlers themselves.
 *
 * Every write goes through the play intake as a governance action
 * (`npc.create` / `npc.edit` / `npc.retire` / `npc.setMode` /
 * `mandate.set` / `mandate.revoke`) — previewed by the fabric and
 * bound by the owner's hash-bound confirmation, like any action.
 * A mode change is therefore a mandate event (it authors a new
 * version where a mandate stands, P5-D3), never a settings flip.
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  where,
  type DocumentData,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";
import { newClientRequestId, submitPlayAction } from "@/lib/play/intake";
import type {
  PermissionMode,
  SimMandateRoot,
  SimMandateVersion,
  SimNpc,
  SimTeam,
} from "@/lib/npcs/types";
import type { Character } from "@/lib/types";

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

function asRecord(value: unknown): DocumentData {
  return value && typeof value === "object" ? (value as DocumentData) : {};
}

function asDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { toDate?: unknown }).toDate === "function"
  ) {
    return (value as { toDate: () => Date }).toDate();
  }
  return new Date(0);
}

function asMode(value: unknown): PermissionMode {
  return value === "act-for-me" || value === "silent" ? value : "ask-first";
}

export function toNpc(data: DocumentData): SimNpc {
  const personality = asRecord(data.personality);
  const status =
    data.status === "active" || data.status === "retired"
      ? data.status
      : "pending_activation";
  return {
    npcId: asString(data.npcId),
    characterId: asString(data.characterId),
    cityId: asString(data.cityId),
    ownerUid: asString(data.ownerUid),
    displayNameSnapshot: asString(data.displayNameSnapshot),
    titleFreeform: asString(data.titleFreeform),
    roleTemplate: asNullableString(data.roleTemplate),
    personality: {
      traits: asStringList(personality.traits),
      voiceNotes: asNullableString(personality.voiceNotes),
      characterNotes: asNullableString(personality.characterNotes),
    },
    scopeFreeform: asString(data.scopeFreeform),
    permissionMode: asMode(data.permissionMode),
    status,
    currentMandateId: asNullableString(data.currentMandateId),
    currentMandateVersion: asNullableNumber(data.currentMandateVersion),
    activationSeq: asNullableNumber(data.activationSeq),
    retiredSeq: asNullableNumber(data.retiredSeq),
    stateVersion: asNumber(data.stateVersion),
    createdAt: asDate(data.createdAt),
    updatedAt: asDate(data.updatedAt),
  };
}

export function toMandateRoot(data: DocumentData): SimMandateRoot {
  const status =
    data.status === "active" ||
    data.status === "revoked" ||
    data.status === "expired" ||
    data.status === "superseded"
      ? data.status
      : "pending";
  return {
    mandateId: asString(data.mandateId),
    npcId: asString(data.npcId),
    cityId: asString(data.cityId),
    ownerUid: asString(data.ownerUid),
    currentVersion: asNumber(data.currentVersion),
    status,
    currentVersionRef: asString(data.currentVersionRef),
    createdSeq: asNullableNumber(data.createdSeq),
    revokedSeq: asNullableNumber(data.revokedSeq),
    expiresAtSeq: asNullableNumber(data.expiresAtSeq),
    createdAt: asDate(data.createdAt),
    updatedAt: asDate(data.updatedAt),
  };
}

export function toMandateVersion(data: DocumentData): SimMandateVersion {
  const scope = asRecord(data.structuredScope);
  const caps = asRecord(data.caps);
  const period = asRecord(caps.periodDefinition);
  const bounds = data.negotiationBounds as DocumentData | null;
  return {
    version: asNumber(data.version),
    npcId: asString(data.npcId),
    cityId: asString(data.cityId),
    ownerUid: asString(data.ownerUid),
    permissionMode: asMode(data.permissionMode),
    scopeFreeform: asString(data.scopeFreeform),
    structuredScope: {
      triggerKinds: asStringList(scope.triggerKinds),
      allowedActionTypes: asStringList(scope.allowedActionTypes),
      namedRecordIds: asStringList(scope.namedRecordIds),
      counterpartyCityIds: Array.isArray(scope.counterpartyCityIds)
        ? asStringList(scope.counterpartyCityIds)
        : null,
    },
    caps: {
      perActionRubars: asNullableNumber(caps.perActionRubars),
      perResolutionPeriodRubars: asNullableNumber(caps.perResolutionPeriodRubars),
      periodDefinition:
        period && (period.kind === "actions" || period.kind === "seqWindow")
          ? { kind: period.kind, count: asNumber(period.count) }
          : null,
      maxProjectPhase: asNullableNumber(caps.maxProjectPhase),
      allowPartialExecution: caps.allowPartialExecution === true,
    },
    negotiationBounds:
      bounds && typeof bounds === "object"
        ? {
            mayOffer:
              typeof bounds.mayOffer === "string" || typeof bounds.mayOffer === "boolean"
                ? bounds.mayOffer
                : null,
            mayAccept:
              typeof bounds.mayAccept === "string" || typeof bounds.mayAccept === "boolean"
                ? bounds.mayAccept
                : null,
            walkAwayIf: asNullableString(bounds.walkAwayIf),
            maxTurns: asNullableNumber(bounds.maxTurns),
          }
        : null,
    alwaysEscalate: asStringList(data.alwaysEscalate),
    responseStyle: asNullableString(data.responseStyle),
    expiresAtSeq: asNullableNumber(data.expiresAtSeq),
    horizonActions: asNullableNumber(data.horizonActions),
    sourceActionId: asString(data.sourceActionId),
    effectiveSeq: asNullableNumber(data.effectiveSeq),
    supersededSeq: asNullableNumber(data.supersededSeq),
    mandateHash: asString(data.mandateHash),
    createdAt: asDate(data.createdAt),
  };
}

export function toTeam(data: DocumentData): SimTeam {
  return {
    cityId: asString(data.cityId),
    npcIds: asStringList(data.npcIds),
    leadNpcId: asNullableString(data.leadNpcId),
    displayNote: asNullableString(data.displayNote),
    stateVersion: asNumber(data.stateVersion),
    lastChangedSeq: asNullableNumber(data.lastChangedSeq),
    createdAt: asDate(data.createdAt),
    updatedAt: asDate(data.updatedAt),
  };
}

/** The viewer's own NPC records (§9.1: owner-scoped query shape). */
export async function loadMyNpcs(uid: string): Promise<SimNpc[]> {
  const db = getClientDb();
  const snap = await getDocs(
    query(collection(db, "sim_npcs"), where("ownerUid", "==", uid), limit(100))
  );
  return snap.docs.map((d) => toNpc(d.data())).filter((n) => n.npcId !== "");
}

/** NPCs serving one city (the situations delegate picker reads the
 * same §9.1 fence; names/titles are group-readable presentation). */
export async function loadCityNpcs(cityId: string): Promise<SimNpc[]> {
  const db = getClientDb();
  const snap = await getDocs(
    query(collection(db, "sim_npcs"), where("cityId", "==", cityId), limit(100))
  );
  return snap.docs.map((d) => toNpc(d.data())).filter((n) => n.npcId !== "");
}

export async function loadTeam(cityId: string): Promise<SimTeam | null> {
  try {
    const snap = await getDoc(doc(getClientDb(), "sim_teams", cityId));
    return snap.exists() ? toTeam(snap.data()) : null;
  } catch {
    return null;
  }
}

export async function loadMandateRoot(
  mandateId: string
): Promise<SimMandateRoot | null> {
  try {
    const snap = await getDoc(doc(getClientDb(), "sim_mandates", mandateId));
    return snap.exists() ? toMandateRoot(snap.data()) : null;
  } catch {
    return null;
  }
}

export async function loadMandateVersion(
  mandateId: string,
  version: number
): Promise<SimMandateVersion | null> {
  try {
    const snap = await getDoc(
      doc(getClientDb(), "sim_mandates", mandateId, "versions", String(version))
    );
    return snap.exists() ? toMandateVersion(snap.data()) : null;
  } catch {
    return null;
  }
}

/** Every authored version of one mandate, oldest first — the
 * settings history list (read-only; versions are immutable). */
export async function loadMandateVersions(
  mandateId: string
): Promise<SimMandateVersion[]> {
  const snap = await getDocs(
    collection(getClientDb(), "sim_mandates", mandateId, "versions")
  );
  return snap.docs
    .map((d) => toMandateVersion(d.data()))
    .sort((a, b) => a.version - b.version);
}

/** Mandate roots for one NPC (an NPC holds at most one current
 * mandate; the query keeps the register export honest). */
export async function loadMandatesForNpc(npcId: string): Promise<SimMandateRoot[]> {
  const snap = await getDocs(
    query(
      collection(getClientDb(), "sim_mandates"),
      where("npcId", "==", npcId),
      limit(20)
    )
  );
  return snap.docs.map((d) => toMandateRoot(d.data()));
}

/** The city's personas an NPC record can link to (`characters`). */
export async function loadCharactersForCity(cityId: string): Promise<Character[]> {
  const snap = await getDocs(
    query(
      collection(getClientDb(), "characters"),
      where("factionId", "==", cityId),
      limit(100)
    )
  );
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      factionId: asString(data.factionId),
      name: asString(data.name),
      title: typeof data.title === "string" ? data.title : undefined,
      avatarUrl: typeof data.avatarUrl === "string" ? data.avatarUrl : undefined,
      isActive: data.isActive !== false,
    };
  });
}

/** The shared city's id from the world record (viewer-readable,
 * §9 posture) — the composer context's `isSharedCity` input. */
export async function loadSharedCityId(): Promise<string | null> {
  try {
    const snap = await getDoc(doc(getClientDb(), "sim_world", "current"));
    if (!snap.exists()) return null;
    const value = snap.data().sharedCityId;
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// Governance submissions — one action each, through the play intake.
// ---------------------------------------------------------------------

async function submitGovernance(
  uid: string,
  actionType: string,
  structuredAction: Record<string, unknown>,
  targetCityIds: string[]
): Promise<{ actionId: string }> {
  const { actionId } = await submitPlayAction({
    uid,
    clientRequestId: newClientRequestId(),
    actionType,
    actionText: null,
    structuredAction,
    targetCityIds,
  });
  return { actionId };
}

export function submitNpcCreate(
  uid: string,
  payload: Record<string, unknown>,
  cityId: string
): Promise<{ actionId: string }> {
  return submitGovernance(uid, "npc.create", payload, [cityId]);
}

export function submitNpcEdit(
  uid: string,
  payload: Record<string, unknown>,
  cityId: string
): Promise<{ actionId: string }> {
  return submitGovernance(uid, "npc.edit", payload, [cityId]);
}

export function submitNpcRetire(
  uid: string,
  npcId: string,
  cityId: string
): Promise<{ actionId: string }> {
  return submitGovernance(uid, "npc.retire", { npcId }, [cityId]);
}

export function submitNpcSetMode(
  uid: string,
  npcId: string,
  permissionMode: PermissionMode,
  cityId: string
): Promise<{ actionId: string }> {
  return submitGovernance(uid, "npc.setMode", { npcId, permissionMode }, [cityId]);
}

export function submitMandateSet(
  uid: string,
  payload: Record<string, unknown>,
  cityId: string
): Promise<{ actionId: string }> {
  return submitGovernance(uid, "mandate.set", payload, [cityId]);
}

export function submitMandateRevoke(
  uid: string,
  mandateId: string,
  cityId: string
): Promise<{ actionId: string }> {
  return submitGovernance(uid, "mandate.revoke", { mandateId }, [cityId]);
}
