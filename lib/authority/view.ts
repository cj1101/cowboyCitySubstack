/**
 * View assembly: SimSnapshot → AuthorityView (brief §1.2's read-plan
 * discipline — the caller decides what enters the snapshot; this module
 * only projects docs it was handed). Doc→record coercion is defensive
 * field-by-field reading: a malformed record degrades to nulls and
 * fails closed downstream, never to a guessed grant.
 *
 * Paths are the brief's: `sim_npcs/{npcId}`, `sim_mandates/{mandateId}`,
 * `sim_mandates/{mandateId}/versions/{version}`, `factions/{cityId}`.
 * The terms record's path is a caller parameter (`termsPath`): Dana
 * §3.2 fixes the collection (`sim_terms`) and the election engine fixes
 * the record's fields (`mayorUid`, `viceMayorUid`, `status`), but no
 * landed source fixes the doc id, so this module invents none.
 */

import { snapshotDoc, type SimSnapshot } from "../sim/state";
import { isPermissionMode } from "./modes";
import type {
  AuthorityView,
  CityAuthorityContext,
  MandateRootRecord,
  MandateScope,
  MandateVersionRecord,
  NpcRecord,
  PeriodUsage,
  PermissionMode,
} from "./types";

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

function asScope(doc: Record<string, unknown> | null): MandateScope {
  const scope = (doc?.scope ?? {}) as Record<string, unknown>;
  return {
    allowedActionTypes: strArr(scope.allowedActionTypes),
    namedRecordIds: strArr(scope.namedRecordIds),
    counterpartyCityIds: strArr(scope.counterpartyCityIds),
    perActionRubars: num(scope.perActionRubars),
    perPeriodRubars: num(scope.perPeriodRubars),
    perPeriodActions: num(scope.perPeriodActions),
    periodDefinition: str(scope.periodDefinition) ?? "",
    maxProjectPhase: num(scope.maxProjectPhase),
    triggerKinds: strArr(scope.triggerKinds) as MandateScope["triggerKinds"],
    negotiationBounds:
      scope.negotiationBounds !== null && typeof scope.negotiationBounds === "object"
        ? (scope.negotiationBounds as MandateScope["negotiationBounds"])
        : null,
    alwaysEscalate: strArr(scope.alwaysEscalate),
    allowPartialExecution: scope.allowPartialExecution === true,
  };
}

export function npcFromDoc(doc: Record<string, unknown> | null): NpcRecord | null {
  if (doc === null) return null;
  const npcId = str(doc.npcId) ?? str(doc.id);
  const cityId = str(doc.cityId);
  const ownerUid = str(doc.ownerUid);
  if (npcId === null || cityId === null || ownerUid === null) return null;
  return {
    npcId,
    characterId: str(doc.characterId) ?? "",
    cityId,
    ownerUid,
    permissionMode: isPermissionMode(doc.permissionMode)
      ? doc.permissionMode
      : "ask-first", // fail narrow, never wide (P5-K3's default)
    status: doc.status === "retired" ? "retired" : "active",
    currentMandateId: str(doc.currentMandateId),
    currentMandateVersion: num(doc.currentMandateVersion),
    activationSeq: num(doc.activationSeq) ?? 0,
    retiredSeq: num(doc.retiredSeq),
  };
}

export function mandateRootFromDoc(doc: Record<string, unknown> | null): MandateRootRecord | null {
  if (doc === null) return null;
  const mandateId = str(doc.mandateId) ?? str(doc.id);
  const npcId = str(doc.npcId);
  const cityId = str(doc.cityId);
  const ownerUid = str(doc.ownerUid);
  const currentVersion = num(doc.currentVersion);
  if (mandateId === null || npcId === null || cityId === null || ownerUid === null || currentVersion === null) {
    return null;
  }
  return { mandateId, npcId, cityId, ownerUid, currentVersion };
}

