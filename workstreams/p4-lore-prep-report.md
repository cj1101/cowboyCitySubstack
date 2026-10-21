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

## 3. Build record (2026-10-20)

Commits on `p4/lore-chronicle-exports` (Wren authorship, no push):

| Commit | Content |
|---|---|
| `cb54d30` | This prep report (§0–§2: grounding + decisions D-1–D-7). |
| `0b3580c` | `lib/sim/rules/lore.ts` — the R-11 family: `adopt_lore_draft` (Dana §3.9 commit + D-3 retcon branch), `adopt_chronicle_draft`, chronicle badging helpers (`buildChronicleDraftDoc`, `isSimChronicleDraft`, `chronicleDraftIdForResolution`, `wikiEntryIdForDraft`), `LORE_DESCRIPTORS` (unregistered — Lead assembly). |
| `5314b7a` | Export additions: `lib/export/datasets/phase4Data.ts`, `lib/export/datasets/phase4Workbook.ts` (Portfolio / City Ledger / Survey Results builders + pure-layer scope guards), `lib/export/fetchPhase4Export.ts` (as-requester fetch), `lib/export/phase4Workbook.ts` (three download runners in the Phase 3 idiom). |
| `96d0c88` | Harness-found fix: chronicle adoption's layer default — the draft's `canonLayer` field carries the `sim` badge, not a layer proposal; adoption defaults to `current` unless the action names a canon layer. |
| `1cd8384` | `tests/lore-harness.ts` — 20 checks. |
| `737866b` | README delta (step-11 narrative + dated changelog line). |

**Verification:** base `tsc --noEmit` clean before work; final tree `tsc --noEmit` clean; scoped ESLint clean on every touched file. Harness: **20/20 checks pass** — adoption battery (new-entry adoption with version-1 snapshot + provenance + cross-reference record; changed-entry adoption advancing 2→3 with `previousVersion`; retcon by flag AND by base-drift, entry byte-identical, draft still `pending` with an open proposal; non-owner `AUTHORITY_REVOKED`; NPC `CANON_ADOPTION_OWNER_ONLY`; already-adopted `DRAFT_NOT_ADOPTABLE`; wrong-city `DRAFT_TARGET_MISMATCH`; shared-city member refused / mayor adopts; chronicle adoption publishing the post with provenance and consuming the draft; ordinary draft `NOT_CHRONICLE_DRAFT`; missing draft `DRAFT_NOT_FOUND`) — every resolved plan through the real `validatePlan` + `finalizePlan` — plus export assertions (claims tab rows `trust_tier = owner_published`, claim figure absent from City Stats, Cover declares claims; portfolio + survey builder scope refusals; survey limits columns at `intel_survey` tier; guest fence; TC-X11 source grep over the four new export files).

Gate mapping: **P4-G11** (exports) — builders/fetch/runners + harness checks 15–20 are this step's evidence; the gate itself closes at assembly when the runners are wired to UI affordances (flag F-L7). **TC-C02** (canon provenance) — harness checks 1–7 + the version-snapshot shape are the evidence. P4-G4-C3's chronicle half closes when the §4 wiring lands (this step ships the helper + the consumption side).

## 4. Chronicle-draft badging — the Lead assembly SPEC (exact)

Brief §1.6/§2.6: resolutions with narrative outcomes produce a chronicle draft in the existing `drafts` collection, badged `sim`, alongside their Log entries; nothing publishes itself; adoption is R-11's `adopt_chronicle_draft` (shipped, §3). The badging itself lives in the resolution path, which is Lead-owned. Four edits:

**(a) `lib/sim/resolver.ts` — `validatePlan` §5.6 (lines 341–347 on this base).** Today any `narrativeOutputs` kind ≠ `"note"` fails validation. Change the admission rule to: kinds `"note"` and `"chronicle"` are admitted; `"situation"` and `"outbox"` still fail in Phase 4 (their surfaces are Phase 5/6). Admission is the whole change — a `"chronicle"` output additionally requires a non-empty `text` (fail otherwise: an empty telling is a bug, not a draft). No handler changes are needed for admission; producers opt in per family (the §2.6 producers — R-10 events, R-11 adoptions with narrative outcomes, R-32 ripenings — start emitting `kind: "chronicle"` outputs as their owners choose; **no family currently emits one**, so this edit is inert until a producer opts in).

