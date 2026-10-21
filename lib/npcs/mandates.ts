/**
 * Mandates — version builders, the canonical `mandateHash`, current-
 * version resolution, and expiry/horizon evaluation (brief §§2.3, 2.7).
 *
 * Hashing joins Phase 1's canonical-JSON regime (`lib/sim/canonical.ts`,
 * `cowboy-canonical-json-v1`): `mandateHash` is the SHA-256 over the
 * canonical form of the immutable authority payload, exactly the fields
 * in `MANDATE_HASH_FIELDS` — status/effective fields (`effectiveSeq`,
 * `supersededSeq`) and the hash itself are excluded, as is `createdAt`
 * (committer-stamped metadata, not authority; the authoring act is
 * bound into the hash through `sourceActionId`). Golden vectors below
 * pin the digest so any drift in the payload definition or the
 * canonical layer fails loudly.
 *
 * Expiry and horizon are PURE PREDICATES over seq/counts — never a
 * clock (brief §2.3 AMENDMENT: `expired` is derived-at-read; the fabric
 * writes the status flip lazily inside a resolution, never on a timer).
 */

import { sha256Hex } from "../sim/canonical";
import { isPermissionMode } from "./modes";
import {
  NpcCoreError,
  type MandateCaps,
  type MandateVersionInput,
  type NegotiationBounds,
  type SimMandateRoot,
  type SimMandateVersion,
  type StructuredScope,
} from "./types";

/** The immutable authority payload fields, in one exported place: a
 * ratification change to what the hash covers is one edit here plus a
 * golden-vector regeneration. */
export const MANDATE_HASH_FIELDS = [
  "version",
  "npcId",
  "cityId",
  "ownerUid",
  "permissionMode",
  "scopeFreeform",
  "structuredScope",
  "caps",
  "negotiationBounds",
  "alwaysEscalate",
  "responseStyle",
  "expiresAtSeq",
  "horizonActions",
  "sourceActionId",
] as const;

/** Negotiation/envoy work detection for the Vera §8.4 bounds rule.
 * Action types are free strings referencing registry IDs (brief §2.3);
 * the module's mechanical approximation is an ID naming negotiation or
 * envoy work. Bounds may also be supplied voluntarily for any mandate. */
export function isNegotiationActionType(actionType: string): boolean {
  const id = actionType.toLowerCase();
  return id.includes("negotiat") || id.includes("envoy");
}

export function requiresNegotiationBounds(scope: StructuredScope): boolean {
  return scope.allowedActionTypes.some(isNegotiationActionType);
}

function isIntegerOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value));
}

function normalizeCaps(caps: MandateCaps): MandateCaps {
  const out: MandateCaps = {
    perActionRubars: caps.perActionRubars ?? null,
    perResolutionPeriodRubars: caps.perResolutionPeriodRubars ?? null,
    periodDefinition: caps.periodDefinition ?? null,
    maxProjectPhase: caps.maxProjectPhase ?? null,
    allowPartialExecution: caps.allowPartialExecution ?? false,
  };
  for (const [key, value] of Object.entries(caps)) {
    if (key in out) continue;
    if (!isIntegerOrNull(value)) {
      throw new NpcCoreError(
        "INVALID_CAP",
        `mandate cap "${key}" must be an integer or null`
      );
    }
    out[key] = value;
  }
  for (const key of ["perActionRubars", "perResolutionPeriodRubars", "maxProjectPhase"] as const) {
    if (!isIntegerOrNull(out[key])) {
      throw new NpcCoreError("INVALID_CAP", `mandate cap "${key}" must be an integer or null`);
    }
  }
  const period = out.periodDefinition;
  if (period !== null) {
    if (
      typeof period !== "object" ||
      (period.kind !== "actions" && period.kind !== "seqWindow") ||
      !Number.isInteger(period.count) ||
      period.count < 1
    ) {
      throw new NpcCoreError(
        "INVALID_PERIOD",
        "periodDefinition must be { kind: \"actions\" | \"seqWindow\", count: positive integer }"
      );
    }
    out.periodDefinition = { kind: period.kind, count: period.count };
  }
  if (typeof out.allowPartialExecution !== "boolean") {
    throw new NpcCoreError("INVALID_CAP", "allowPartialExecution must be a boolean");
  }
  return out;
}

