/**
 * Lore adoption — R-11 (Phase 4 brief §4.5, step 11).
 *
 * R-11 (publish and adopt lore) lands here as the ADOPTION COMMIT
 * PATH: adopting a draft is a Resolution Event with canon provenance
 * recorded (TC-C02). The pipelines that PRODUCE drafts at scale are
 * not Phase 4 — ingestion is Phase 6, chronicle drafts arrive as
 * resolution outputs (§2.6) — so this family consumes drafts that
 * exist, in the two shapes the design fixes:
 *
 *  - `adopt_lore_draft` — a `sim_wiki_entry_drafts/{draftId}` draft
 *    (Dana backend §3.9): the adoption commit creates the immutable
 *    version snapshot `wiki_entries/{entryId}/versions/{n}`, advances
 *    the entry's current pointer + provenance fields, and marks the
 *    draft adopted, in the same event. A brand-new entry is created
 *    with the deterministic preallocated id `wiki_<draftId>`.
 *  - `adopt_chronicle_draft` — a `drafts/{draftId}` post-draft badged
 *    `sim` (brief §1.6, produced by the committer under the Lead's
 *    badging wiring — see buildChronicleDraftDoc below): adoption
 *    publishes it into `posts/{draftId}` as a canon post carrying the
 *    full provenance chain, and consumes the draft.
 *
 * CJ's bindings, as built:
 *  - Sovereignty is absolute: adoption is the SUBJECT city's owner's
 *    act; there is no cross-city adoption path (the authority read is
 *    against the draft's own recorded city, never the actor's
 *    nomination — F-01 discipline).
 *  - Adoption is structurally owner-only. An NPC's output is a draft,
 *    never an adoption (TC-N04/N06 never-bind): this family refuses
 *    non-member actors BEFORE the authority check, because the landed
 *    authority helper honors `onBehalfOfMemberId` for ordinary acts
 *    and canon must not ride a delegation. The shared city follows
 *    the landed posture: a shared-office MAYOR actor adopts for it
 *    (CJ round 3 — the sitting mayor only); Phase 7's term records
 *    refine who that is, not this handler.
 *  - Nothing auto-adopts. An unadopted draft changes no canon and no
 *    state (TC-C02/TC-C04, P4-G4-C3). Drafts never expire into
 *    adoption; silence is a draft staying a draft, forever.
 *  - Contradictions surface as RETCON PROPOSALS, never overwrites
 *    (Dana §3.9 step 5; CJ's re-upload ruling): a draft whose
 *    changeType is `retcon_conflict`, or whose baseWikiVersion no
 *    longer matches the entry's currentVersion (canon moved under
 *    it), resolves by writing a `retconProposal` block onto the draft
 *    and logging the surfacing. The entry, its versions, and every
 *    canon surface stay byte-identical. Deciding the retcon is a
 *    later owner act (Phase 6 Situations machinery).
 *  - No index changes, ever: `loreRichness` is DERIVED (spec §2.2 —
 *    4 × adopted entries + 2 × profiled canon structures + 1 ×
 *    profiled named citizens) and rises by computation as adoption
 *    records land. This handler writes records, never a richness
 *    number.
 *  - Lore naming another city creates a CROSS-REFERENCE record on
 *    that city (spec R-11 spillover): visible, labeled, carrying no
 *    copied canon, removable by that owner via a later logged action
 *    (the removal action itself is not Phase 4 scope).
 *
 * Discipline (landed §5.3 + Step 0): handlers are pure (snapshot,
 * action) → plan; ids and seqs are deterministic (seq-bearing fields
 * derive from the snapshot's counter head by allocation's commitSeq
 * convention — the summary entry's own seq); timestamps are null
 * placeholders the committer stamps; record effects outside
 * `sim_cities` ride `cityId: null` entries in the finance change
 * grammar (the F-02 reconciliation reconciles city-scoped entries
 * only). Local copies of the registry's small helpers keep this
 * module free of an import cycle with the registry that will import
 * it (the structures/defensive precedent).
 *
 * This file is NOT registered in `registry.ts` — the Build Lead makes
 * the single assembly edit (register LORE_DESCRIPTORS).
 */

import {
  docField,
  emptyPlan,
  snapshotDoc,
  type CollectionQuerySpec,
  type LogEntryDraft,
  type ResolutionPlan,
  type SimAction,
  type SimCitations,
  type SimSnapshot,
} from "../state";
import { sha256Hex } from "../canonical";
import { searchTokensFrom } from "../../search/tokens";
import {
  fieldChange,
  planWrite,
  rejectedPlan,
  ruleEffectDraft,
  summaryDraft,
} from "./planHelpers";
import type {
  DescriptorReadPlan,
  HandlerContext,
  ReadPlanSeeds,
  RuleDescriptor,
} from "./registry";

// ---------------------------------------------------------------------------
// Constants + paths
// ---------------------------------------------------------------------------