export function mandateVersionFromDoc(
  doc: Record<string, unknown> | null
): MandateVersionRecord | null {
  if (doc === null) return null;
  const mandateId = str(doc.mandateId);
  const version = num(doc.version);
  if (mandateId === null || version === null) return null;
  const status = doc.status;
  return {
    mandateId,
    version,
    status:
      status === "active" || status === "superseded" || status === "revoked" || status === "expired"
        ? status
        : "pending",
    mode: isPermissionMode(doc.mode) ? doc.mode : "ask-first",
    scope: asScope(doc),
    expiresAtSeq: num(doc.expiresAtSeq),
    horizonActions: num(doc.horizonActions),
    effectiveSeq: num(doc.effectiveSeq),
    revokedSeq: num(doc.revokedSeq),
    mandateHash: str(doc.mandateHash) ?? "",
    createdByUid: str(doc.createdByUid) ?? "",
  };
}

export function cityContextFromDocs(
  cityId: string,
  factionDoc: Record<string, unknown> | null,
  sharedCityId: string | null,
  termsDoc: Record<string, unknown> | null
): CityAuthorityContext {
  const isSharedCity = sharedCityId !== null && cityId === sharedCityId;
  let mayorUid: string | null = null;
  let viceMayorUid: string | null = null;
  if (isSharedCity && termsDoc !== null && termsDoc.status === "current") {
    mayorUid = str(termsDoc.mayorUid);
    viceMayorUid = str(termsDoc.viceMayorUid);
  }
  return {
    cityId,
    ownerUids: strArr(factionDoc?.ownerUids),
    isSharedCity,
    mayorUid,
    viceMayorUid,
  };
}

export interface AuthorityViewRefs {
  npcId: string;
  /** The attempt's principal city (goes into the view's city map). */
  cityId: string;
  /** Target cities to include in the view (fairness fence inputs). */
  extraCityIds?: string[];
  sharedCityId: string | null;
  /** Snapshot path of the current terms doc; required to evaluate the
   * shared city (without it the shared city fails closed). */
  termsPath?: string | null;
  periodUsage: PeriodUsage;
  ruleMode?: PermissionMode | null;
  /** Seq the resolution would consume; defaults to lastSeq + 1. */
  atSeq?: number;
  /** The version the actor cites, when the caller is evaluating a
   * specific citation: the builder then reads the CITED version doc
   * (check 3 compares it against the root's currency). Defaults to the
   * root's current version. */
  citedVersion?: number;
}

export function authorityViewFromSnapshot(
  snapshot: SimSnapshot,
  refs: AuthorityViewRefs
): AuthorityView {
  const npc = npcFromDoc(snapshotDoc(snapshot, `sim_npcs/${refs.npcId}`));
  let mandateRoot: MandateRootRecord | null = null;
  let mandateVersion: MandateVersionRecord | null = null;
  if (npc !== null && npc.currentMandateId !== null) {
    mandateRoot = mandateRootFromDoc(
      snapshotDoc(snapshot, `sim_mandates/${npc.currentMandateId}`)
    );
    if (mandateRoot !== null) {
      mandateVersion = mandateVersionFromDoc(
        snapshotDoc(
          snapshot,
          `sim_mandates/${mandateRoot.mandateId}/versions/${refs.citedVersion ?? mandateRoot.currentVersion}`
        )
      );
    }
  }
  const termsDoc =
    refs.termsPath != null ? snapshotDoc(snapshot, refs.termsPath) : null;
  const cities = new Map<string, CityAuthorityContext>();
  for (const cityId of [refs.cityId, ...(refs.extraCityIds ?? [])]) {
    cities.set(
      cityId,
      cityContextFromDocs(
        cityId,
        snapshotDoc(snapshot, `factions/${cityId}`),
        refs.sharedCityId,
        termsDoc
      )
    );
  }
  return {
    npc,
    mandateRoot,
    mandateVersion,
    cities,
    periodUsage: refs.periodUsage,
    ruleMode: refs.ruleMode ?? null,
    atSeq: refs.atSeq ?? snapshot.counterHead.lastSeq + 1,
  };
}