**(b) `lib/sim/committer.ts` — `commitResolution`.** The committer never reads `plan.narrativeOutputs` today (the only occurrence is the line-773 literal in the oversize-rejection plan), so chronicle outputs are currently dropped at commit. Wire: after the plan's writes are finalized and BEFORE the Log entries are built, for each `plan.narrativeOutputs` entry with `kind === "chronicle"`: (1) derive the material — `resolutionId` = `req.resolutionId`; `cityId` = the plan's summary entry `cityId` (fail the commit closed if null: a chronicle without a subject city is unbadgeable); `title` = the first line of `output.text`, trimmed, capped at 120 chars; `body` = the full `output.text`; `sourceRuleIds` = the summary entry's `ruleIds` (flag F-L6: this title derivation is the one judgment call in this spec — the alternative, a `title` field on `NarrativeIntent`, is a `state.ts` change with a wider blast radius; Lead's call); (2) build the doc with `buildChronicleDraftDoc(material)` imported from `lib/sim/rules/lore.ts` and add it as a commit write at `drafts/{chronicleDraftIdForResolution(req.resolutionId)}` with `recordClass: "state"`, so the manifest write set, the write ceiling, and undo/erase accounting all see it; stamp `createdAt`/`updatedAt` inside the transaction exactly as `stampDoc` does for plan writes (the helper emits null placeholders for this reason); (3) set `chronicleDraftId` on the plan's summary entry (and on any rule-effect entry whose `ruleIds` produced the output) before `buildLogEntry` runs — the field already exists on `LogEntryDraft` and `buildLogEntry` already copies it (log.ts:184), so the Log names the draft it told. Preview parity: `finalizePlan`'s hash must cover the badging write — if the canonical plan hash excludes `narrativeOutputs`, add them to the hash inputs in the same edit (verify; do not assume).

**(c) `firestore.rules` — the badge fence (TC-C01 badge integrity).** Client writes to `drafts/{draftId}` must not set or change the fabric-only fields `badge`, `canonLayer`, `source`, `sourceResolutionId`, `sourceCityId`, `sourceRuleIds` (an update that touches any of them is denied unless the writer is the fabric/committer identity). Without this fence a member could hand-badge a draft `sim` and route it through R-11; with it, `isSimChronicleDraft` is trustworthy. The ordinary member draft flow is unaffected (unbadged drafts carry none of these fields).