/** The canon layers an adoption may choose (spec §3 R-11). `sim` is a
 * draft badge, never an adoption target. */
export const CANON_LAYERS = ["realm", "deep", "current"] as const;
export type CanonLayer = (typeof CANON_LAYERS)[number];

/** The chronicle-draft badge value (brief §1.6: "badged `sim`"). */
export const CHRONICLE_BADGE = "sim";

/** Read-plan id for the subject city's wiki entries (the adoption
 * target is found among them by the draft's own recorded entry id). */
export const WIKI_ENTRIES_QUERY_ID = "lore-wiki-entries-by-city";

export const wikiDraftPath = (draftId: string): string =>
  `sim_wiki_entry_drafts/${draftId}`;
export const wikiEntryPath = (entryId: string): string => `wiki_entries/${entryId}`;
export const wikiVersionPath = (entryId: string, version: number): string =>
  `wiki_entries/${entryId}/versions/${version}`;
export const chronicleDraftPath = (draftId: string): string => `drafts/${draftId}`;
export const postPath = (postId: string): string => `posts/${postId}`;
export const loreCrossRefPath = (cityId: string, entryId: string): string =>
  `sim_cities/${cityId}/lore_cross_refs/${entryId}`;

/** Dana §3.9's "preallocated ID" for a brand-new entry, as a pure
 * function of the draft (the resolver is replay-deterministic). */
export const wikiEntryIdForDraft = (draftId: string): string => `wiki_${draftId}`;

/** The chronicle draft id a resolution's badging produces:
 * deterministic in the resolution, so preview, commit, and the Log
 * entry's `chronicleDraftId` all name the same record. */
export const chronicleDraftIdForResolution = (resolutionId: string): string =>
  `chronicle_${resolutionId}`;

// ---------------------------------------------------------------------------
// Chronicle-draft badging — the pure helper the Lead's committer wiring
// calls (brief §1.6/§2.6; the wiring SPEC is the step-11 prep report
// §4). The resolution path itself is Lead-owned: nothing in this file
// edits the resolver, dispatcher, or committer.
// ---------------------------------------------------------------------------

export interface ChronicleDraftMaterial {
  /** The resolution whose narrative output this draft carries. */
  resolutionId: string;
  cityId: string;
  title: string;
  body: string;
  /** Rules whose outcome produced the narrative material (§2.6). */
  sourceRuleIds: string[];
}

/**
 * The `drafts` doc for a resolution's chronicle output: the existing
 * post-draft shape (lib/firestore/posts.ts) plus the `sim` badge and
 * its provenance. Fabric-only fields (`badge`, `canonLayer`,
 * `source*`) are fenced against client writes by the Lead's rules
 * amendment (prep report §4) so a member cannot forge a sim-badged
 * draft from the browser — an unbadged draft is just a post draft and
 * publishes through the ordinary social flow, never through R-11.
 * Timestamps are null placeholders: the committer stamps them inside
 * its transaction, exactly as it stamps every plan-produced record.
 */
export function buildChronicleDraftDoc(
  material: ChronicleDraftMaterial
): Record<string, unknown> {
  return {
    type: "lore",
    factionId: material.cityId,
    characterId: "",
    title: material.title,
    body: material.body,
    images: [],
    media: [],
    poll: null,
    pinned: false,
    mentions: { factions: [], characters: [], posts: [] },
    cityIds: [material.cityId],
    referencedPostIds: [],
    authorUid: "",
    authorType: "sim",
    status: "draft",
    publishAt: null,
    settlementYear: null,
    era: null,
    contentWarning: null,
    spoiler: false,
    searchTokens: searchTokensFrom({
      title: `${material.title} lore`,
      body: material.body,
    }),
    badge: CHRONICLE_BADGE,
    canonLayer: "sim",
    source: "sim-chronicle",
    sourceResolutionId: material.resolutionId,
    sourceCityId: material.cityId,
    sourceRuleIds: [...material.sourceRuleIds],
    createdAt: null,
    updatedAt: null,
  };
}

/** True only for a committer-badged sim chronicle draft — the one
 * draft family `adopt_chronicle_draft` may consume. */
export function isSimChronicleDraft(
  doc: Record<string, unknown> | null
): boolean {
  return (
    !!doc &&
    doc.badge === CHRONICLE_BADGE &&
    doc.source === "sim-chronicle" &&
    typeof doc.sourceResolutionId === "string"
  );
}

// ---------------------------------------------------------------------------
// Small shared helpers (local copies — see header note)
// ---------------------------------------------------------------------------

const sa = (action: SimAction): Record<string, unknown> =>
  (action.structuredAction ?? {}) as Record<string, unknown>;

const actionCityId = (action: SimAction): string =>
  (sa(action).cityId as string | undefined) ?? action.targetCityIds[0] ?? "";

const str = (doc: Record<string, unknown> | null, field: string): string | null => {
  const value = docField(doc, field);
  return typeof value === "string" && value.length > 0 ? value : null;
};

