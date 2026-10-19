# Phase 4 Module 0 Prep Report — the data step

**Author:** Rafe (Muse Eng), Phase 4 Build Lead · **Date:** 2026-10-19 · **Status:** IN PROGRESS (written progressively, section by section)

**Scope (Dana's `phase4-build-prep-report.md` §2.4 step 1, verbatim):** "Module 0 — data step (Lead, serial, gates everything after step 0): template amendments (pool stamp in the builder, `defensePosture` default), A-7 corporation fields + `legacyBookRubars` + `taxPayables` shape (P4-K11), the allocation fence narrowing + versions committer-only (P4-K14), backfill script (emulator-only, idempotent, assertion-verified). *No other module starts against unstamped shapes.*"

**Workspace:** `phase4-clone`, branch `phase4/module0`, based on `348afab` (Step 0 tip; its tree is the post-merge master `eb909b5` content — Theo verifies tree equality at push time). Nothing pushed by the author; no production anything (no production Firestore, no rules/index deploy, no genesis).

## 0. Grounding findings (before any code)

1. **The template half of §12.3 is already landed.** `lib/sim/template.ts` on the Step 0 base already stamps `pointBudget: INITIAL_POINT_BUDGET` (= 400) in `buildSimStatAllocationsDoc` and already writes the `defensePosture` default in `buildSimCityDoc` — the Phase 1 build applied Vera's Q-B5 lock to the builders, exactly as brief §3.6's note anticipated ("the step reconciles data with code, and P4-G1 asserts both"). Module 0 therefore changes **no template code**: it asserts the builder half (P4-G1 data half) and lands the data half (the backfill). Any edit to the builders would be churn against a landed, hash-asserted surface.
2. **The corporation rules block already exists** (`sim_cities/{cityId}/corporations/{corpId}`: viewer reads, committer create/update/delete — landed Phase 1). What does not exist anywhere in `lib/sim/**` is the corporation **record shape in code** — that is the P4-K11 deliverable (§2 below).
3. **CI venue wiring:** the Sim core job runs `npm run test:sim`, which names only `tests/sim-core.test.ts`. Prep §4.0 names the new `tests/play-core.test.ts` as the Phase 4 CORE/DATA venue in that same job, so Module 0 extends the `test:sim` script to run both files sequentially under one `emulators:exec` (job name and the required check untouched).
4. **No landed code depends on the fence being narrowed:** `commit_requested` appears nowhere in `tests/`, `lib/`, `scripts/`, `app/`, `components/` as a client write, and no test creates an allocation `versions` doc. The P4-K14 narrowing removes a path nothing uses — as the prep predicted ("tightening costs nothing").
5. **The data step writes no Log entries.** Brief §3.6 defines the step as stamp + assertion pass; it is an ops backfill over pre-existing docs (genesis discipline: fabric data acts are recorded by their own verification pass, and the step's byte-compare assertion forbids touching anything outside the two target fields). Recorded here as a flagged reading of the brief, not a silent choice.

## 1. Rules companion amendment (P4-K14) — commit 1

Exactly the two narrowings the prep prescribes, nothing else in `firestore.rules`:

1. **`sim_stat_allocations` owner update:** target statuses narrowed from `['draft', 'commit_requested']` to `['draft']`. The committer branch is untouched. A comment records why: under brief §3.3, allocation commit is an `allocate_season0` action through the play loop (submit → preview → hash-bound confirm); the committer sets `commit_requested` when queueing the confirmed action. A browser status flip creates no queue item, no preview, and no Resolution Event — it is not a commit path, so it no longer exists as one.
2. **`versions/{version}` create:** committer-only. The Phase 1 owner-create clause (`simCityOwner && authorUid == auth.uid`) is removed, per brief §1.2 (the first version is a fabric write inside the commit transaction) and prep §3 D-A2 (an owner-creatable version path is a second, unaudited route to a commit-shaped record; the allocation module never used it).

**Rules-suite evidence added** (`tests/rules.test.ts`, new section "P4 Module 0: allocation fence narrowing (P4-K14)", running in the Rules tests job): owner update to `commit_requested` now **fails** (it succeeded under the Phase 1 fence); owner draft save still **succeeds** (the narrowing removes the commit path, not the draft path); the committer **can** set `commit_requested` (the one remaining path, P4-G12-C1); owner create of a `versions` doc **fails** even with `authorUid` equal to their own uid (the removed clause's exact condition); committer create of the first version **succeeds**. No existing assertion was touched or weakened — P1-G7's section stands as written, and its owner-update-to-`committed` failure is now joined by the `commit_requested` failure one step earlier in the lifecycle.

## 2. Corporation shape (P4-K11 + brief §1.4) — commit 2

New module `lib/sim/corporations.ts` — the record shape and the founding builder; no handler (R-06/R-07 create through it in Catalogue II's step). Three provenance layers, as the prep orders:

- **Dana's base shape** (backend §3): `name`, `industry`, `status` (`active | contracted | relocated | dissolved`), `valuationRubars`, `founderFigureId`, `homeCityId`, `marketCityIds`, `linkedStructureIds`, `sourceActionId`, `sourceSeq`, `stateVersion`, `lastChangedSeq`, `lastResolutionId`, timestamps — plus `corporationId`, matching the landed convention that sim records carry their id.
- **A-7 (finance FIN-C3, confirmed P4-K11):** `ownerMemberId: string` — the one ownership fact F-03/F-06 validation may read, never inferred from `founderFigureId` (a lore persona link) — and `companyCashRubars: integer`, founding default a true bookkeeping **0** (funding arrives as F-03 resolutions, never as a founding default).
- **`taxPayables` (finance §5.3):** `{ [cityId]: integer }` on the record — a recorded obligation, not a loan: accrues nothing, tradable by no one, held as no one's asset; keys are removed at zero so an absent key and a zero entry never carry different meanings.
- **Brief §1.4:** `legacyBookRubars: integer | null` (the unlisted formula's result at founding/listing; `null` where skipped under the null-GDP rule; provenance/display only — never an M-06 input) and `listed: boolean` (founding `false`; listing is an M-01/M-02 act), which keys the dual meaning of `valuationRubars` so no surface has to guess.

`buildCorporationDoc` takes the founding economics as arguments (the founding rule computes them) and invents none. Verified by a pure tsx harness pre-commit: every field present, defaults exact, null-legacy representable, path helper correct. (The banking charter block is **not** here: it is the Finance module's data shape under the conformed banking amendment, not a P4-K11 item — Module 0 builds exactly its spec.)

## 3. The data step (brief §3.6) — commit 3

Two files: `lib/sim/phase4DataStep.ts` (the step) and `scripts/sim-phase4-data-step.ts` (the emulator-only wrapper, on the landed `sim-admin.ts` pattern — `requireEmulator` refuses any non-emulator run; production execution is the production chain's, P2-K15).

**Planner (pure):** `planPhase4DataStep` emits a write only where a target is unstamped — an allocation whose `pointBudget !== 400` (null, absent, or a wrong value all stamp; the pre-step value is recorded as the write's `before`), and a city whose `defensePosture` is absent. A present posture is live state and is **never** overwritten, whatever it holds.

**Applier + assertion pass:** single-field updates only; then the pass re-reads both collections and throws unless (a) every allocation reads `pointBudget === 400`, (b) every city carries a structurally valid `defensePosture` (three keys, typed — `isDefensePostureShape`), (c) collection sizes are unchanged, and (d) every doc's **remainder hash** — canonical hash (timestamps normalized to ISO, the canonical layer's convention) over the doc with its target field stripped — equals its pre-step hash. That is §3.6's "byte-compare outside the two targets" made executable. A partially verified world is never reported as stamped: any failure throws and the script exits 1.

**Local evidence:** pure tsx harness over the planner + remainder hash — unstamped/null/absent/wrong-value all plan exactly one write each; a stamped world plans **zero** writes (idempotency); the remainder hash is invariant to the target field and sensitive to any other field; Timestamp-shaped values normalize identically to Dates. The emulator end-to-end run is the play-core section (commit 4), venue CI.

## 4. Play-core harness + gate evidence — commit 4

New `tests/play-core.test.ts`, the Phase 4 CORE/DATA venue the prep names (Osei annex §4.0), wired into the existing Sim core job by extending `package.json`'s `test:sim` to run `sim-core` then `play-core` under one `emulators:exec` (job display name and the required check untouched; neither emulator job goes near branch protection). The file is structured to grow a section per module in integration order; Module 0's sections:

- **Builder half of P4-G1's data half (pure):** `buildSimStatAllocationsDoc` stamps `pointBudget === INITIAL_POINT_BUDGET === 400`; `buildSimCityDoc` carries the `defensePosture` default deep-equal to the data step's own default constant (builder and backfill can never drift apart silently); the template stats keep all eight indices + population + GDP `null` pre-allocation (TC-D04 pre-state / null-honesty).
- **Corporation shape (pure, P4-K11):** A-7 fields present with exact founding defaults; `legacyBookRubars` recorded, `listed` false, the null-GDP skip representable; the path helper's one spelling.
- **Data step end-to-end (emulator):** legacy fixtures (a `pointBudget: null` allocation doc and a posture-less city doc, each carrying a marker field; a pre-stamped allocation; a city with a *set* posture) → the step stamps exactly 2 writes, remainder hashes prove nothing outside the two targets changed, the set posture is **not** overwritten, and a second run applies **0** writes (idempotency, P4-G1 data half).

Fixture-discipline note (H-P45-1): the data-step section seeds pre-stamp docs directly through the Admin SDK because simulating pre-stamp docs is its entire object — no resolution state is fabricated, and the header of the suite file says so in as many words.

The rules half of Module 0's gate evidence is commit 1's section in `tests/rules.test.ts` (P4-K14 narrowing; P4-G12-C1's one-commit-path proof). Local: full `tsc --noEmit` clean; scoped ESLint over every Module 0 file clean (the single warning reported in `tests/rules.test.ts` is pre-existing Phase 2 code at base line 1573, untouched). Emulator execution is CI's venue, per standing sandbox findings.

## 5. Local verification

- `npm run typecheck` (full project `tsc --noEmit`): **clean**.
- Scoped ESLint over every Module 0 file (`lib/sim/corporations.ts`, `lib/sim/phase4DataStep.ts`, `scripts/sim-phase4-data-step.ts`, `tests/play-core.test.ts`, `tests/rules.test.ts`): **0 errors**; the one warning (`_dropped`, rules suite) exists identically on the base tree (Phase 2 code) and was not touched.
- `npm run build`: **green** (full route table compiled).
- Pure tsx harnesses (run pre-commit, then deleted — the assertions themselves live permanently in `tests/play-core.test.ts`): corporation builder field-for-field; template builder stamps; data-step planner over null/absent/wrong-value/stamped inputs; remainder-hash invariance and sensitivity; Timestamp/Date normalization parity.
- **Not run locally (sandbox cannot):** both emulator suites. Module 0's emulator evidence is CI's: the Rules job (new P4-K14 section) and the Sim core job (play-core Module 0 sections) on this PR. No gate row is claimed green on local evidence.

**The stack** (all authored Rafe (Muse Eng), base `348afab`):

| Commit | Content |
|---|---|
| `25bf384` | P4-K14 rules narrowing + rules-suite section |
| `02fe41f` | P4-K11 corporation shape + founding builder (`lib/sim/corporations.ts`) |
| `40bf587` | Brief §3.6 data step (`lib/sim/phase4DataStep.ts` + `scripts/sim-phase4-data-step.ts`) |
| `a16f7e2` | Play-core harness + `test:sim` venue wiring |
| `5ab6384` | README (status paragraph + dated Changelog line) |
| (this report) | `workstreams/phase4-module0-prep-report.md` |

Total delta vs base: 9 files (incl. this report), confined to the prep's Module 0 surfaces — `firestore.rules` (two clauses), `lib/sim/corporations.ts`, `lib/sim/phase4DataStep.ts`, `scripts/sim-phase4-data-step.ts`, `tests/play-core.test.ts`, `tests/rules.test.ts` (additive section), `package.json` (one script line), `README.md`. **No template code changed, no registry change, no index change, no engine change.**

## 6. Batch A assignment map — as the prep defines it (quoted, not improvised)

Prep §2.4 step 2, verbatim: "**Parallel batch A** (independent once Module 0 lands): Intake UI (step 2) ∥ Allocation (step 3) ∥ Finance primitives (step 4: accounts + F-01 + backfill, transfer primitive, conservation checker, F-02/F-03/F-05, F-12)." And §2.4 step 3: "**Catalogue I** (step 5) — depends on Module 0 only; may overlap batch A."

The §2.2 ownership rows for those steps:

| Module (brief step) | Owner (prep §2.2) | Clone / branch | Owns (exclusive) | Delivers |
|---|---|---|---|---|
| Intake UI (step 2) | Intake UI worker | `p4-intake-clone` / `p4/intake-ui` | `components/play/**` (action box, preview card, never-bind confirmation card), `lib/play/**` (client intake helpers over the landed `buildActionDoc`) | Step 2 (brief module a) |
| Allocation (step 3) | Allocation worker | `p4-allocation-clone` **rebased** / `p4/allocation-ui` (kept) | `lib/allocation/**`, `components/allocation/**`, `lib/sim/rules/allocation.ts` (the `allocate_season0` handler), allocation slot on the stat-sheet surface (coordinated with the Phase 3 stats owner via the Lead) | Step 3 (brief module b) |
| Finance primitives (step 4) | Finance worker | `p4-finance-clone` / `p4/finance-core` | `lib/finance/**` (account model, transfer primitive, F-01/F-02/F-03/F-05/F-12 logic), `lib/sim/rules/finance.ts`; the conservation checker as a pure module `lib/finance/conservation.ts` (Lead wires it into `lib/sim/verify.ts`) | Step 4 (brief module c) + F-12 |
| Catalogue I (step 5; may overlap batch A) | Catalogue I worker (structures & city) | `p4-cat1-clone` / `p4/catalogue-structures` | `lib/sim/rules/structures.ts` (R-05 spine, R-01–R-04, R-38 hook, R-24 + derived function, R-16/R-19), `lib/sim/rules/laws.ts` (R-08/R-09 + F-08 vocabulary; F-09/F-10/F-11 handlers ride here per brief step 5) | Step 5 |

**Clone base for batch A (§2.3):** every clone is cut fresh from the build base — master **after Module 0 merges** (the stamped shapes are the base; "no other module starts against unstamped shapes"). Sole exception, §2.3 verbatim in substance: `p4-allocation-clone` already exists on the Phase 1 base and is **rebased, not merged** — replay `54836cd` + `7028c0b` onto the build base, deleting `lib/allocation/canonical.ts` in the rebase (P4-K15) and re-verifying the editor's CSS classes against the then-current `app/globals.css`. Per §2.1, catalogue workers write NEW family files under `lib/sim/rules/` and the Lead (this clone) makes the single `registry.ts` assembly edit per module PR; the Lead also owns `firestore.rules` / `firestore.indexes.json` assembly for every module PR.

**What batch A stands on from Module 0:** Finance's F-03/F-06-adjacent validation reads `ownerMemberId` from `lib/sim/corporations.ts` (landed); Finance step 4's own "accounts + F-01 + backfill" is the F-01 genesis-grant backfill (P4-K6) — a different backfill from Module 0's §3.6 stamp, not to be conflated; Allocation's commit battery (P4-G1-C3) runs against a fence that now permits exactly one commit path (P4-K14, landed); every module's fixtures assume `pointBudget: 400` docs and `defensePosture`-carrying cities (builders + backfill, landed).

## 7. Open flags for Theo

1. **§12.4 versions index not added — deliberately.** Brief §12.4 names a composite for allocation versions by `cityId + commitSeq`, but the prep's Module 0 spec names no index work, and §12.4's own discipline is "no speculative indexes — each addition justified in the PR body by its query." The versions-by-commitSeq query belongs to the Allocation module (step 3); it should add the index in its PR with its query named. Flagged in case Theo wants it pulled forward into Module 0's PR instead.
2. **Stamp semantics for a wrong `pointBudget` value.** The planner stamps any value `!== 400` (a hypothetical 999 included), i.e. the step reconciles to the lock rather than only filling nulls. §3.6's text ("stamps `pointBudget: 400` on every allocation doc") supports this reading, and the rules fence makes a wrong value unreachable by clients in the first place. No action needed; recorded so the behavior is a decision, not an accident.
3. **No-Log-entry reading of §3.6** — see §0 finding 5. If Koda wants the production run of the step Log-anchored when the production chain executes it, that is a production-chain (P2-K15) instruction, not a change to this step's emulator form.
4. **`package.json` `test:sim` line changed** (play-core venue wiring, §0 finding 3). One line, no dependency changes; the lockfile is untouched. Flagged because `package.json` is a shared surface and the payload-delta rule applies to it at push time.
5. **Push posture:** replay the 6-commit stack onto current remote master under the payload-delta rule (delta is 9 files; README and `package.json` are the only previously-touched surfaces). PR body should claim "built" only (P4-K10): no deploy, no production genesis, no production data-step run. Merge on: required check green + Rules job green (P4-K14 section) + Sim core job green (play-core Module 0 sections). On merge, batch A (§6) is dispatchable immediately.
