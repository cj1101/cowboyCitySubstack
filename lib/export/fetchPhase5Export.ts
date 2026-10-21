/**
 * Phase 5 export fetchers + download runners (brief §11.4).
 *
 * The fetchers execute the SAME as-requester reads the surfaces
 * use — the situations queue's two provable query shapes
 * (`recipientUid == uid`; `audienceCityId ==` each owned city), the
 * owner's NPC records, their mandate roots + every authored
 * version, and their author-private delegation rules — so the
 * exported scope is the visible scope by construction, and the
 * pure builders re-assert it before any file exists (fail-closed,
 * P5-G10's export half). A surface that cannot prove scope does
 * not offer the download: these runners are only wired into
 * signed-in owner surfaces, and a failed or out-of-scope read
 * produces an error message, never a partial file.
 */

import { getAllFactions } from "@/lib/firestore/posts";
import { loadQueue, loadDelegationRules } from "@/lib/situations/client";
import {
  loadMandateRoot,
  loadMandateVersions,
  loadMyNpcs,
} from "@/lib/npcs/client";
import { deliverWorkbook, type ExportFormat } from "./download";
import type {
  NpcRegisterBundle,
  Phase5ExportContext,
  SituationsHistoryBundle,
} from "./datasets/phase5Data";
import {
  buildNpcRegisterWorkbook,
  buildSituationsWorkbook,
} from "./datasets/phase5Workbook";

async function cityContext(uid: string): Promise<{
  ownedCityIds: string[];
  cityNames: Record<string, string>;
}> {
  const factions = await getAllFactions();
  const cityNames: Record<string, string> = {};
  for (const f of factions) cityNames[f.id] = f.name;
  return {
    ownedCityIds: factions
      .filter((f) => f.ownerUids.includes(uid))
      .map((f) => f.id),
    cityNames,
  };
}

export async function fetchSituationsHistory(
  uid: string
): Promise<{ bundle: SituationsHistoryBundle; ctx: Phase5ExportContext }> {
  const { ownedCityIds, cityNames } = await cityContext(uid);
  const queue = await loadQueue(uid, ownedCityIds);
  const situations = queue.map((s) => ({
    situationId: s.situationId,
    kind: s.kind,
    status: s.status,
    severity: s.severity,
    title: s.title,
    summary: s.summary,
    cityId: s.cityId,
    audienceCityId: s.audienceCityId,
    recipientUid: s.recipientUid,
    createdSeq: s.createdSeq,
    resolvedSeq: s.resolvedSeq,
    handlingMode: s.handling?.mode ?? null,
    handlingNpcId: s.handling?.npcId ?? null,
    handlingMandateId: s.handling?.mandateId ?? null,
    handlingMandateVersion: s.handling?.mandateVersion ?? null,
    delegationRuleId: s.handling?.delegationRuleId ?? null,
    delegationCycleCount: s.delegationCycleCount,
    sourceKind: s.source.kind,
    sourceSeq: s.source.sourceSeq,
  }));
  const asOfSeq = situations.reduce(
    (max, s) => Math.max(max, s.resolvedSeq ?? 0, s.createdSeq ?? 0),
    0
  );
  return {
    bundle: { requesterUid: uid, ownedCityIds, cityNames, situations },
    ctx: {
      asOfSeq,
      rulesVersion: null,
      exportedAtIso: new Date().toISOString(),
      exportedByLabel: "the requesting member",
    },
  };
}