const num = (doc: Record<string, unknown> | null, field: string): number | null => {
  const value = docField(doc, field);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const strList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];

function actorCitations(
  plan: ResolutionPlan,
  citations: SimCitations,
  resolutionId: string
): void {
  for (const id of citations.resolutionIds ?? []) plan.readRefKeys.push(`resolution:${id}`);
  for (const id of citations.pendingIds ?? []) plan.readRefKeys.push(`pending:${id}`);
  for (const path of citations.recordPaths ?? []) plan.readRefKeys.push(`record:${path}`);
  for (const seq of citations.seqs ?? []) plan.readRefKeys.push(`seq:${seq}`);
  plan.readRefKeys.push(`resolution:${resolutionId}`);
}

function pruneRecordClaims(plan: ResolutionPlan): void {
  const ops = new Map(plan.writes.map((w) => [w.path, w.op]));
  for (const entry of plan.entries) {
    const created = new Set<string>();
    const updated = new Set<string>();
    for (const path of [...entry.recordsCreated, ...entry.recordsUpdated]) {
      const op = ops.get(path);
      if (op === "create") created.add(path);
      else if (op !== undefined) updated.add(path);
    }
    entry.recordsCreated = [...created];
    entry.recordsUpdated = [...updated];
  }
}

function queryDocs(
  snapshot: SimSnapshot,
  queryId: string,
  collectionPath: string
): Map<string, Record<string, unknown> | null> | null {
  const record = snapshot.queries.find(
    (q) => q.spec.id === queryId && q.spec.collectionPath === collectionPath
  );
  if (!record) return null;
  const docs = new Map<string, Record<string, unknown> | null>();
  for (const path of record.resultPaths) docs.set(path, snapshotDoc(snapshot, path));
  return docs;
}

// ---------------------------------------------------------------------------
// The adoption authority posture (D-2). Two gates, in order:
//  1. WHO may adopt at all — a member actor personally, or a
//     shared-office mayor actor for the shared city. NPC/system
//     actors are refused here, structurally (never-bind), before any
//     ownership read: their `onBehalfOfMemberId` is never consulted.
//  2. OWNERSHIP of the subject city — the faction's ownerUids for a
//     member actor (skipped for the mayor-office path: the office IS
//     the authority for the shared city, per the landed posture).
// ---------------------------------------------------------------------------

type AdoptionActor =
  | { ok: true; uid: string; viaOffice: boolean }
  | { ok: false; plan: ResolutionPlan };

function adoptionActor(
  ctx: HandlerContext,
  subjectCityId: string
): AdoptionActor {
  const actor = ctx.action.actor;
  if (actor.type === "shared-office") {
    const city = snapshotDoc(ctx.snapshot, `sim_cities/${subjectCityId}`);
    if (actor.office === "mayor" && actor.memberId && city?.isSharedCity === true) {
      return { ok: true, uid: actor.memberId, viaOffice: true };
    }
    return {
      ok: false,
      plan: rejectedPlan(
        "R-11",
        "CANON_ADOPTION_OWNER_ONLY",
        ["R-11"],
        `A shared-office actor may adopt lore only as the sitting mayor of the shared city itself (CJ round 3); this actor/office does not qualify for ${subjectCityId}.`
      ),
    };
  }
  if (actor.type !== "member" || !actor.memberId) {
    return {
      ok: false,
      plan: rejectedPlan(
        "R-11",
        "CANON_ADOPTION_OWNER_ONLY",
        ["R-11"],
        `Adoption is the city owner's personal act (TC-C02/TC-N06): a ${actor.type} actor cannot adopt lore. Drafts produced by NPCs or the fabric wait for the owner's own adoption — they never self-adopt, and no delegation carries canon authority.`
      ),
    };
  }
  return { ok: true, uid: actor.memberId, viaOffice: false };
}

function requireSubjectOwnership(
  ctx: HandlerContext,
  subjectCityId: string,
  actor: { uid: string; viaOffice: boolean }
): ResolutionPlan | null {
  if (actor.viaOffice) return null;
  const faction = snapshotDoc(ctx.snapshot, `factions/${subjectCityId}`);
  if (!faction) {
    return rejectedPlan(
      "R-11",
      "AUTHORITY_REVOKED",
      ["R-11"],
      `No faction record for ${subjectCityId}.`
    );
  }
  const owners = faction.ownerUids;
  if (!Array.isArray(owners) || !owners.includes(actor.uid)) {
    return rejectedPlan(
      "R-11",
      "AUTHORITY_REVOKED",
      ["R-11"],
      `${actor.uid} is not an owner of ${subjectCityId}: adoption is the subject city's owner's act and no cross-city adoption path exists (brief §4.5).`
    );
  }
  return null;
}

/** The action must target the draft's own recorded city — this both
 * keeps intake honest and guarantees the base read derivation covered
 * the subject city's faction + sim docs the authority gates read. */
