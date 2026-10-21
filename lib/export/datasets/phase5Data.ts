/**
 * Input shapes for the Phase 5 datasets (brief §11.4): the owner's
 * Situations history and their NPC / mandate / delegation-rule
 * register. Like the Phase 3/4 datasets, these are PURE inputs: the
 * fetch layer (../fetchPhase5Export.ts) fills them from
 * rules-governed reads executed as the requester, and the builders
 * in ./phase5Workbook.ts turn them into SheetSpecs.
 *
 * Fairness boundary (CJ's data rule; P5-G10's export half): fair to
 * see is fair to export, and a surface that cannot prove scope does
 * not offer the download. Both datasets are therefore
 * requester-scoped BY CONSTRUCTION — the situations bundle contains
 * only cards addressed to the requester or to a city they own;
 * the register contains only the requester's own NPCs, mandates,
 * and rules (delegation rules are author-private records, §9.7) —
 * and the builders RE-ASSERT that scope in the pure layer
 * (fail-closed) rather than trusting the fetch.
 */

export interface SituationExportRow {
  situationId: string;
  kind: string;
  status: string;
  severity: string;
  title: string;
  summary: string;
  cityId: string | null;
  audienceCityId: string | null;
  /** Carried for the scope assertion; never rendered as a column
   * beyond the provenance block's discipline. */
  recipientUid: string | null;
  createdSeq: number | null;
  resolvedSeq: number | null;
  handlingMode: string | null;
  handlingNpcId: string | null;
  handlingMandateId: string | null;
  handlingMandateVersion: number | null;
  delegationRuleId: string | null;
  delegationCycleCount: number;
  sourceKind: string;
  sourceSeq: number | null;
}

export interface SituationsHistoryBundle {
  requesterUid: string;
  ownedCityIds: string[];
  cityNames: Record<string, string>;
  situations: SituationExportRow[];
}

export interface NpcExportRow {
  npcId: string;
  ownerUid: string;
  cityId: string;
  displayName: string;
  title: string;
  permissionMode: string;
  status: string;
  currentMandateId: string | null;
  currentMandateVersion: number | null;
  activationSeq: number | null;
  retiredSeq: number | null;
}

export interface MandateVersionExportRow {
  mandateId: string;
  ownerUid: string;
  npcId: string;
  cityId: string;
  rootStatus: string;
  version: number;
  permissionMode: string;
  scopeFreeform: string;
  triggerKinds: string;
  allowedActionTypes: string;
  namedRecordIds: string;
  perActionRubars: number | null;
  perResolutionPeriodRubars: number | null;
  periodDefinition: string | null;
  allowPartialExecution: boolean;
  alwaysEscalate: string;
  mandateHash: string;
  effectiveSeq: number | null;
  supersededSeq: number | null;
}

export interface DelegationRuleExportRow {
  ruleId: string;
  ownerUid: string;
  cityId: string;
  version: number;
  enabled: boolean;
  status: string;
  alwaysWait: boolean;
  situationKinds: string;
  handlerNpcId: string | null;
  handlerMode: string;
  handlerMandateId: string | null;
  perActionRubars: number | null;
  ruleHash: string;
  effectiveSeq: number | null;
}

export interface NpcRegisterBundle {
  requesterUid: string;
  cityNames: Record<string, string>;
  npcs: NpcExportRow[];
  mandates: MandateVersionExportRow[];
  rules: DelegationRuleExportRow[];
}

/** The workbook context the fetch layer supplies (mirrors the
 * Phase 4 builders' context discipline). */
export interface Phase5ExportContext {
  asOfSeq: number;
  rulesVersion: string | null;
  exportedAtIso: string;
  exportedByLabel: string;
}
