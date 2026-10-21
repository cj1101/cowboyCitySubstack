# Phase 5 Substrate — Build & Assembly Report (PR-1)

**Author:** Rafe (Muse Eng), Phase 5 Build Lead · **Date:** 2026-10-20
**Branch:** `phase5/substrate`, on `phase5/assembly-base` (tip `b728863`: master
`b8ddf93` + rebased NPC core + authority/envelopes, tree-verified at Half 1).
**Implements:** assembly plan W1 (`phase5-assembly-plan.md` §3 PR-1), brief
`phase5-implementation-brief.md` §3.3/§9/§10, decisions `phase5-decisions.md`,
countersign addendum `qa-phase5-gate-countersign.md` (A-1–A-8).
**Not pushed.** Theo pushes via the Git Data API after tree verification.

---

## 1. Build record

Five commits (local SHAs; remote SHAs will differ under API replay):

| # | Commit | Contents |
|---|--------|----------|
| 1 | `5f4b2c6` | Governance registration + P5-K13 data half: `lib/sim/rules/governance.ts` (new), `lib/sim/rules/registry.ts` (spread + header), `lib/sim/state.ts` (`SimActor.characterId`), `lib/sim/log.ts` (`entryActorForm`) |
| 2 | `c14ac7d` | `tests/governance-harness.ts` (new, 15 checks) + `package.json` (`test:sim` chain) |
| 3 | `d9907a0` | `firestore.rules` §9 blocks (+301 lines, purely additive) + `firestore.indexes.json` §10 (+95 lines, purely additive) |
| 4 | `9377e03` | `tests/rules.test.ts` Phase 5 section (the P5-G9 matrix) |
| 5 | `5718a8a` | README (Phase 5 section, changelog, scripts + structure rows) + `workstreams/phase5-decisions.md`, `workstreams/qa-phase5-gate-countersign.md`, `workstreams/phase5-assembly-plan.md` ride into the repo |
| 6 | this report | `workstreams/p5-substrate-prep-report.md` |

## 2. What landed

**Registration (brief §3.3, P5-K6).** Five descriptors in a new Lead family
file `lib/sim/rules/governance.ts`, spread into `RULE_DESCRIPTORS` (70 total):
`npc.create` {npc.create, npc.edit, npc.retire, npc.setMode}, `mandate.set`
{mandate.set, mandate.revoke}, `delegationRule.set`, `situation.handle`
{situation.handle, situation.delegate, situation.silence}, `envelope.spawn`
{envelope.spawn, envelope.cancel}. Descriptor ids are the primary action
kinds — the form the ahead-built modules already use (`emptyPlan("npc.create")`
in lib/npcs) and the form the Log cites.