function requireActionTargetsSubject(
  ctx: HandlerContext,
  subjectCityId: string
): ResolutionPlan | null {
  const named = actionCityId(ctx.action);
  if (!named || named !== subjectCityId) {
    return rejectedPlan(
      "R-11",
      "DRAFT_TARGET_MISMATCH",
      ["R-11"],
      `The action targets ${named || "(no city)"} but the draft belongs to ${subjectCityId}. Adoption acts on the draft's own city, as recorded — never on an actor-nominated substitute.`
    );
  }
  return null;
}

function chosenCanonLayer(
  ctx: HandlerContext,
  draftLayer: unknown
): CanonLayer | ResolutionPlan {
  const requested = sa(ctx.action).canonLayer;
  const candidate =
    typeof requested === "string"
      ? requested
      : typeof draftLayer === "string"
        ? draftLayer
        : null;
  if (candidate === "sim") {
    return rejectedPlan(
      "R-11",
      "INVALID_CANON_LAYER",
      ["R-11"],
      `"sim" is the draft badge, not a canon layer: adoption chooses realm, deep, or current. A sim-badged draft becomes canon only by being adopted INTO a canon layer.`
    );
  }
  if (candidate === null) {
    return rejectedPlan(
      "R-11",
      "CANON_LAYER_REQUIRED",
      ["R-11"],
      "Adoption must choose a canon layer (realm / deep / current): neither the action nor the draft names one."
    );
  }
  if (!(CANON_LAYERS as readonly string[]).includes(candidate)) {
    return rejectedPlan(
      "R-11",
      "INVALID_CANON_LAYER",
      ["R-11"],
      `Canon layer "${candidate}" is not one of realm / deep / current.`
    );
  }
  return candidate as CanonLayer;
}

// ---------------------------------------------------------------------------
// adopt_lore_draft — Dana §3.9's adoption commit, with the retcon
// branch (D-3).
// ---------------------------------------------------------------------------

function adoptWikiDraftHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "R-11";
  const params = sa(ctx.action);

  const draftId = typeof params.draftId === "string" ? params.draftId : null;
  if (!draftId) {
    return rejectedPlan(descriptorId, "INVALID_ACTION", ["R-11"], "The action names no draftId.");
  }
  const draft = snapshotDoc(ctx.snapshot, wikiDraftPath(draftId));
  if (!draft) {
    return rejectedPlan(
      descriptorId,
      "DRAFT_NOT_FOUND",
      ["R-11"],
      `No wiki entry draft ${draftId} exists. Adoption consumes drafts that exist — it invents none.`
    );
  }
  const subjectCityId = str(draft, "targetCityId");
  const proposedTitle = str(draft, "proposedTitle");
  const proposedSlug = str(draft, "proposedSlug");
  const proposedKind = str(draft, "proposedKind");
  if (!subjectCityId || !proposedTitle || !proposedSlug || !proposedKind) {
    return rejectedPlan(
      descriptorId,
      "DRAFT_MALFORMED",
      ["R-11"],
      `Draft ${draftId} lacks the recorded subject city or proposed content (targetCityId / proposedTitle / proposedSlug / proposedKind) — it is not an adoptable draft.`
    );
  }
  const targetMismatch = requireActionTargetsSubject(ctx, subjectCityId);
  if (targetMismatch) return targetMismatch;

  const actor = adoptionActor(ctx, subjectCityId);
  if (!actor.ok) return actor.plan;
  const denied = requireSubjectOwnership(ctx, subjectCityId, actor);
  if (denied) return denied;

  const status = str(draft, "status");
  if (status !== "pending" && status !== "adoption_requested") {
    return rejectedPlan(
      descriptorId,
      "DRAFT_NOT_ADOPTABLE",
      ["R-11"],
      `Draft ${draftId} has status ${status ?? "(unset)"} — only a pending draft can be adopted. An adopted, rejected, or superseded draft is history, not a pending decision.`
    );
  }

  // The existing entry (for a "changed"/retcon draft): found by the
  // draft's own recorded entry id — via the action-named doc read when
  // present, else the subject city's entries query. A disagreement
  // between the action and the draft about which entry is targeted
  // refuses: the record governs, never the nomination.
  const existingEntryId = str(draft, "existingWikiEntryId");
  let entry: Record<string, unknown> | null = null;
  if (existingEntryId) {
    if (typeof params.wikiEntryId === "string" && params.wikiEntryId !== existingEntryId) {
      return rejectedPlan(
        descriptorId,
        "DRAFT_TARGET_MISMATCH",
        ["R-11"],
        `The action names entry ${params.wikiEntryId} but draft ${draftId} targets entry ${existingEntryId}. The draft's recorded target governs.`
      );
    }
    entry = snapshotDoc(ctx.snapshot, wikiEntryPath(existingEntryId));
    if (!entry) {
      const byCity = queryDocs(ctx.snapshot, WIKI_ENTRIES_QUERY_ID, "wiki_entries");
      if (byCity) entry = byCity.get(wikiEntryPath(existingEntryId)) ?? null;
    }
    if (!entry) {
      return rejectedPlan(
        descriptorId,
        "ENTRY_NOT_FOUND",
        ["R-11"],
        `Draft ${draftId} proposes a new version of entry ${existingEntryId}, which does not exist. A changed-entry draft against a missing entry adopts nothing.`
      );
    }
  } else if (typeof params.wikiEntryId === "string") {
    return rejectedPlan(
      descriptorId,
      "DRAFT_TARGET_MISMATCH",
      ["R-11"],
      `Draft ${draftId} proposes a brand-new entry but the action names existing entry ${params.wikiEntryId}. The draft's recorded target governs.`
    );
  }

  const layer = chosenCanonLayer(ctx, draft.proposedCanonLayer);
  if (typeof layer !== "string") return layer;

  const entryId = existingEntryId ?? wikiEntryIdForDraft(draftId);
  const currentVersion = entry ? num(entry, "currentVersion") : null;
  const baseWikiVersion = num(draft, "baseWikiVersion");
  const changeType = str(draft, "changeType");

  // ---- The retcon branch (D-3): contradiction surfaces as a
  // proposal; canon is never overwritten to resolve it. -------------
  const contradicted =
    changeType === "retcon_conflict" ||
    (entry !== null && baseWikiVersion !== null && currentVersion !== null && baseWikiVersion !== currentVersion);
  if (contradicted) {
    const p = emptyPlan(descriptorId);
    const effect = ruleEffectDraft({
        actor: ctx.action.actor,
        actionId: ctx.action.actionId,
        actionText: ctx.action.actionText,
        cityId: null,
        cityIds: [subjectCityId],
        ruleIds: ["R-11"],
        changes: [
          fieldChange(
            `wikiEntryDrafts/${draftId}.retconProposal`,
            null,
            "open",
            "R-11 (Dana §3.9): a draft contradicting adopted canon surfaces as a retcon proposal — current canon is never overwritten to resolve a conflict"
          ),
        ],
        recordsUpdated: [wikiDraftPath(draftId)],
        summaryText:
          `Retcon proposal surfaced for draft ${draftId} ("${proposedTitle}"): it contradicts adopted canon` +
          (entry
            ? ` (entry ${entryId} stands at version ${currentVersion ?? "?"}; the draft was based on version ${baseWikiVersion ?? "?"})`
            : "") +
          `. Nothing was adopted; no canon record changed.`,
      });
      const summary = summaryDraft({
        actor: ctx.action.actor,
        actionId: ctx.action.actionId,
        actionText: ctx.action.actionText,
        classification: { verb: "adopt-lore", scope: "city", ruleIds: ["R-11"], unruled: false },
        cityId: subjectCityId,
        cityIds: [subjectCityId],
        ruleIds: ["R-11"],
        summaryText:
          `Retcon proposed in ${subjectCityId}: draft ${draftId} ("${proposedTitle}") contradicts adopted canon, so it was NOT adopted. ` +
          `The proposal is recorded on the draft and waits for the owner's decision (adopt the retcon, keep the standing canon, or keep both as layer-specific accounts). Canon is unchanged.`,
      });
      p.entries.push(effect, summary);
      const summarySeq = ctx.snapshot.counterHead.lastSeq + p.entries.length;
      const draftAfter: Record<string, unknown> = {
        ...draft,
        retconProposal: {
          status: "open",
          proposedByUid: actor.uid,
          proposedAtSeq: summarySeq,
          surfacedByResolutionId: ctx.resolutionId,
          againstEntryId: existingEntryId,
          againstVersion: currentVersion,
          baseWikiVersion,
          changeType,
          note: typeof params.note === "string" ? params.note : null,
        },
      };
      planWrite(p, ctx.snapshot, wikiDraftPath(draftId), draftAfter, "state", ["retconProposal"]);
      pruneRecordClaims(p);
      actorCitations(p, ctx.citations, ctx.resolutionId);
      return p;
  }

  // ---- The adoption commit (Dana §3.9). ---------------------------
  const plan = emptyPlan(descriptorId);
  const newVersion = (currentVersion ?? 0) + 1;
  const previousVersion = currentVersion;
  const citySlug = str(draft, "targetCitySlug") ?? str(entry, "citySlug");
  const content = {
    cityId: subjectCityId,
    citySlug,
    kind: proposedKind,
    title: proposedTitle,
    slug: proposedSlug,
    summary: str(draft, "proposedSummary") ?? "",
    body: str(draft, "proposedBody") ?? "",
    stats: (draft.proposedStats as Record<string, unknown> | null) ?? null,
  };
  const contentHash = sha256Hex(content);
  const authorType =
    changeType === "sim_chronicle" ? "chronicle" : changeType === "manual_edit" ? "owner" : "ingestion";
  const crossCityIds = [...new Set(strList(draft.crossCityIds))].filter(
    (id) => id !== subjectCityId
  );

  const effectChanges: LogEntryDraft["changes"] = [
    fieldChange(
      `wikiEntryDrafts/${draftId}.status`,
      status,
      "adopted",
      "R-11 adoption commit (Dana §3.9): the owner's adoption is the commit"
    ),
    fieldChange(
      `wikiEntries/${entryId}.currentVersion`,
      currentVersion,
      newVersion,
      "R-11: adoption advances the entry's current version pointer; prior version docs are immutable history"
    ),
    fieldChange(
      `wikiEntries/${entryId}.canonLayer`,
      entry ? str(entry, "canonLayer") : null,
      layer,
      "R-11: the canon layer chosen at adoption (spec §3)"
    ),
    fieldChange(
      `wikiEntries/${entryId}/versions/${newVersion}.version`,
      null,
      newVersion,
      "R-11: the immutable version snapshot the adoption creates"
    ),
  ];
  const effect = ruleEffectDraft({
    actor: ctx.action.actor,
    actionId: ctx.action.actionId,
    actionText: ctx.action.actionText,
    cityId: null,
    cityIds: [subjectCityId, ...crossCityIds],
    ruleIds: ["R-11"],
    changes: effectChanges,
    recordsCreated: [wikiVersionPath(entryId, newVersion)],
    recordsUpdated: [wikiDraftPath(draftId), wikiEntryPath(entryId)],
    summaryText:
      `Adopted draft ${draftId} ("${proposedTitle}") into ${subjectCityId}'s canon as entry ${entryId} version ${newVersion}, layer ${layer}. ` +
      `Provenance: adopted by ${actor.uid} under R-11; content hash ${contentHash.slice(0, 12)}…`,
  });
  plan.entries.push(effect);

  for (const otherCityId of crossCityIds) {
    plan.entries.push(
      ruleEffectDraft({
        actor: ctx.action.actor,
        actionId: ctx.action.actionId,
        actionText: ctx.action.actionText,
        cityId: otherCityId,
        cityIds: [otherCityId],
        ruleIds: ["R-11"],
        changes: [
          fieldChange(
            `lore_cross_refs/${entryId}.entryId`,
            null,
            entryId,
            "R-11 spillover: lore naming another city creates a cross-reference record on that city — visible, labeled, no canon copied"
          ),
        ],
        recordsCreated: [loreCrossRefPath(otherCityId, entryId)],
        summaryText:
          `Cross-reference: ${subjectCityId}'s adopted lore "${proposedTitle}" names ${otherCityId}. ` +
          `A labeled reference now stands on ${otherCityId}; it copies no canon, and ${otherCityId}'s owner may remove it by a logged action.`,
      })
    );
  }

  plan.entries.push(
    summaryDraft({
      actor: ctx.action.actor,
      actionId: ctx.action.actionId,
      actionText: ctx.action.actionText,
      classification: { verb: "adopt-lore", scope: "city", ruleIds: ["R-11"], unruled: false },
      cityId: subjectCityId,
      cityIds: [subjectCityId, ...crossCityIds],
      ruleIds: ["R-11"],
      major: true,
      summaryText:
        `${actor.uid} adopted "${proposedTitle}" into ${subjectCityId}'s canon (entry ${entryId}, version ${newVersion}, layer ${layer}) under R-11. ` +
        `The draft is adopted, the version snapshot is immutable, and loreRichness rises by derivation — no index was written.`,
    })
  );

  const summarySeq = ctx.snapshot.counterHead.lastSeq + plan.entries.length;
  const provenanceLabel = `adopted draft ${draftId} · ${layer} · seq ${summarySeq}`;

  const versionDoc: Record<string, unknown> = {
    ...content,
    version: newVersion,
    canonLayer: layer,
    canonStatus: "canon",
    sourceDraftId: draftId,
    sourceCitations: Array.isArray(draft.sourceCitations) ? draft.sourceCitations : [],
    authorType,
    adoptedByUid: actor.uid,
    adoptedAt: null, // committer-stamped clock (plans are clock-free)
    adoptedSeq: summarySeq,
    previousVersion,
    contentHash,
    rollbackOfVersion: null,
  };
  planWrite(plan, ctx.snapshot, wikiVersionPath(entryId, newVersion), versionDoc, "state", [
    "version",
    "canonLayer",
    "canonStatus",
    "contentHash",
  ]);

  const entryAfter: Record<string, unknown> = {
    ...(entry ?? {}),
    ...content,
    searchTokens: searchTokensFrom({
      title: `${proposedTitle} ${proposedSlug} ${proposedKind}`,
      body: `${content.summary} ${content.body}`,
    }),
    currentVersion: newVersion,
    versioned: true,
    canonLayer: layer,
    canonStatus: "canon",
    adoptedByUid: actor.uid,
    adoptedAtSeq: summarySeq,
    provenanceSummary: [...strList(entry?.provenanceSummary), provenanceLabel],
    contentHash,
    updatedAt: null, // committer-stamped
    ...(entry ? {} : { createdAt: null }), // committer-stamped on create
  };
  planWrite(plan, ctx.snapshot, wikiEntryPath(entryId), entryAfter, "state", [
    "kind",
    "title",
    "slug",
    "summary",
    "body",
    "stats",
    "searchTokens",
    "currentVersion",
    "versioned",
    "canonLayer",
    "canonStatus",
    "adoptedByUid",
    "adoptedAtSeq",
    "provenanceSummary",
    "contentHash",
  ]);

  const draftAfter: Record<string, unknown> = {
    ...draft,
    status: "adopted",
    decision: {
      byUid: actor.uid,
      atSeq: summarySeq,
      at: null, // committer-stamped clock
      note: typeof params.note === "string" ? params.note : null,
      resolutionId: ctx.resolutionId,
    },
    resultWikiEntryId: entryId,
    resultWikiVersion: newVersion,
  };
  planWrite(plan, ctx.snapshot, wikiDraftPath(draftId), draftAfter, "state", [
    "status",
    "decision",
    "resultWikiEntryId",
    "resultWikiVersion",
  ]);

  for (const otherCityId of crossCityIds) {
    planWrite(
      plan,
      ctx.snapshot,
      loreCrossRefPath(otherCityId, entryId),
      {
        entryId,
        sourceCityId: subjectCityId,
        canonLayer: layer,
        title: proposedTitle,
        adoptedByUid: actor.uid,
        sourceDraftId: draftId,
        adoptedAtSeq: summarySeq,
        removableByOwner: true,
        stateVersion: 1,
        lastChangedSeq: null, // committer-stamped
        lastResolutionId: null, // committer-stamped
      },
      "state",
      ["entryId", "sourceCityId", "canonLayer", "adoptedAtSeq"]
    );
  }

  pruneRecordClaims(plan);
  actorCitations(plan, ctx.citations, ctx.resolutionId);
  return plan;
}

