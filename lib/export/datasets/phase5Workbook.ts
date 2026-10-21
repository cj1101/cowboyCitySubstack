/**
 * The Phase 5 workbook builders (brief §11.4): the owner's
 * Situations history and their NPC / mandate / delegation-rule
 * register, as downloadable Excel (.xlsx) with CSV companions, per
 * CJ's downloadable-Excel-only rule.
 *
 * Fail-closed scope (P5-G10's export half): each builder re-asserts
 * the requester scope before a single row is planned. A situations
 * row the requester neither received nor owns the audience city
 * for — or a register row owned by someone else — throws, and no
 * file is produced. What a member cannot see in the app, they
 * cannot carry out of it in a spreadsheet.
 */

import {
  ExportError,
  assembleWorkbook,
  exportFilenameBase,
  provenanceValues,
  withProvenance,
  type PlannedWorkbook,
  type SheetColumn,
  type SheetSpec,
} from "../sheetSpec";
import type {
  NpcRegisterBundle,
  Phase5ExportContext,
  SituationsHistoryBundle,
} from "./phase5Data";

const SITUATION_COLUMNS: SheetColumn[] = [
  { key: "situation_id", header: "situation_id", width: 22, type: "string" },
  { key: "kind", header: "kind", width: 18, type: "string" },
  { key: "status", header: "status", width: 14, type: "string" },
  { key: "severity", header: "severity", width: 11, type: "string" },
  { key: "title", header: "title", width: 40, type: "string" },
  { key: "summary", header: "summary", width: 60, type: "string" },
  { key: "created_seq", header: "created_seq", width: 12, type: "number" },
  { key: "resolved_seq", header: "resolved_seq", width: 12, type: "number" },
  { key: "handling_mode", header: "handling_mode", width: 14, type: "string" },
  { key: "handling_npc_id", header: "handling_npc_id", width: 18, type: "string" },
  { key: "handling_mandate", header: "handling_mandate", width: 22, type: "string" },
  { key: "delegation_rule_id", header: "delegation_rule_id", width: 20, type: "string" },
  { key: "delegation_cycles", header: "delegation_cycles", width: 15, type: "number" },
  { key: "source_kind", header: "source_kind", width: 14, type: "string" },
  { key: "source_seq", header: "source_seq", width: 11, type: "number" },
];

const NPC_COLUMNS: SheetColumn[] = [
  { key: "npc_id", header: "npc_id", width: 20, type: "string" },
  { key: "display_name", header: "display_name", width: 24, type: "string" },
  { key: "title", header: "title", width: 24, type: "string" },
  { key: "permission_mode", header: "permission_mode", width: 15, type: "string" },
  { key: "status", header: "status", width: 16, type: "string" },
  { key: "current_mandate", header: "current_mandate", width: 24, type: "string" },
  { key: "activation_seq", header: "activation_seq", width: 14, type: "number" },
  { key: "retired_seq", header: "retired_seq", width: 12, type: "number" },
];

const MANDATE_COLUMNS: SheetColumn[] = [
  { key: "mandate_id", header: "mandate_id", width: 22, type: "string" },
  { key: "npc_id", header: "npc_id", width: 20, type: "string" },
  { key: "version", header: "version", width: 9, type: "number" },
  { key: "root_status", header: "root_status", width: 12, type: "string" },
  { key: "permission_mode", header: "permission_mode", width: 15, type: "string" },
  { key: "scope_freeform", header: "scope_freeform", width: 50, type: "string" },
  { key: "trigger_kinds", header: "trigger_kinds", width: 30, type: "string" },
  { key: "allowed_action_types", header: "allowed_action_types", width: 30, type: "string" },
  { key: "named_record_ids", header: "named_record_ids", width: 30, type: "string" },
  { key: "per_action_rubars", header: "per_action_rubars", width: 17, type: "number" },
  { key: "per_period_rubars", header: "per_period_rubars", width: 17, type: "number" },
  { key: "period_definition", header: "period_definition", width: 18, type: "string" },
  { key: "allow_partial_execution", header: "allow_partial_execution", width: 20, type: "boolean" },
  { key: "always_escalate", header: "always_escalate", width: 30, type: "string" },
  { key: "mandate_hash", header: "mandate_hash", width: 30, type: "string" },
  { key: "effective_seq", header: "effective_seq", width: 13, type: "number" },
  { key: "superseded_seq", header: "superseded_seq", width: 14, type: "number" },
];