**(d) Rules postures for the new surfaces (this module's records).** (i) `sim_wiki_entry_drafts/{draftId}` (Dana §3.9): reads — the target city's owners + admins; creates — fabric only; updates — the target city's owner may set `status` `pending → adoption_requested` or `→ rejected` (field-limited to `status` + `decision` note fields); the adoption commit (status `→ adopted`, `resultWikiEntryId`, `resultWikiVersion`, `retconProposal`) is fabric-only. (ii) `wiki_entries/{entryId}/versions/{version}`: reads like the entry (viewer); creates — committer only; updates/deletes — none (immutable snapshots). The parent entry doc keeps its Phase 1 member-edit flow EXCEPT the fabric fields (`currentVersion`, `versioned`, `canonLayer`, `canonStatus`, `adoptedByUid`, `adoptedAtSeq`, `provenanceSummary`, `contentHash`) are not client-writable. (iii) `sim_cities/{cityId}/lore_cross_refs/{entryId}`: viewer reads, committer writes (the owner-removal action, when built, is a resolution — committer-written like everything else). Rules-suite cases in the landed pattern (owner read/write matrix + a forged-badge denial + a forged-provenance-field denial) ride the assembly PR.

## 5. Lead assembly needs (complete list)

1. **Registry:** import `LORE_DESCRIPTORS` from `lib/sim/rules/lore.ts` and spread into `RULE_DESCRIPTORS` (51 → 52 descriptors on post-Acquisition master; kinds `adopt_lore_draft` + `adopt_chronicle_draft` classify to R-11 automatically). No finance additions ride this family beyond the descriptor's inline `finance` block (`shortfallClass: "none"`, no ledgers).
2. **Badging wiring** per §4 (a)–(c) + the rules postures per §4 (d), with rules-suite proofs.
3. **Test chain:** append `&& tsx tests/lore-harness.ts` to `test:sim` after the acq harness (order per master at push time).
4. **README composition at push:** this branch's README delta was written against the pre-Acquisition base — compose the step-11 narrative paragraph + changelog line onto master's README; never replay this branch's README wholesale (payload-delta rule).
5. **No new indexes required by this module.** The wiki-entries read is a single-field equality query; the intel-by-actor composite already landed with the Acquisition assembly. The ledger fetch's `sim_log_entries` (`cityIds` array-contains + `seq` order) and `sim_actions` (`targetCityIds` array-contains) query shapes mirror existing consumers — confirm at assembly (flag F-L7).
6. **UI follow-ups (not this PR, flagged for June/Lead):** Situations review surface for pending wiki drafts + retcon proposals (the drafts now have somewhere to land); city-page/portfolio export buttons wiring the three runners in `lib/export/phase4Workbook.ts`; the wiki entry page rendering `versions/` history + `provenanceSummary`.

## 6. Flags surfaced, not flipped

- **F-L1 (D-5):** Tracked-fact establishment from adopted lore (spec R-11's `source: lore <entry id>` records) is NOT built — the draft shape carries no fact-assertion language, and inventing one is an actor-nominated-record hole. Phase 6 ingestion design owns the assertion language; the adoption seam (`proposedStats` → entry/version docs) is where it lands.
- **F-L2:** The cross-reference REMOVAL action is not built (records carry `removableByOwner: true`; removal per spec R-11 is a logged owner action — a small future kind, or a Situations affordance in Phase 6).
- **F-L3:** Retcon DECISIONS are not built — this step surfaces proposals only. Deciding (adopt the retcon / keep canon / keep both as layers) is a Phase 6 Situations act; per Dana, even `auto_apply` cities never auto-decide a retcon.
- **F-L4:** Legacy unversioned entries (no `currentVersion`): treated as version 0 — a first adoption writes version 1 with `previousVersion: null`, and drift-conflict requires both versions non-null. Needs Dana's ratification at assembly.
- **F-L5:** Shared-city adoption verifies `isSharedCity` + the mayor office only; Phase 7 term records refine who the sitting mayor is (the same standing flag every family carries).
- **F-L6:** Chronicle title derivation in §4 (b) is a judgment call, named there for the Lead.
- **F-L7:** The city-ledger export depends on the deployed rules allowing member reads for its two queries; if denied, the export fails closed (honest error, no file) until the Lead's rules pass confirms the posture. Verify in the rules suite at assembly.
- **F-L8:** Portfolio field names were read from Cato's FINAL market shapes in `p4-market-clone`; the fetch mappers are null-honest, so a rename at Market assembly degrades to nulls, never wrong figures — re-verify the mappers against the merged market module at assembly.

## 7. PR draft (for the Lead's push)

**Title:** Phase 4 step 11 — Lore hook (R-11 adoption) + chronicle badging + Phase 4 exports

**Body:** Lands Dana's step-11 row. (1) `lib/sim/rules/lore.ts`: the R-11 adoption family — Dana §3.9 adoption commit for wiki-entry drafts (immutable version snapshots, provenance on the entry, deterministic preallocated ids), chronicle-draft adoption publishing sim-badged drafts as canon posts, retcon proposals instead of overwrites, owner-only adoption with the NPC never-bind structural refusal, cross-city references as labeled records, and the pure chronicle-badging helper for the Lead's committer wiring (exact spec in the prep report §4 — resolver/dispatcher untouched here). (2) `lib/export/**` additions only: Portfolio, City Ledger (treasury view + action history), and Survey Results workbooks in the Phase 3 idiom — as-requester fetch, pure-layer fail-closed scope guards, intel limits exported as first-class columns, claims labeling asserted against the landed Phase 3 builders, no Sheets path. (3) `tests/lore-harness.ts`: 20 checks, every resolved plan through the real `validatePlan`. README updated per CJ's rule. Assembly needs (registry 51→52, §4 wiring, rules postures, test chain, README composition) and flags F-L1–F-L8 are in `workstreams/p4-lore-prep-report.md`. Gate evidence: P4-G11, TC-C02. Nothing deployed.