// ---------------------------------------------------------------------------
// adopt_chronicle_draft — a sim-badged chronicle draft publishes as a
// canon post, with provenance; the draft is consumed.
// ---------------------------------------------------------------------------

function adoptChronicleDraftHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "R-11";
  const params = sa(ctx.action);

  const draftId = typeof params.draftId === "string" ? params.draftId : null;
  if (!draftId) {
    return rejectedPlan(descriptorId, "INVALID_ACTION", ["R-11"], "The action names no draftId.");
  }
  const draft = snapshotDoc(ctx.snapshot, chronicleDraftPath(draftId));
  if (!draft) {
    return rejectedPlan(
      descriptorId,
      "DRAFT_NOT_FOUND",
      ["R-11"],
      `No draft ${draftId} exists. Adoption consumes drafts that exist — it invents none.`
    );
  }
  if (!isSimChronicleDraft(draft)) {
    return rejectedPlan(
      descriptorId,
      "NOT_CHRONICLE_DRAFT",
      ["R-11"],
      `Draft ${draftId} is not a sim-badged chronicle draft. Ordinary post drafts publish through the social flow; R-11 adoption is only for resolution-produced chronicle drafts (brief §1.6/§2.6).`
    );
  }
  const subjectCityId = str(draft, "factionId");
  if (!subjectCityId) {
    return rejectedPlan(
      descriptorId,
      "DRAFT_MALFORMED",
      ["R-11"],
      `Chronicle draft ${draftId} names no subject city (factionId) — it is not adoptable.`
    );
  }
  const targetMismatch = requireActionTargetsSubject(ctx, subjectCityId);
  if (targetMismatch) return targetMismatch;

  const actor = adoptionActor(ctx, subjectCityId);
  if (!actor.ok) return actor.plan;
  const denied = requireSubjectOwnership(ctx, subjectCityId, actor);
  if (denied) return denied;

  // The draft's own canonLayer field carries the "sim" BADGE, not a
  // layer proposal — adoption defaults to `current` unless the
  // owner's action names a canon layer explicitly.
  const layer = chosenCanonLayer(ctx, "current");
  if (typeof layer !== "string") return layer;

  const title = str(draft, "title") ?? draftId;
  const plan = emptyPlan(descriptorId);
  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      actionId: ctx.action.actionId,
      actionText: ctx.action.actionText,
      cityId: null,
      cityIds: [subjectCityId],
      ruleIds: ["R-11"],
      changes: [
        fieldChange(
          `posts/${draftId}.status`,
          "draft",
          "published",
          "R-11: the owner's adoption publishes the chronicle draft as canon"
        ),
        fieldChange(
          `posts/${draftId}.canonLayer`,
          "sim",
          layer,
          "R-11: the sim badge is replaced by the canon layer chosen at adoption"
        ),
        fieldChange(
          `drafts/${draftId}.status`,
          "draft",
          null,
          "R-11: the chronicle draft is consumed by its adoption — the published post carries the provenance chain"
        ),
      ],
      recordsCreated: [postPath(draftId)],
      summaryText:
        `Chronicle draft ${draftId} ("${title}") adopted into ${subjectCityId}'s canon at layer ${layer}. ` +
        `Source resolution: ${str(draft, "sourceResolutionId") ?? "?"}. Provenance: adopted by ${actor.uid} under R-11.`,
    }),
    summaryDraft({
      actor: ctx.action.actor,
      actionId: ctx.action.actionId,
      actionText: ctx.action.actionText,
      classification: { verb: "adopt-chronicle", scope: "city", ruleIds: ["R-11"], unruled: false },
      cityId: subjectCityId,
      cityIds: [subjectCityId],
      ruleIds: ["R-11"],
      major: true,
      summaryText:
        `${actor.uid} adopted the chronicle draft "${title}" into ${subjectCityId}'s canon (layer ${layer}) under R-11. ` +
        `The telling is now canon; the Log remains the record it was told from.`,
    })
  );

  const summarySeq = ctx.snapshot.counterHead.lastSeq + plan.entries.length;
  const postAfter: Record<string, unknown> = { ...draft };
  delete postAfter.badge;
  postAfter.status = "published";
  postAfter.canonLayer = layer;
  postAfter.canonStatus = "canon";
  postAfter.adoptedByUid = actor.uid;
  postAfter.adoptedAtSeq = summarySeq;
  postAfter.sourceChronicleDraftId = draftId;
  postAfter.publishedViaRule = "R-11";
  postAfter.updatedAt = null; // committer-stamped
  planWrite(plan, ctx.snapshot, postPath(draftId), postAfter, "state", [
    "status",
    "canonLayer",
    "canonStatus",
    "adoptedByUid",
    "adoptedAtSeq",
  ]);
  planWrite(plan, ctx.snapshot, chronicleDraftPath(draftId), null, "state", ["status"]);

  pruneRecordClaims(plan);
  actorCitations(plan, ctx.citations, ctx.resolutionId);
  return plan;
}