**`npc.create` is live** through an adapter handler over the NPC core's
`planNpcCreate` (checklist §2 machinery): authority (`requireAuthority`) →
member-actor gate → character-existence check (descriptor `readPlan` reads
`sim_npcs/{id}` + `characters/{characterId}`) → module builder (its
`NpcCoreError` codes pass through as rejection codes) → duplicate-record
refusal → plan adaptation (§3.2 below). The resolution writes the record in
`pending_activation`; the P5-K3 default (`ask-first`) comes from the builder
itself (gate A-4's literal — harness check G2 asserts it). The fabric
activation flip (`planNpcActivate` composition) rides this same descriptor in
PR-2, where the committer effectiveness flips land — Cato flag 5, carried
(§5).

**The other eleven kinds carry deferral handlers** in the R-29 idiom
(Phase 4, P4-K8): a resolved, logged, narrative-only summary entry whose
classification carries `narrativeOnly: true` + the landing step id and whose
summary text states the deferral in the open ("REGISTERED but its engine
lands with …"), zero writes. PR-2 (engine core) takes npc.edit/retire/setMode,
mandate.*, delegationRule.set, envelope.*; PR-3 takes situation.*.

**P5-K13 data/canonical half.** (a) `sim_npcs.characterId` — already the
module record shape; the create path writes it (harness G2). (b) `SimActor`
gains `characterId?: string | null` — additive, member form only in effect;
the type union is unchanged, which is the type-layer enforcement of "no
`character` actor type ever." (c) `entryActorForm` in `lib/sim/log.ts`:
`buildLogEntry` stores the key only when it carries a value — absent ≡ null,
so pre-Phase-5 entries and every historical entry hash are byte-untouched
(the v2 hashed field list is unchanged; the verifier's both-forms acceptance
is W2, the hash assertions W6, per the plan).

**Rules (brief §9).** Blocks for `sim_npcs`, `sim_teams`, `sim_mandates` +
`versions`, `sim_task_envelopes`, `sim_task_outputs`, `sim_situations`,
`sim_delegation_rules` + `versions`, with five scoped helper functions
(character-link, envelope audience incl. the situation join, output read via
the §9.4 audience + stored-snapshot branch, spawn link cross-checks,
delegation handler fences). The §1.2 write split is the organizing rule:
members author PENDING records; the committer alone makes anything
effective; §9.8 undo postures hold (committer erasure of resolution-created
records; **effective versions and task outputs deletable by no identity**;
outputs immutable forever).

**Indexes (brief §10).** Nine composite indexes (envelope claim pass,
lease sweep, requester-newest; situation city/person audiences + dedupe;
NPC city/owner rosters; the pending attention join) + four field overrides
(`sim_task_envelopes.task`, `sim_task_envelopes.bounds`,
`sim_task_outputs.structuredOutput`, `sim_situations.detail`).

**Tests.** `tests/rules.test.ts` gains the P5-G9 matrix (~90 assertions,
per-collection posture groups). `tests/governance-harness.ts` (new, 15
checks G1–G5) proves the registry/adapter/canonical contract purely and is
chained into `test:sim` after the closeout harness.

## 3. Lead assembly decisions (mine; flagged where they touch module ground)

**3.1 Descriptor id scheme.** One descriptor per governance domain, id ==
primary kind (forced jointly by `validatePlan`'s ruleIds-must-exist rule and
the modules' own descriptor naming). PR-review ratification item under
P5-K6, like every registry name.

**3.2 Adapter adjustments (wiring layer only — no module logic altered; each
flagged for Cato at PR review).**
(a) *Timestamps:* the module stamps `createdAt`/`updatedAt` from its `now`;
registry plans are clock-free, so the adapter passes a fixed epoch and nulls
both fields on the planned write — the committer stamps them in-transaction,
as for every landed family. Harness G2 proves plan-hash parity across two
wake instants.
(b) *Entry changes:* the module's two change strings (`sim_npcs.status`,
`sim_npcs.permissionMode`) predate the landed F-02 changes↔writes
reconciliation, whose target grammar (city doc + its subcollections) cannot
resolve a top-level collection's fields — a plan carrying them fails
`validatePlan` with a snapshot. The adapter drops them; creation is claimed
by `recordsCreated` (the R-32 fund-doc precedent).
(c) *Bookkeeping:* the adapter completes the module's minimal summary draft
(actionId/actionText/classification/ruleIds) and folds citations into
`readRefKeys`, as every registry-native handler does.

**3.3 Rules readings where the brief needed interpretation.**
(i) *§9.6/§9.4 "delete: denied for all identities" vs §9.8:* §9.8 is the
later, specific undo amendment and enumerates situations and envelopes
expressly; §9.1 shows the intended global reading (client-denied + committer
undo path). Implemented uniformly: member deletes denied everywhere;
committer delete on npcs/teams/mandate roots+rules roots/situations/
envelopes; NEVER on effective versions (§9.8's express exemption) or
outputs (§9.5 "forever", unlisted in §9.8).
(ii) *Mandate version delete:* a never-effective version is deletable by its
author (§9.3) and by the committer (an unwound mandate.set created it);
an effective version by no identity.
(iii) *Negotiation-bounds fence (§9.3):* the module's detection is
substring-based over free-string action-type IDs — not rules-expressible.
The rules fence the expressible payload discipline (sequence, seqs, caps,
freeform caps); the bounds requirement itself is enforced by the shared
builder/validator every authoring path calls (`buildMandateVersion`
throws), and by the mandate.set resolution in PR-2. The rules comment says
so in the open (the brief's own §9.7 admits the same class of limit).
(iv) *Version-payload field overrides (§10):* skipped — a collectionGroup
`versions` override would strip indexing from allocation/lore versions too;
no §10 query reads version bodies. Flagged for Dana if a body-reading query
ever appears.
(v) *Fabric reads* on envelopes/outputs/situations/delegation rules follow
the landed P2-K16 completion (the fabric cannot work collections it cannot
read); member postures are exactly the brief's.

**3.4 Scope note — the play catalog.** `PLAY_ACTION_KINDS` stays empty in
this PR (it is empty on master through all of Phase 4): governance actions
are submitted from their settings/Situations surfaces (W4/PR-5), not the
generic play form catalog, and `offeredKinds` filters by registration in any
case. The registry is the registration of record.

## 4. Flags (new, from this build)

**F-S1 — Envelope field names diverge (brief vs module).** Brief §2.5/§9.4
name the envelope record's requester `requestingMemberId` and its text
`task`; the landed module (`lib/envelopes/types.ts`) builds `requesterUid`
and `intentText`. **The rules fence the brief's names** (the brief is the
rules' source text, and §10's index keys on `requestingMemberId`).
Consequence: the module's spawn builder cannot write a client-visible
envelope until W2 reconciles the builder to the brief's names (a rename in
lib/envelopes + its harness) — no envelope can be written by anyone before
PR-2 anyway (spawn handler lands there). Named here so W2 takes it
deliberately, not by discovery. The outputs audience snapshot (§9.5's stored
`audienceUids` branch, Dana §5.5 pattern) is likewise a W2 builder item; the
rules read branch for it is already in place.

**F-S2 — Mandate root born shape (brief vs module).** Brief §9.3's
client-create fence text has the root born `currentVersion == 0` with no
version refs; the module's `buildMandateRoot` authors the root WITH its
first version (`currentVersion == firstVersion.version`,
`currentVersionRef` set), status pending. The fence admits both flows
(currentVersion 0 or 1; version create accepts root+1 or the born
root-equal), because effectiveness never rides the pointer — it rides the
version's `effectiveSeq`, which only the committer's resolution sets.
Flagged for Vera/Dana awareness; no behavior depends on the choice until
PR-2's mandate.set flip reads the pointer.

**F-S3 — The rules-version stamp (P5-K2) is NOT applied.** The decisions
record adopts `sim-rules-0.5.0-phase5` as the phase label; the landed code
still stamps `sim-rules-0.2.0-phase2` (`RESOLVER_RULES_VERSION`), and Phase
4's adopted label was likewise never applied as a stamp. Flipping the shared
constant inside the substrate PR would move every pinned assertion that
cites the stamp (sim-core ×2, rules ×1) and re-stamp every Phase 5 entry's
provenance in the same motion as registration — a deliberate change that
deserves its own diff. W1 registers under the landed stamp; PR-2 (engine
core) is the natural home for the bump, or the label stays record-only as
Phase 4's did. **Theo/Koda call at PR review.**

**F-S4 — P5-D6 remains FLAGGED for Koda (A-7 holdout in force).** The
deletion-inside-restore assertion is held out of the rules suite and named
PENDING in three places (the suite comment, the PR body, this report).
While unratified, the §9.3/§9.7 restore fences encode only the ratified
exemption: effective versions are deletable by no identity. If Koda ratifies
the recommended reading (deletion permitted inside an undo restore
transaction only), the rules still cannot express transaction context — the
behavioral consequence lands in the undo engine (W2/W6 evidence), not in a
rules diff; the gate suite then asserts the ratified form.

**F-S5 — `characters` collection note.** §9.1's link fence reads the
`characters` doc's `factionId` via cross-doc `get()` (the landed bank-owner
idiom). The minted-in-one-resolution half of §2.1 (the `characters/{id}`
doc creation itself) is a member write under the social rules, outside the
sim transaction (the committer has no `characters` write branch, and §9.9
forbids adding one here) — the surface (W4) sequences it; the sim-side
record accepts `mintedCharacterId` today (harness G2, check 5).

## 5. Carried PR-review ratification items — NOT decided by the Lead

From `phase5-decisions.md` §4, carried verbatim as open items for the PR
review (the decisions record's own adoptions are cited as the record's):

*Cato's five (NPC core):* (1) default-mode location — the record ADOPTED it
as the builder default (P5-K3); the residual review item is its gate
expression. (2) mandateHash field set — include `sourceActionId`, exclude
`createdAt` (review the golden vectors). (3) Cascade policy mechanics
(revoke issuing NEW pendings' treatment at their evaluation). (4)
Awaiting-input expiry — named constants vs WakeScanState fields. (5)
Activation composition — the substrate's adapter preserves the module's
split (create and activate as separate plans); the composition lands in
PR-2 under this item.

*Vera's five (authority/envelopes):* (1) Owner-direct envelope tasking vs a
later flip-to-silent — the record's E9 line (owner-direct survives,
rule-spawned doesn't) is the pinned behavior for PR-2's revalidation to
encode. (2) Envelope claim-revalidation timing + claiming a `runStartSeq`.
(3) Situation↔pending linkage form — the record ADOPTED linked-not-fused
(P5-K8). (4) Revocation reach into a ripening delegated pending
(`revocationReaches("ripening") === false` is executable fact today). (5)
Envelope results re-entering evaluation as seven-check citations.

Plus the record's own flags: **P5-D6** (F-S4 above) and **P5-D5**
(adopted-with-flag in the record).

## 6. Verification (run on this branch, 2026-10-20)

Local (this sandbox; the Firestore emulator cannot run here — standing
hazard, CI is the venue of record for the emulator suites):

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| Scoped ESLint (all touched files) | 0 errors (1 warning, pre-existing at rules.test.ts:2004, outside this PR's section) |
| `tests/cat1-harness.ts` | all scenarios passed (validatePlan incl. F-02) |
| `tests/defense-harness.ts` | 12 scenarios passed |
| `tests/chains-harness.ts` | 34 checks passed |
| `tests/cat2-harness.ts` | 34 checks passed |
| `tests/acq-harness.ts` | 14 checks passed |
| `tests/market-harness.ts` | 27 checks passed |
| `tests/lore-harness.ts` | 27 checks passed |
| `tests/closeout-harness.ts` | 29 checks passed |
| `tests/governance-harness.ts` (new) | **15 checks passed** |
| `lib/npcs/harness/npc-core-harness.ts` | 36 checks passed |
| `lib/authority/harness/authority-harness.ts` | all cases passed (A1–A13) |
| `lib/envelopes/harness/envelopes-harness.ts` | all cases passed (E1–E11) |
| `npx next build` | green |

Not runnable locally (emulator suites — CI is their venue, as for every
prior phase): `tests/rules.test.ts` (incl. the new §9/P5-G9 matrix),
`tests/sim-core.test.ts`, `tests/play-core.test.ts`. The governance
harness's G2/G3 checks exercise the new adapter through the real resolver
+ `validatePlan` purely, which is the strongest local evidence available
for the registration half; the §9 postures themselves first execute in
CI's Rules job on push.

## 7. Remaining in the train (assembly plan §3)

PR-2 Engine core (Rafe) — governance handlers go effective (committer
flips), envelope field-name reconciliation (F-S1), the P5-K13 verifier,
P5-K14's resolver half. PR-3 Situations + delegation (Vera). PR-4 Wake
completion (Rafe). PR-5 Surfaces (June). PR-6 Banking slice (Felix). PR-7
Gate (Rafe) — `tests/npc-core.test.ts` per A-1, gate evidence incl. the
A-7 item in its ratified form.

---

## 8. Final PR draft

**Title:** Phase 5 PR-1 — Substrate: governance registration, P5-K13 data half, §9 rules + §10 indexes (built, not live)

**Body:**

> **Built, not live.** This PR assembles the Phase 5 substrate in code. The
> P2-K15 production chain has **not** run: (1) no production fabric user
> exists with the `fabricRole` values (committer + worker); (2) production
> rules have **not** been deployed; (3) production indexes have **not**
> been deployed; (4) production genesis has **not** run; (5) there is no
> operated production wake path. Every Phase 5 gate row in this train
> closes on CI evidence in **built form only** (countersign A-2).
>
> **What lands** (detail: `workstreams/p5-substrate-prep-report.md`):
> - The twelve governance action kinds (brief §3.3) classify through the
>   registry — five new descriptors in `lib/sim/rules/governance.ts`, 70
>   total. `npc.create` is live via an adapter over `lib/npcs`' plan
>   builder (pending record; P5-K3 `ask-first` default from the builder;
>   clock-free plan). The other eleven kinds carry stated deferral
>   handlers (R-29 idiom) naming PR-2/PR-3 — registered, logged, never
>   silent.
> - P5-K13 data half: `SimActor.characterId` (additive; no `character`
>   actor type) + `entryActorForm` absent≡null stored form — historical
>   entry hashes untouched, proven in the new governance harness.
> - Brief §9 rules for all seven Phase 5 collections + version
>   subcollections (owner-pending vs committer-effective; §9.8 undo
>   postures; effective versions + outputs deletable by no identity);
>   §10 indexes (9 composite + 4 overrides).
> - `tests/rules.test.ts` P5-G9 matrix (~90 assertions);
>   `tests/governance-harness.ts` (15 checks) chained into `test:sim`.
> - `workstreams/phase5-decisions.md` + `qa-phase5-gate-countersign.md` +
>   `phase5-assembly-plan.md` ride in; README updated per the standing
>   rule.
>
> **A-7 holdout (named, not ridden):** the undo-restore assertion
> touching deletion of an effective mandate version inside a restore
> transaction is **HELD OUT of this PR — PENDING Koda ratification** of
> decisions item **P5-D6** (recommended reading in
> `workstreams/phase5-decisions.md`). The suite asserts only the ratified
> ground: effective-version deletes fail for every identity; the
> committer's supersededSeq-only restore flip succeeds.
>
> **Flags in the open** (prep report §4): envelope field-name divergence
> (rules fence the brief's `requestingMemberId`/`task`; W2 reconciles the
> module builder); mandate-root born shape (fence admits both flows;
> effectiveness rides `effectiveSeq`); the `sim-rules-0.5.0-phase5` stamp
> is adopted as the phase label in the decisions record but **not**
> applied to the shared constant in this PR (its own deliberate change;
> PR-2 is the natural home). The ten module flags from the decisions
> record ride as **PR-review ratification items**, undecided.
>
> Regression: full pure battery + module suites green locally; CI carries
> the emulator suites (rules incl. the new matrix, sim-core, play-core).