function normalizeBounds(bounds: NegotiationBounds): NegotiationBounds {
  if (
    bounds.maxTurns !== null &&
    bounds.maxTurns !== undefined &&
    (!Number.isInteger(bounds.maxTurns) || bounds.maxTurns < 1)
  ) {
    throw new NpcCoreError("INVALID_BOUNDS", "negotiationBounds.maxTurns must be a positive integer or null");
  }
  return {
    mayOffer: bounds.mayOffer ?? null,
    mayAccept: bounds.mayAccept ?? null,
    walkAwayIf: bounds.walkAwayIf ?? null,
    maxTurns: bounds.maxTurns ?? null,
  };
}

function normalizeScope(scope: StructuredScope): StructuredScope {
  const arrays: Array<[string, unknown]> = [
    ["triggerKinds", scope.triggerKinds],
    ["allowedActionTypes", scope.allowedActionTypes],
    ["namedRecordIds", scope.namedRecordIds],
  ];
  for (const [name, value] of arrays) {
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      throw new NpcCoreError("INVALID_SCOPE", `structuredScope.${name} must be an array of strings`);
    }
  }
  if (
    scope.counterpartyCityIds !== null &&
    scope.counterpartyCityIds !== undefined &&
    (!Array.isArray(scope.counterpartyCityIds) ||
      scope.counterpartyCityIds.some((v) => typeof v !== "string"))
  ) {
    throw new NpcCoreError(
      "INVALID_SCOPE",
      "structuredScope.counterpartyCityIds must be an array of strings or null"
    );
  }
  return {
    triggerKinds: [...scope.triggerKinds],
    allowedActionTypes: [...scope.allowedActionTypes],
    namedRecordIds: [...scope.namedRecordIds],
    counterpartyCityIds:
      scope.counterpartyCityIds === null || scope.counterpartyCityIds === undefined
        ? null
        : [...scope.counterpartyCityIds],
  };
}

/**
 * The canonical authority payload of a mandate version: exactly
 * `MANDATE_HASH_FIELDS`, absent optionals normalized to null so the
 * payload's key set is stable regardless of how the version was built.
 * Accepts a built version doc or raw build input.
 */
export function mandateAuthorityPayload(
  version: MandateVersionInput | SimMandateVersion
): Record<string, unknown> {
  const scope = normalizeScope(version.structuredScope);
  const caps = normalizeCaps(version.caps);
  const payload: Record<string, unknown> = {
    version: version.version,
    npcId: version.npcId,
    cityId: version.cityId,
    ownerUid: version.ownerUid,
    permissionMode: version.permissionMode,
    scopeFreeform: version.scopeFreeform,
    structuredScope: scope,
    caps,
    negotiationBounds:
      version.negotiationBounds === null || version.negotiationBounds === undefined
        ? null
        : normalizeBounds(version.negotiationBounds),
    alwaysEscalate: [...(version.alwaysEscalate ?? [])],
    responseStyle: version.responseStyle ?? null,
    expiresAtSeq: version.expiresAtSeq ?? null,
    horizonActions: version.horizonActions ?? null,
    sourceActionId: version.sourceActionId,
  };
  return payload;
}

/** Canonical hash of the immutable authority payload (brief §2.7). */
export function mandateHash(version: MandateVersionInput | SimMandateVersion): string {
  return sha256Hex(mandateAuthorityPayload(version));
}

/**
 * Build an immutable mandate version doc in `pending` posture
 * (`effectiveSeq: null` — the fabric stamps effectiveness in the same
 * resolution that logs it; brief §2.3 write split). Throws
 * `NpcCoreError` on any contract violation, before any write exists.
 */