const RULE_COLUMNS: SheetColumn[] = [
  { key: "rule_id", header: "rule_id", width: 22, type: "string" },
  { key: "version", header: "version", width: 9, type: "number" },
  { key: "enabled", header: "enabled", width: 9, type: "boolean" },
  { key: "status", header: "status", width: 12, type: "string" },
  { key: "always_wait", header: "always_wait", width: 11, type: "boolean" },
  { key: "situation_kinds", header: "situation_kinds", width: 30, type: "string" },
  { key: "handler_npc_id", header: "handler_npc_id", width: 18, type: "string" },
  { key: "handler_mode", header: "handler_mode", width: 15, type: "string" },
  { key: "handler_mandate_id", header: "handler_mandate_id", width: 20, type: "string" },
  { key: "per_action_rubars", header: "per_action_rubars", width: 17, type: "number" },
  { key: "rule_hash", header: "rule_hash", width: 30, type: "string" },
  { key: "effective_seq", header: "effective_seq", width: 13, type: "number" },
];

function assertSituationsScope(
  bundle: SituationsHistoryBundle,
  requesterUid: string
): void {
  if (bundle.requesterUid !== requesterUid) {
    throw new ExportError(
      "This situations bundle was not assembled for the requesting member — no file was produced."
    );
  }
  const owned = new Set(bundle.ownedCityIds);
  for (const row of bundle.situations) {
    const addressedToRequester = row.recipientUid === requesterUid;
    const audienceOwned =
      row.audienceCityId !== null && owned.has(row.audienceCityId);
    if (!addressedToRequester && !audienceOwned) {
      throw new ExportError(
        `Situation ${row.situationId} is outside the requester's audience — the export was refused rather than narrowed silently. No file was produced.`
      );
    }
  }
}

function assertRegisterScope(
  bundle: NpcRegisterBundle,
  requesterUid: string
): void {
  if (bundle.requesterUid !== requesterUid) {
    throw new ExportError(
      "This register bundle was not assembled for the requesting member — no file was produced."
    );
  }
  for (const row of [...bundle.npcs, ...bundle.mandates, ...bundle.rules]) {
    if (row.ownerUid !== requesterUid) {
      throw new ExportError(
        "The register contains a record owned by another member — the export was refused rather than narrowed silently. No file was produced."
      );
    }
  }
}

const TERMINAL = new Set(["handled", "silent", "superseded"]);