export async function fetchNpcRegister(
  uid: string
): Promise<{ bundle: NpcRegisterBundle; ctx: Phase5ExportContext }> {
  const { cityNames } = await cityContext(uid);
  const [npcRows, ruleRows] = await Promise.all([
    loadMyNpcs(uid),
    loadDelegationRules(uid),
  ]);
  const mandates: NpcRegisterBundle["mandates"] = [];
  let asOfSeq = 0;
  for (const npc of npcRows) {
    asOfSeq = Math.max(asOfSeq, npc.activationSeq ?? 0, npc.retiredSeq ?? 0);
    if (!npc.currentMandateId) continue;
    const root = await loadMandateRoot(npc.currentMandateId);
    if (!root) continue;
    const versions = await loadMandateVersions(root.mandateId);
    for (const v of versions) {
      asOfSeq = Math.max(asOfSeq, v.effectiveSeq ?? 0);
      mandates.push({
        mandateId: root.mandateId,
        ownerUid: v.ownerUid,
        npcId: v.npcId,
        cityId: v.cityId,
        rootStatus: root.status,
        version: v.version,
        permissionMode: v.permissionMode,
        scopeFreeform: v.scopeFreeform,
        triggerKinds: v.structuredScope.triggerKinds.join(", "),
        allowedActionTypes: v.structuredScope.allowedActionTypes.join(", "),
        namedRecordIds: v.structuredScope.namedRecordIds.join(", "),
        perActionRubars: v.caps.perActionRubars,
        perResolutionPeriodRubars: v.caps.perResolutionPeriodRubars,
        periodDefinition: v.caps.periodDefinition
          ? `${v.caps.periodDefinition.count} ${v.caps.periodDefinition.kind}`
          : null,
        allowPartialExecution: v.caps.allowPartialExecution,
        alwaysEscalate: v.alwaysEscalate.join(", "),
        mandateHash: v.mandateHash,
        effectiveSeq: v.effectiveSeq,
        supersededSeq: v.supersededSeq,
      });
    }
  }
  for (const r of ruleRows) asOfSeq = Math.max(asOfSeq, r.effectiveSeq ?? 0);
  return {
    bundle: {
      requesterUid: uid,
      cityNames,
      npcs: npcRows.map((npc) => ({
        npcId: npc.npcId,
        ownerUid: npc.ownerUid,
        cityId: npc.cityId,
        displayName: npc.displayNameSnapshot,
        title: npc.titleFreeform,
        permissionMode: npc.permissionMode,
        status: npc.status,
        currentMandateId: npc.currentMandateId,
        currentMandateVersion: npc.currentMandateVersion,
        activationSeq: npc.activationSeq,
        retiredSeq: npc.retiredSeq,
      })),
      mandates,
      rules: ruleRows.map((r) => ({
        ruleId: r.ruleId,
        ownerUid: r.ownerUid,
        cityId: r.cityId,
        version: r.version,
        enabled: r.enabled,
        status: r.status,
        alwaysWait: r.alwaysWait,
        situationKinds: r.match.situationKinds.join(", "),
        handlerNpcId: r.handler.npcId,
        handlerMode: r.handler.mode,
        handlerMandateId: r.handler.mandateId,
        perActionRubars:
          typeof r.caps.perActionRubars === "number"
            ? r.caps.perActionRubars
            : null,
        ruleHash: r.ruleHash,
        effectiveSeq: r.effectiveSeq,
      })),
    },
    ctx: {
      asOfSeq,
      rulesVersion: null,
      exportedAtIso: new Date().toISOString(),
      exportedByLabel: "the requesting member",
    },
  };
}

/** Download the owner's Situations history workbook. Throws
 * (fail-closed) before any file exists when the read or the scope
 * assertion fails — callers surface the error. */
export async function downloadSituationsHistory(
  uid: string,
  format: ExportFormat
): Promise<void> {
  const { bundle, ctx } = await fetchSituationsHistory(uid);
  const workbook = buildSituationsWorkbook(bundle, ctx, uid);
  await deliverWorkbook(workbook, format);
}

/** Download the owner's NPC / mandate / rule register workbook. */
export async function downloadNpcRegister(
  uid: string,
  format: ExportFormat
): Promise<void> {
  const { bundle, ctx } = await fetchNpcRegister(uid);
  const workbook = buildNpcRegisterWorkbook(bundle, ctx, uid);
  await deliverWorkbook(workbook, format);
}