export function buildMandateVersion(input: MandateVersionInput, now: Date): SimMandateVersion {
  if (!Number.isInteger(input.version) || input.version < 1) {
    throw new NpcCoreError("INVALID_VERSION", "mandate version must be a positive integer");
  }
  if (!isPermissionMode(input.permissionMode)) {
    throw new NpcCoreError("INVALID_MODE", `unknown permission mode: ${String(input.permissionMode)}`);
  }
  if (typeof input.scopeFreeform !== "string") {
    throw new NpcCoreError("INVALID_SCOPE", "scopeFreeform must be a string (freeform prose)");
  }
  const scope = normalizeScope(input.structuredScope);
  const caps = normalizeCaps(input.caps);
  let bounds: NegotiationBounds | null = null;
  if (input.negotiationBounds !== null && input.negotiationBounds !== undefined) {
    bounds = normalizeBounds(input.negotiationBounds);
  }
  if (bounds === null && requiresNegotiationBounds(scope)) {
    throw new NpcCoreError(
      "NEGOTIATION_BOUNDS_REQUIRED",
      "negotiationBounds are required for a mandate version whose allowedActionTypes " +
        "include negotiation/envoy work (Vera §8.4, layer 1)"
    );
  }
  if (input.expiresAtSeq !== null && input.expiresAtSeq !== undefined && !Number.isInteger(input.expiresAtSeq)) {
    throw new NpcCoreError("INVALID_EXPIRY", "expiresAtSeq must be an integer seq or null");
  }
  if (
    input.horizonActions !== null &&
    input.horizonActions !== undefined &&
    (!Number.isInteger(input.horizonActions) || input.horizonActions < 1)
  ) {
    throw new NpcCoreError("INVALID_HORIZON", "horizonActions must be a positive integer or null");
  }
  const version: SimMandateVersion = {
    version: input.version,
    npcId: input.npcId,
    cityId: input.cityId,
    ownerUid: input.ownerUid,
    permissionMode: input.permissionMode,
    scopeFreeform: input.scopeFreeform,
    structuredScope: scope,
    caps,
    negotiationBounds: bounds,
    alwaysEscalate: [...(input.alwaysEscalate ?? [])],
    responseStyle: input.responseStyle ?? null,
    expiresAtSeq: input.expiresAtSeq ?? null,
    horizonActions: input.horizonActions ?? null,
    sourceActionId: input.sourceActionId,
    effectiveSeq: null,
    supersededSeq: null,
    mandateHash: "",
    createdAt: now,
  };
  version.mandateHash = mandateHash(version);
  return version;
}

/** Build the mandate root record in `pending` posture (brief §2.3). */
export function buildMandateRoot(
  mandateId: string,
  firstVersion: SimMandateVersion,
  now: Date
): SimMandateRoot {
  return {
    mandateId,
    npcId: firstVersion.npcId,
    cityId: firstVersion.cityId,
    ownerUid: firstVersion.ownerUid,
    currentVersion: firstVersion.version,
    status: "pending",
    currentVersionRef: `sim_mandates/${mandateId}/versions/${firstVersion.version}`,
    createdSeq: null,
    revokedSeq: null,
    expiresAtSeq: firstVersion.expiresAtSeq,
    createdAt: now,
    updatedAt: now,
  };
}

/** Expiry is derived from seq, never from a clock (brief §2.3). Either
 * the root's or the version's `expiresAtSeq` may carry the horizon; the
 * earlier one governs. Expiry AT the seq counts as expired: a mandate
 * expiring at seq N is not in force for entries at seq >= N. */
export function isMandateExpiredAt(
  root: SimMandateRoot,
  version: SimMandateVersion,
  atSeq: number
): boolean {
  const expiry = [root.expiresAtSeq, version.expiresAtSeq]
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b)[0];
  return expiry !== undefined && atSeq >= expiry;
}

/** Horizon (delegated-resolution count) exhaustion (brief §2.3). */
export function isHorizonExhausted(
  version: SimMandateVersion,
  delegatedResolutionsUsed: number
): boolean {
  return version.horizonActions !== null && delegatedResolutionsUsed >= version.horizonActions;
}

export type CurrentVersionReason =
  | "current"
  | "no-version-effective"
  | "revoked"
  | "expired"
  | "horizon-exhausted";

export interface CurrentVersionResolution {
  version: SimMandateVersion | null;
  reason: CurrentVersionReason;
}