export function buildSituationsWorkbook(
  bundle: SituationsHistoryBundle,
  ctx: Phase5ExportContext,
  requesterUid: string
): PlannedWorkbook {
  assertSituationsScope(bundle, requesterUid);
  const toRow = (row: (typeof bundle.situations)[number]) => {
    const cityId = row.audienceCityId ?? row.cityId;
    return {
      situation_id: row.situationId,
      kind: row.kind,
      status: row.status,
      severity: row.severity,
      title: row.title,
      summary: row.summary,
      created_seq: row.createdSeq,
      resolved_seq: row.resolvedSeq,
      handling_mode: row.handlingMode,
      handling_npc_id: row.handlingNpcId,
      handling_mandate:
        row.handlingMandateId !== null
          ? `${row.handlingMandateId} v${row.handlingMandateVersion ?? "?"}`
          : null,
      delegation_rule_id: row.delegationRuleId,
      delegation_cycles: row.delegationCycleCount,
      source_kind: row.sourceKind,
      source_seq: row.sourceSeq,
      ...provenanceValues({
        cityId,
        cityName: cityId ? (bundle.cityNames[cityId] ?? null) : null,
        entityId: row.situationId,
        entityName: row.title,
        trustTier: "verified",
        sourceType: "resolver",
        sourceRef: row.resolvedSeq
          ? `seq ${row.resolvedSeq}`
          : row.createdSeq
            ? `seq ${row.createdSeq}`
            : null,
        asOfSeq: ctx.asOfSeq,
        rulesVersion: ctx.rulesVersion,
        notes:
          row.status === "silent"
            ? "Closed as silent: the recorded non-response is a complete outcome (the leader didn't say anything)."
            : null,
      }),
    };
  };
  const waiting: SheetSpec = {
    name: "Waiting",
    columns: withProvenance(SITUATION_COLUMNS),
    rows: bundle.situations.filter((r) => !TERMINAL.has(r.status)).map(toRow),
  };
  const history: SheetSpec = {
    name: "History",
    columns: withProvenance(SITUATION_COLUMNS),
    rows: bundle.situations.filter((r) => TERMINAL.has(r.status)).map(toRow),
  };
  return assembleWorkbook({
    filenameBase: exportFilenameBase("situations", ctx.asOfSeq, ctx.exportedAtIso),
    meta: {
      title: "My Situations — waiting and history",
      scopeLabel:
        "Every situation addressed to the requesting member or to a city they own — the same audience the queue page reads.",
      exportedAtIso: ctx.exportedAtIso,
      exportedByLabel: ctx.exportedByLabel,
      asOfSeq: ctx.asOfSeq,
      rulesVersion: ctx.rulesVersion,
      containsOwnerPublished: false,
    },
    dataSheets: [waiting, history],
    definitions: [
      { tab: "Waiting", column: "handling_mode", meaning: "How the matter was decided: self, delegated, auto-delegated (by a rule), or silent.", unit: null, trustTier: "verified", source: "resolver" },
      { tab: "History", column: "delegation_cycles", meaning: "How many times a delegate's escalation returned the card to the owner's queue.", unit: null, trustTier: "verified", source: "resolver" },
      { tab: "History", column: "source_seq", meaning: "The Log seq of the entry that produced this situation.", unit: null, trustTier: "verified", source: "resolver" },
    ],
  });
}