// ---------------------------------------------------------------------------
// Read plans (F-01): resolver-side reads only. The wiki adoption reads
// the draft (action-named id — a READ nomination; every authority and
// integrity fact is then checked against the stored record), the
// action-named entry doc when intake names it, and the subject city's
// wiki entries as a query (the draft's recorded target is found among
// them). The chronicle adoption reads the draft doc.
// ---------------------------------------------------------------------------

function wikiAdoptionReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const params = sa(seeds.action);
  const paths: string[] = [];
  if (typeof params.draftId === "string") paths.push(wikiDraftPath(params.draftId));
  if (typeof params.wikiEntryId === "string") paths.push(wikiEntryPath(params.wikiEntryId));
  const cityId = actionCityId(seeds.action);
  const queries: CollectionQuerySpec[] = cityId
    ? [
        {
          id: WIKI_ENTRIES_QUERY_ID,
          collectionPath: "wiki_entries",
          filters: [{ field: "cityId", op: "==", value: cityId }],
        },
      ]
    : [];
  return { paths, queries };
}

function chronicleAdoptionReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const params = sa(seeds.action);
  const paths: string[] = [];
  if (typeof params.draftId === "string") paths.push(chronicleDraftPath(params.draftId));
  return { paths };
}

// ---------------------------------------------------------------------------
// Descriptors — registered by the Build Lead's single assembly edit.
// ---------------------------------------------------------------------------

export const LORE_DESCRIPTORS: Record<string, RuleDescriptor> = {
  "R-11": {
    id: "R-11",
    actionKinds: ["adopt_lore_draft", "adopt_chronicle_draft"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: {
      adopt_lore_draft: adoptWikiDraftHandler,
      adopt_chronicle_draft: adoptChronicleDraftHandler,
    },
    readPlan: (seeds) => {
      const wiki = wikiAdoptionReadPlan(seeds);
      const chronicle = chronicleAdoptionReadPlan(seeds);
      return {
        paths: [...(wiki.paths ?? []), ...(chronicle.paths ?? [])],
        queries: wiki.queries ?? [],
      };
    },
    finance: { shortfallClass: "none", ledgersTouched: [], invokesRules: [] },
    summary:
      "Publish and adopt lore (the lore-forward rule): adoption is the subject city's owner's personal Resolution Event — wiki-entry drafts commit under Dana §3.9 (immutable version snapshot + current pointer + provenance), sim-badged chronicle drafts publish as canon posts, contradictions surface as retcon proposals and never overwrite canon, cross-city mentions create labeled cross-reference records, and loreRichness rises only by derivation. NPC/fabric drafts never self-adopt.",
  },
};