/**
 * The mandate version in force at a Log seq (the traceability triple's
 * second link, TC-N02): the version whose effectiveness window covers
 * `atSeq`, provided the root is unrevoked and unexpired there and the
 * horizon is not exhausted. Pure over the records handed in — the
 * caller (authority stage / verifier) supplies the snapshot's versions.
 */
export function resolveVersionInForce(
  root: SimMandateRoot,
  versions: ReadonlyArray<SimMandateVersion>,
  atSeq: number,
  delegatedResolutionsUsed = 0
): CurrentVersionResolution {
  if (root.revokedSeq !== null && atSeq >= root.revokedSeq) {
    return { version: null, reason: "revoked" };
  }
  const inWindow = versions
    .filter(
      (v) =>
        v.npcId === root.npcId &&
        v.effectiveSeq !== null &&
        v.effectiveSeq <= atSeq &&
        (v.supersededSeq === null || v.supersededSeq > atSeq)
    )
    .sort((a, b) => b.version - a.version)[0];
  if (!inWindow) return { version: null, reason: "no-version-effective" };
  if (isMandateExpiredAt(root, inWindow, atSeq)) {
    return { version: null, reason: "expired" };
  }
  if (isHorizonExhausted(inWindow, delegatedResolutionsUsed)) {
    return { version: null, reason: "horizon-exhausted" };
  }
  return { version: inWindow, reason: "current" };
}

// ---------------------------------------------------------------------------
// Golden vectors — fixed authority payloads and their canonical digests.
// Regenerate ONLY by recomputing over the payloads below and recording
// why in the prep report; a hash change here is a contract change.
// ---------------------------------------------------------------------------

export interface MandateGoldenVector {
  name: string;
  payload: Record<string, unknown>;
  sha256: string;
}

export const MANDATE_GOLDEN_VECTORS: MandateGoldenVector[] = [
  {
    name: "minimal ask-first steward mandate",
    payload: {
      version: 1,
      npcId: "char-steward-1",
      cityId: "cascadia",
      ownerUid: "uid-owner-1",
      permissionMode: "ask-first",
      scopeFreeform: "Keep the granary accounts tidy and draft replies to routine petitions.",
      structuredScope: {
        triggerKinds: ["log-event"],
        allowedActionTypes: ["R-11"],
        namedRecordIds: [],
        counterpartyCityIds: null,
      },
      caps: {
        perActionRubars: null,
        perResolutionPeriodRubars: null,
        periodDefinition: null,
        maxProjectPhase: null,
        allowPartialExecution: false,
      },
      negotiationBounds: null,
      alwaysEscalate: [],
      responseStyle: null,
      expiresAtSeq: null,
      horizonActions: null,
      sourceActionId: "act-golden-1",
    },
    sha256: "b26a9c98523aef0ced9661829ac414182721d3c63c2a9373c2e09b7c77da3d44",
  },
  {
    name: "act-for-me envoy mandate with caps and bounds",
    payload: {
      version: 3,
      npcId: "char-envoy-7",
      cityId: "chess-city",
      ownerUid: "uid-owner-2",
      permissionMode: "act-for-me",
      scopeFreeform: "Carry routine trade talk with Chess City's neighbours; never sign anything.",
      structuredScope: {
        triggerKinds: ["log-event", "situation"],
        allowedActionTypes: ["R-05", "envoy.negotiate"],
        namedRecordIds: ["rec-market-1"],
        counterpartyCityIds: ["evan-city"],
      },
      caps: {
        perActionRubars: 5000,
        perResolutionPeriodRubars: 20000,
        periodDefinition: { kind: "actions", count: 10 },
        maxProjectPhase: 2,
        allowPartialExecution: false,
        surveyBudgetRubars: 750,
      },
      negotiationBounds: {
        mayOffer: "price concessions up to the walk-away line",
        mayAccept: false,
        walkAwayIf: "counterparty demands exclusivity",
        maxTurns: 4,
      },
      alwaysEscalate: ["treaty.sign"],
      responseStyle: "formal, brief",
      expiresAtSeq: 900,
      horizonActions: 25,
      sourceActionId: "act-golden-2",
    },
    sha256: "d9411628fec1d37efd2e547ca9ec0a66fcb60041d0928783299c46def7c5fdcc",
  },
];