export function buildNpcRegisterWorkbook(
  bundle: NpcRegisterBundle,
  ctx: Phase5ExportContext,
  requesterUid: string
): PlannedWorkbook {
  assertRegisterScope(bundle, requesterUid);
  const npcSheet: SheetSpec = {
    name: "NPCs",
    columns: withProvenance(NPC_COLUMNS),
    rows: bundle.npcs.map((npc) => ({
      npc_id: npc.npcId,
      display_name: npc.displayName,
      title: npc.title,
      permission_mode: npc.permissionMode,
      status: npc.status,
      current_mandate:
        npc.currentMandateId !== null
          ? `${npc.currentMandateId} v${npc.currentMandateVersion ?? "?"}`
          : null,
      activation_seq: npc.activationSeq,
      retired_seq: npc.retiredSeq,
      ...provenanceValues({
        cityId: npc.cityId,
        cityName: bundle.cityNames[npc.cityId] ?? null,
        entityId: npc.npcId,
        entityName: npc.displayName,
        trustTier: "verified",
        sourceType: "resolver",
        sourceRef: npc.activationSeq ? `seq ${npc.activationSeq}` : null,
        asOfSeq: ctx.asOfSeq,
        rulesVersion: ctx.rulesVersion,
        notes:
          "NPC records are the member's own delegation records; acts they took are in the Log, badged with the NPC's name, for this owner.",
      }),
    })),
  };
  const mandateSheet: SheetSpec = {
    name: "Mandates",
    columns: withProvenance(MANDATE_COLUMNS),
    rows: bundle.mandates.map((m) => ({
      mandate_id: m.mandateId,
      npc_id: m.npcId,
      version: m.version,
      root_status: m.rootStatus,
      permission_mode: m.permissionMode,
      scope_freeform: m.scopeFreeform,
      trigger_kinds: m.triggerKinds,
      allowed_action_types: m.allowedActionTypes,
      named_record_ids: m.namedRecordIds,
      per_action_rubars: m.perActionRubars,
      per_period_rubars: m.perResolutionPeriodRubars,
      period_definition: m.periodDefinition,
      allow_partial_execution: m.allowPartialExecution,
      always_escalate: m.alwaysEscalate,
      mandate_hash: m.mandateHash,
      effective_seq: m.effectiveSeq,
      superseded_seq: m.supersededSeq,
      ...provenanceValues({
        cityId: m.cityId,
        cityName: bundle.cityNames[m.cityId] ?? null,
        entityId: m.mandateId,
        entityName: `mandate v${m.version}`,
        trustTier: "verified",
        sourceType: "resolver",
        sourceRef: m.effectiveSeq ? `seq ${m.effectiveSeq}` : null,
        asOfSeq: ctx.asOfSeq,
        rulesVersion: ctx.rulesVersion,
        notes:
          "Mandate versions are immutable; a superseded version stays listed because acts taken under it cite it.",
      }),
    })),
  };
  const ruleSheet: SheetSpec = {
    name: "Delegation rules",
    columns: withProvenance(RULE_COLUMNS),
    rows: bundle.rules.map((r) => ({
      rule_id: r.ruleId,
      version: r.version,
      enabled: r.enabled,
      status: r.status,
      always_wait: r.alwaysWait,
      situation_kinds: r.situationKinds,
      handler_npc_id: r.handlerNpcId,
      handler_mode: r.handlerMode,
      handler_mandate_id: r.handlerMandateId,
      per_action_rubars: r.perActionRubars,
      rule_hash: r.ruleHash,
      effective_seq: r.effectiveSeq,
      ...provenanceValues({
        cityId: r.cityId,
        cityName: bundle.cityNames[r.cityId] ?? null,
        entityId: r.ruleId,
        entityName: `rule v${r.version}`,
        trustTier: "verified",
        sourceType: "resolver",
        sourceRef: r.effectiveSeq ? `seq ${r.effectiveSeq}` : null,
        asOfSeq: ctx.asOfSeq,
        rulesVersion: ctx.rulesVersion,
        notes:
          "Delegation rules are the author's private records (§9.7 posture): they export only to their author.",
      }),
    })),
  };
  return assembleWorkbook({
    filenameBase: exportFilenameBase("npc-register", ctx.asOfSeq, ctx.exportedAtIso),
    meta: {
      title: "My NPC, mandate, and delegation-rule register",
      scopeLabel:
        "The requesting member's own NPC records, every mandate version they authored, and their delegation rules.",
      exportedAtIso: ctx.exportedAtIso,
      exportedByLabel: ctx.exportedByLabel,
      asOfSeq: ctx.asOfSeq,
      rulesVersion: ctx.rulesVersion,
      containsOwnerPublished: false,
    },
    dataSheets: [npcSheet, mandateSheet, ruleSheet],
    definitions: [
      { tab: "NPCs", column: "permission_mode", meaning: "The NPC's response posture: act-for-me, ask-first, or silent (say nothing).", unit: null, trustTier: "verified", source: "resolver" },
      { tab: "Mandates", column: "mandate_hash", meaning: "The canonical hash of the mandate version's authority payload — read-only, as shown in Settings.", unit: null, trustTier: "verified", source: "resolver" },
      { tab: "Mandates", column: "period_definition", meaning: "Caps periods are counted in actions or Log entries; this world has no wall-clock periods.", unit: null, trustTier: "verified", source: "resolver" },
    ],
  });
}
