# Phase 4 Step 11 — Lore hook + chronicle + exports: prep report (Wren)

**Worker:** Wren (Muse Eng), World & Experience.
**Branch:** `p4/lore-chronicle-exports` in `p4-lore-clone`, base `63a1445`
(tree == master `b5eb611` at dispatch: Finance + Catalogue I + Defensive +
Chains + Catalogue II landed; registry at 44 descriptors). Market
(step 7) and Acquisition (step 9) assemblies land on master in parallel;
this module reads their committed record shapes for export completeness
but bases no code on their branches.
**Status:** IN PROGRESS — sections appended as the build lands.

## 0. What step 11 is (Dana's worker table, brief §17 item 11)

- The **R-11 adoption handler** family in a NEW file
  `lib/sim/rules/lore.ts` (family rule: new file; the Lead registers).
- **Chronicle-draft badging** in the resolution path — SPEC ONLY here
  (§4 below); the resolver/committer edits are Lead-owned assembly.
  A pure badging helper the Lead will call ships in `lore.ts`.
- **Phase 4 export tabs** as `lib/export/**` ADDITIONS ONLY, extending
  the landed Phase 3 machinery (SheetSpec builders + as-requester
  fetch), never forking it.

Gate rows owned: **P4-G11** (exports + trust cross-bound, TC-X),
**P4-G4-C3 / TC-C02** (chronicle drafts are drafts; adoption is the
owner's logged act; canon provenance on every adopted record).

## 1. Grounding read (all on the base or in workstreams/)

- Brief §1.6 (chronicle drafts → the existing `drafts` collection,
  `sim` badge as a field; no new collection; no auto-publish),
  §2.6 (chronicle draft alongside Log entries; the Log is the record,
  the chronicle is the telling), §4.5 (R-11 = the adoption commit
  path; ingestion pipeline is Phase 6; sovereignty absolute),
  §10 (Phase 4 export tabs), §12 (drafts posture row).
- Systems-spec v2 R-11: publish + adopt are two logged steps; no index
  changes; `loreRichness` is DERIVED (§2.2:
  `min(100, 4·adoptedEntries + 2·profiledCanonStructures +
  1·profiledNamedCitizens)`) and rises by computation only; adopted
  lore establishing tracked facts creates/updates those records in the
  same event flagged `source: lore <entry id>`; lore naming another
  city creates a cross-reference record on that city (visible,
  labeled, owner-removable).
- Dana backend §3.9: the `sim_wiki_entry_drafts` shape, the
  `wiki_entries` version/provenance additions, the
  `wiki_entries/{id}/versions/{n}` immutable snapshot, and the
  adoption commit (one transaction: version doc + current pointer +
  draft marked adopted + Log). `changeType: "retcon_conflict"` drafts
  NEVER overwrite current content to "resolve" them — under any
  policy, conflicts wait for the owner.
- QA: TC-C02 (every canon record carries provenance: `source` +
  adoption record with `adoptedBy` = the city's owner, `adoptedAt`,
  link to the proposal/Log entry), TC-C04 (proposals are inert —
  never expire into adoption), TC-N06 (NPCs never write canon;
  adoption is the owner's logged confirmation), TC-X01/X05/X09/X12
  (export = exactly the actor-visible set; intel directionality;
  own-data completeness).
- Landed code: the family-file idiom (defensive.ts — local helper
  copies, no registry import cycle), planHelpers F-02 folding,
  resolver `validatePlan` (incl. the §5.6 narrative-output guard and
  the F-02 reconciliation, which reconciles only city-scoped entries —
  off-city records ride `cityId: null` entries in the finance change
  grammar), `collectActionReadPaths` base derivation, allocation's
  `commitSeq = counterHead.lastSeq + entries.length` derivation.
- Export machinery: `sheetSpec.ts` (SheetSpec, provenance block,
  assembleWorkbook caps, Cover legend verbatim), `datasets/cityData.ts`
  + `datasets/cityWorkbook.ts` (pure builders; Published Claims always
  its own tab), `fetchCityExport.ts` (as-requester reads, fail-closed,
  `assertExportAllowed` guest fence), `download.ts` runners.
- Record shapes read for exports: Finance `lib/finance/accounts.ts`
  (`sim_member_accounts/{uid}`, `cashRubars`); Cato's committed
  `lib/sim/marketRecords.ts` in p4-market-clone (`sim_market_listings`,
  `sim_holdings/{memberId}__{corporationId}`, `sim_market_orders`,
  `sim_market_trades` — FINAL shapes); Ines's committed
  `buildIntelRecord` in p4-acq-clone (`sim_intel_records` delivery
  shape: collectorUid, targetCityId, method.methodRef, coverage,
  reliability band/axes, findings, nullReasons).

## 2. Design decisions (this module's readings — flagged, not flipped)

D-1 **Two adoption kinds under one R-11 descriptor.**
`adopt_lore_draft` (a `sim_wiki_entry_drafts` draft — Dana's adoption
commit) and `adopt_chronicle_draft` (a `drafts` post-draft badged
`sim` — publishes as a canon post with provenance, draft consumed).
Rationale: brief §4.5 names both draft families as R-11's Phase 4
inputs ("chronicle drafts, manually authored drafts" — manual
authoring arrives as `changeType: "manual_edit"` wiki drafts under
Dana's shape). The publish half of R-11 (draft creation) is NOT a
Phase 4 action kind: drafts are produced by resolutions (chronicle),
by the Phase 6 pipeline (wiki), or by hand (manual_edit drafts) —
exactly as the brief scopes it ("R-11 lands as the adoption commit
path").

D-2 **Adoption is structurally owner-only.** Beyond the landed
authority check (faction `ownerUids`; shared-city = shared-office
mayor actor, allocation/defensive posture), lore.ts refuses
`actor.type !== "member"` (and non-mayor shared-office) with
`CANON_ADOPTION_OWNER_ONLY` BEFORE the authority read: an NPC actor
carries its owner's uid in `onBehalfOfMemberId`, which
`checkCityAuthority` honors for ordinary acts — for canon that is the
TC-N04/N06 never-bind hole, so adoption never reads it. An NPC's lore
output is a draft, forever, until the owner personally adopts it.

D-3 **Contradiction ⇒ retcon proposal, never an overwrite.** A draft
is in contradiction when `changeType === "retcon_conflict"` OR its
`baseWikiVersion` no longer equals the entry's `currentVersion`
(canon moved under it — discovered at adoption time, the case Dana's
§3.9 step 5 guards at generation). The resolution then writes ONLY a
`retconProposal` block onto the draft (status stays `pending` —
Dana's status enum has no proposal state; the block is the proposal
record: proposer, against-entry, against-version, base version,
changeType, note, resolution id, seq) and logs the surfacing. The
entry, its versions, and every canon surface stay byte-identical
(TC-C04 inertness). Deciding the retcon (adopt / keep old / keep
both) is a later owner act — Phase 6 Situations machinery; this
module surfaces, it does not decide.

D-4 **Deterministic ids.** New wiki entry id = `wiki_<draftId>`
(Dana: "preallocated ID" — the resolver is replay-deterministic, so
the id is a pure function of the draft); version path
`wiki_entries/{entryId}/versions/{n}`; chronicle draft id =
`chronicle_<resolutionId>` (badging helper, §4). No clocks, no
randomness anywhere in the module: seq-bearing fields derive from
`counterHead.lastSeq + entries.length` (allocation's commitSeq
convention — the summary entry's own seq), timestamps are null
placeholders the committer stamps.

D-5 **Tracked-fact establishment is NOT in Phase 4's handler.** R-11's
"records created/updated flagged `source: lore <entry id>`" applies
to facts the adopted lore establishes in engine-tracked forms. The
Phase 4 draft shape carries no fact-assertion language (Dana's
`proposedStats` is the wiki entry's own stats block, applied to the
entry + version docs at adoption — that IS landed here). Inventing a
fact grammar would be a fairness surface (actor-nominated record
creation) with no spec behind it; Phase 6's extraction populates
drafts, and any fact-record creation rides the draft's own reviewed
content. Flagged in §6.

D-6 **Cross-references land as records, per spec.** For each city in
the draft's `crossCityIds` (≠ subject city), adoption writes
`sim_cities/{cityId}/lore_cross_refs/{entryId}` (state record:
entryId, sourceCityId, canonLayer, title, adoptedByUid,
sourceDraftId, adoptedAtSeq, `removableByOwner: true`) and a
spillover Log entry on that city. Dana §3.9 calls cross-city mentions
"intertwining notices, not copies in their canon" — the record is
the notice's durable form (visible, labeled, removable by that owner
via a later logged action; the removal ACTION is not Phase 4 scope —
flagged in §6). It copies no content into the other city's canon.

D-7 **Exports assert against shipped surfaces only.** Phase 4 tabs:
(a) **Portfolio** — the REQUESTER's own member account, holdings,
resting orders (another member's portfolio is not fair for them to
see, so it is not fair for them to export — TC-X01/X09); the builder
itself refuses a bundle whose memberId ≠ requester uid (fail-closed
in the pure layer, not only in fetch). (b) **City ledger** — a city's
treasury ledger view (Log-derived: every `stats.treasuryRubars`
change with seq/actor/formula, brief §1.5) + action history
(`sim_actions` targeting the city). (c) **Survey results** — intel
records keyed `collectorUid == requester uid` ONLY (TC-X05
directionality: the target's export never contains the collector's
intel; there is deliberately NO city-scoped intel tab), with
coverage/reliability as first-class columns (limits exported, never
hidden). Contests do not exist as a shipped Phase 4 surface
(`sim_contests` is Phase 7) — no contest tab, per the
shipped-surfaces rule. Published Claims labeling is asserted in the
harness against the landed Phase 3 builder (§5).

(Sections 3–7 appended as the build lands.)
