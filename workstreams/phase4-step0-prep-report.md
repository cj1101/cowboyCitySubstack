# Phase 4 Step 0 — Engine Hardening Prep Report

**Author:** Rafe (Muse Eng), Phase 4 Step 0 Build Lead
**Date:** 2026-10-19
**Branch:** `phase4/step0-engine-hardening` (base: Phase 3 clone tip `8239716`, post-merge master content; PR #24 merged, master `7ef47d2`)
**Authority:** Dana's `phase4-build-prep-report.md` P4-K17 / §2.4 step 0, fixtures §4.0; Nadia's `systems-integration-review.md` F-01/F-02/F-07; spec of record **systems-spec v2 + Banking Rider 1** (acceptance signed by Theo 2026-10-18).
**Scope honored:** `lib/sim/**` + `tests/sim-core.test.ts` + README + this report. No dashboard/UI files, no `firestore.rules`, no `firestore.indexes.json` touched — none of the three fixes required them.

## Commits (local, author Rafe — NOT pushed; Theo pushes)

1. `c9f818a` — F-02: planWrite folds; validatePlan reconciles changes against folded writes.
2. `973dc04` — F-01: contracted read plans — descriptor hook, collection queries, manifest binding.
3. `c2ddc63` — F-07: prepared payloads bound end-to-end (action-path parity with ripening).
4. (this commit) — §4.0 fixtures in the Sim core suite + CK3 grep-list addition + README.

## 1. F-02 — planWrite merge semantics

**The flaw (as landed):** `planWrite` REPLACED any existing write for a path, with the replacement computed against the snapshot. `resolveVoiding` was the in-repo proof: two void effects on one city ⇒ the state kept only the last effect while the single rule-effect entry's `changes[]` claimed both.

**Changes:**
- `lib/sim/rules/planHelpers.ts` — the plan holds at most one write per path. `planWrite` now **folds**: changed-field sets union (order-stable), the op is derived from the NET effect vs. the snapshot (incl. create-after-delete corner cases), the first write's recordClass is preserved. New **`plannedDoc(plan, snapshot, path)`** (the plan's pending after-state, else the snapshot doc) and **`planMutate(...)`** so callers compute after-states against the planned doc — the contract is stated in the file header: any read feeding a `planWrite` for the same path MUST come from `plannedDoc`.
- `lib/sim/resolver.ts` `resolveVoiding` — effects compose against `plannedDoc`; changes are grouped **per effect city** (one rule-effect entry per city, each scoped to its own cityId per the TC-E02 chaining convention). The no-applicable-effect case keeps the landed shape (one entry, `changes: []`, target city). Single-city/single-effect behavior (CK7d) is unchanged in shape.
- `lib/sim/rules/pendingRules.ts` `applyRipeningEffect` — `applyStatDelta` and the fund-disbursement block read `before` values from `plannedDoc` (the file's comment already claimed folding; the helper now honors it).
- `validatePlan` (resolver) gains the **F-02 reconciliation**, run whenever the caller supplies the snapshot (new optional `opts.snapshot`; threaded at all four resolver call sites and the committer's §5.6 in-transaction re-run, which passes the tx snapshot): every entry change resolves to a (doc path, field) target — city-doc field or `structures/<id>.`-style subcollection field, the TC-E02 convention — and the changes per target must chain: first `before` == snapshot value, each next `before` == previous `after`, last `after` == the folded write's final value. Values compare through the engine's canonical-JSON + Firestore projection, undefined ≡ null. A change with no reconciling write fails the plan. Forward direction only: writes without changes stay legitimate (creation claims ride `recordsCreated`).

## 2. F-01 — read-plan contract

**The gap (as landed):** resolution read sets were doc paths only, derived partly from actor-supplied citations; collection/graph reads (order book, ballots, holdings) were unrepresentable inside the snapshot integrity boundary.

**Changes:**
- `lib/sim/state.ts` — `CollectionQuerySpec` (equality filters + orderBy + limit; the order-book/ballot/holdings shapes) and `SnapshotQueryRecord` (spec + ordered result paths + digest). `SimSnapshot` gains `queries: SnapshotQueryRecord[]`.
- `lib/sim/rules/registry.ts` — `RuleDescriptor.readPlan?` hook. Seeds = the action + the already-read base-path docs (**stored records**, e.g. seed docs let a hook derive a listing's corporation doc). Resolver-side code: an actor's `citations.recordPaths` remain in the base set as additional reliance declarations (their undo-graph role) but can never narrow or replace the hook's reads. New fixture descriptor **FIXTURE-ORDERBOOK** (§4.0): read plan declares the `resting-orders` query over `sim_cities/<cityId>/structures` (`status == "resting"`, order by `priceRubars` asc, limit 50); the handler reads ONLY the materialized result set from the snapshot (absent record ⇒ `READ_PLAN_MISSING` rejection) and derives resting count/total onto the city doc.
- `lib/sim/resolver.ts` — `collectActionReadPlan(action, seedDocs)` (base paths ∪ hook paths/queries), `materializeSnapshot(reader, queryReader, plan, now)` (executes queries outside the pure resolver, binds result docs into `docs`/`heads` like doc-gets, records spec+paths+digest), `digestQueryResults` (sha256 over spec + ordered (path, head-hash) pairs). `buildSnapshot`/`snapshotFromDocs` signatures unchanged (`queries: []`).
- `lib/sim/readers.ts` (new) — `firestoreReader` (moved; dispatcher re-exports it for compatibility), `buildFirestoreQuery` (one builder so a spec means the same read everywhere), `firestoreQueryReader`.
- `lib/sim/dispatcher.ts` — `previewAction` and the wake's action loop resolve against a two-phase materialized snapshot (seed docs → hook → materialize). Commit requests carry `queryRecords` + result paths inside `snapshotPaths`; stale re-previews re-materialize identically. `DispatcherDeps.queryReader` optional (defaults to the committer-identity reader).
- `lib/sim/committer.ts` — manifest input set gains **`queryInputs`** (additive manifest field; the verifier's field reads are unaffected — verified against `verify.ts`, which reads specific fields only). Result docs are re-read and head-compared inside the transaction exactly like declared doc reads.

**Residual (deferred, with reason):** in-transaction RE-EXECUTION of the query itself (membership re-check under the tx) is **not** implemented: the repo's pinned `@firebase/firestore` exposes no typed `Transaction.get(Query)` overload (checked against the installed package's `index.d.ts` — DocumentReference overload only). Membership is instead bound at the dispatcher's materialization in the **same wake step** (milliseconds before commit; a membership change between preview and wake already goes stale via planHash), result-doc content is head-verified in-tx, and the spec+digest are manifest-recorded for audit/undo. Closing the residual rides the already-scheduled client-SDK upgrade (**PR-F**, firebase 11→13): when the typed query read exists, the committer gains a step-3.5 re-execution + digest compare folding into the existing stale condition. The `CommitRequest.queryRecords` field + manifest shape are already in place for it.

**Ripening read plans** stay doc-path-only in Step 0, deliberately: `collectRipeningReadPaths` is already derived from the stored pending doc — the pattern Nadia's review calls safe. The materialization machinery is shared, so a future pending kind can declare queries without new plumbing.

## 3. F-07 — prepared-payload plumbing (action path)

**The gap (as landed):** only ripenings carried prepared payloads; `previewAction` accepted none and the dispatcher resolved actions without one — parity was conventional, not structural.

**Changes:**
- `lib/sim/preview.ts` — `computePreviewHash` binds `preparedInputHash` (the payload's self-declared hash); the stored preview records `preparedInputHash`. The Phase 2 round-4 action-doc-head exclusion is untouched.
- `lib/sim/state.ts` — `SimAction` gains optional `preparedPayload` / `preparedInputHash` (dispatcher-written at preview time; **never set by intake**).
- `lib/sim/dispatcher.ts` — `previewAction(deps, id, { now, prepared? })` forwards the payload into the preview and stores payload + hash on the action doc. `runWake` reads the **stored** payload from the claimed action (no fresh worker call), refuses with `PREPARED_HASH_MISMATCH` (action released back to `confirmed`, recorded in `actionsFailed`) when the stored hash field disagrees with the payload's own hash, and passes the payload into the commit-mode resolve, BOTH stale re-preview paths (same payload the member confirmed against), and `commitResolution` (`prepared` + `preparedInputHash`, which the committer's `computeCommitInputHash` already bound).
- `lib/sim/committer.ts` — manifest stores **`preparedPayload`** (both action and ripening commits): replay re-runs from the manifest record, never a worker call (banking V-B7).
- `lib/sim/rules/registry.ts` — new fixture descriptor **FIXTURE-JUDGMENT** (§4.0): resolves ONLY from `ctx.prepared` — no payload ⇒ `PREPARED_PAYLOAD_REQUIRED`; `classification.creditRubars` outside [1, 5000] ⇒ `PREPARED_PAYLOAD_OUT_OF_BOUNDS`. The handler never reads `structuredAction` judgment fields; the FIXTURE-MARKET `params.judgment` pattern stays fixture-only, as §2.4 requires.
- **No cash-only assumption** anywhere in the new plumbing (Vera's acceptance instruction): the payload binding is source-agnostic; nothing in F-01/F-02/F-07 types, hooks, or fixtures presumes where credited value comes from.

## 4. Wake-order verification rider (P4-K24)

Verified against the merged tree before building: dispatcher order is **actions (each commit followed by its one scan) → queued undo ops → terminal snapshot refresh** (`lib/sim/snapshotRefresh.ts`, Phase 3 §3.2, only on world-changing wakes) — the Phase 2 round-4 order, preserved untouched by Step 0. Locked by **S0-ORDER** in the Sim core suite: a dependent action (citing its target) and an undo op for that target queued for the SAME wake ⇒ the dependent commits first, the op is then **refused** (target no longer a suffix), both actions stand, and `sim_dashboard_snapshots/current.asOfSeq == headSeq` after the wake — proving the snapshot hook ran last. If the phases ever swap back, the undo erases the target and the section fails.

## 5. New tests (`tests/sim-core.test.ts`, all additive; nothing weakened)

- **CK3 grep list** gains `lib/sim/readers.ts` (same scheduler/Admin-SDK prohibitions) — a strengthening.
- **S0-F02 (pure)** — `resolveVoiding` over a handcrafted snapshot: two effects on one field + one on another fold into one write (treasury 100→142, culture 40→41), changes chain [100→130→142]; `validatePlan` passes on the real plan and throws `PlanValidationError` (F-02) on a tampered copy.
- **S0-F02 (e2e)** — CK7d-shaped voiding with TWO void effects (treasury +30, culture +1): both land; the effect entry's changes carry both fields; standing world verifies.
- **S0-F01 (e2e)** — three seeded structures (resting 100, resting 250, built 999); the action cites only the 100 order. Commit ⇒ `fixtureRestingOrders == 2`, `fixtureOrderBookRubars == 350` (citations did not narrow the read); manifest `queryInputs[0].resultPaths` == both resting paths in price order, digest 64-hex. Stale leg: preview, flip one structure to `built`, confirm, wake ⇒ stale (no entries, state untouched); re-preview + confirm + wake ⇒ commits with count 1 / total 100. Seeded docs deleted afterwards; world verifies.
- **S0-F07 (e2e)** — no-payload judgment ⇒ rejected `PREPARED_PAYLOAD_REQUIRED`, treasury unchanged. Payload A (1200 R) ⇒ preview + action doc + manifest all bind `s0-judg-a`; treasury +1200 exactly. Swap leg: previewed with A2 (700), stored payload replaced by B2 (800) pre-wake ⇒ stale, nothing lands; re-preview with B2 ⇒ commits +800 exactly.
- **S0-ORDER** — the wake-order lock described in §4 above.

## 6. Local verification (sandbox limits apply)

- `tsc --noEmit`: **clean** after each commit.
- ESLint over `lib/sim/**` + `tests/sim-core.test.ts`: **clean**.
- Pure tsx harnesses (run, green, then deleted — the emulator cannot run in this sandbox): F-02 (multi-effect voiding folds with chained changes; stale-computed changes rejected; `planMutate` composes), F-01 (descriptor-sourced query resolves the full set despite a subset citation; digest recompute matches and moves on membership change), F-07 (no payload ⇒ rejected with member-supplied judgment ignored; payload binds preview hash; swap changes planHash; bounds enforced).
- `npm run build`: **green** (full Next build at close-out).
- The emulator assertions (all S0 sections + the full Phase 2 suite regression) are **CI's venue** — the non-required `Sim core tests (non-required)` job — exactly as every prior phase. No assertion anywhere was weakened; every change to existing behavior is additive or a bug fix with a fixture proving the before/after.

## 7. Push posture for Theo

- Branch `phase4/step0-engine-hardening`, 4 local commits on top of `8239716` in `~/workspace/cowboy-city/phase4-clone`. **Not pushed** (per assignment).
- Push via the Git Data API under the **payload-delta rule**: compute each commit's delta against its own parent and apply onto current remote master (`7ef47d2` at assignment time — re-read the remote head at push time). First verify the phase3-clone tip tree equals remote master, as planned; if master has moved, the deltas are confined to `lib/sim/**`, `tests/sim-core.test.ts`, `README.md`, `workstreams/phase4-step0-prep-report.md` — no overlap expected with anything else in flight.
- README in this PR: Phase 4 Step 0 status paragraph + dated Changelog line (done, commit 4).
- Expected CI: required `Install · Typecheck · Lint · Build` + non-required `Rules tests` + `Sim core tests` (the S0 sections run there). **Do not** add either emulator job to branch protection in this PR.
- Merge on green per standing delegation. **Module 0 starts only after this PR is green in CI** (P4-K17).
- Koda noting items riding this PR's review, per standing pattern: systems-spec v2 + Banking Rider 1 acceptance (already signed by Theo), P2-K16.

---

## Fix round 1 — PR #25 Sim core failure (Rafe, 2026-10-19)

**CI result that triggered this round:** required build GREEN, Rules GREEN,
Sim core FAILED on exactly one assertion — S0-F02 (e2e),
`tests/sim-core.test.ts:1604`: "second void effect on the same doc landed
too (F-02)", actual `null`, expected `1`. The S0-F02 pure harness passed in
the same run and the entire Phase 2 battery passed.

**Verdict: TEST bug. The engine is correct; no engine code changed.**

**Root cause, derived from the scenario's own numbers (CK7 standard):**

1. The e2e fixture's second void effect was `stats.culture` delta +1, and
   the assertion was `cityStats("cityA").culture === cultureBefore + 1`
   where `cultureBefore` was read from the live city doc and cast
   `as number`.
2. Under the landed genesis template (`lib/sim/template.ts`, decision
   K-3 — Vera-agreed), all eight allocatable indices are **null** at
   genesis ("present keys, no invented value") and stay null until the
   Phase 4 allocation commit; only the bookkeeping counts
   (households/housingUnits/treasuryRubars) are numeric zeroes. So
   `cultureBefore` was `null`, and the assertion's "expected 1" was the
   JavaScript artifact `null + 1 === 1` — not a scenario number.
3. `resolveVoiding` applies a void stat-delta only when the field's
   current value is a number: `if (typeof before !== "number") continue;`.
   A delta against an unallocated index is skipped, and — critically for
   the F-02 contract — the skipped effect produces **no change entry**, so
   the Log claims exactly what state holds. This skip is pre-existing
   Phase 2 semantics (verified verbatim in the resolver at `8239716`,
   before Step 0 touched the function); the ripening path's posture is
   the same rule stated louder (it throws on a non-numeric field). It is
   the null-honesty rule: the engine never invents an index value. Making
   the engine "fix" this (treat null as 0) would fabricate an allocation
   CJ's even-start design explicitly defers to the owner.
4. Therefore the fixture chose a field that cannot legally move
   pre-allocation. Both halves of the e2e's F-02 claim were unpassable
   under any correct engine: the value assertion (above) and the
   changes-list assertion (`["stats.treasuryRubars", "stats.culture"]` —
   a skipped effect logs no change).

**Local evidence (pure tsx harness against a genesis-shaped snapshot —
stats exactly `templateStats()`, run in the sandbox where the resolver is
pure):**

- Case A — the failing fixture's exact effects (treasury +30, culture +1):
  folded write = one write for `sim_cities/cityA`, treasury 0→30, culture
  still `null`; changes = `[["stats.treasuryRubars", 0, 30]]` only. The
  fold (the actual Step 0 change) works; the culture effect is skipped by
  the rule above.
- Case B — the fixed effects (treasury +30, households +1): folded write
  has treasury 30 **and** households 0→1; changes =
  `[["stats.treasuryRubars", 0, 30], ["stats.households", 0, 1]]`, in
  order. Two effects, one doc, both land, Log matches state — the F-02
  contract, exercised against fields that can move at genesis.

**The fix (commit `4ec7e90`, tests only):**

- Second void effect retargeted `stats.culture +1` → `stats.households +1`
  (true bookkeeping zero, numeric from genesis, same city doc — the
  two-effects-one-doc claim is preserved in full; the *same-field*
  chaining case remains covered by the S0-F02 pure fixture, treasury
  30+12 chained off a numeric snapshot).
- `cultureBefore` capture replaced by `householdsBefore`, with a new
  guard assertion that it is a number (fails loudly if the template
  posture ever changes, instead of silently re-entering null arithmetic).
- Value assertion: `households === householdsBefore + 1` (households is
  read dynamically; no other suite section reads `stats.households`, so
  the +1 perturbs nothing downstream).
- Changes-list assertion updated to
  `["stats.treasuryRubars", "stats.households"]`.
- One assertion **added** (strengthening, not weakening): after the
  voiding, `stats.culture` is still `null` — pinning the semantics that
  caused the original failure, so a future engine change that starts
  inventing index values fails this suite.
- The e2e block comment now records why an index field cannot be used
  here, so the fixture is not "fixed back" later.

**No assertion was weakened; no engine file was touched.** Local checks:
`tsc --noEmit` clean, ESLint over `tests/sim-core.test.ts` clean. The e2e
itself remains CI's venue (sandbox cannot run the emulator): Theo to push
`4ec7e90` + this report commit onto PR #25's branch and re-read the Sim
core job.

## Fix round 2 — PR #25 Sim core failure, second exposure (Rafe, 2026-10-19)

**CI result that triggered this round:** on head `f2e1360` (the fix-round-1
push), required build GREEN, Rules GREEN, Sim core FAILED on exactly one
assertion — S0-F01 (e2e), `tests/sim-core.test.ts:1659`: "orderbook action
committed", actual `false`, expected `true`. S0-F02 pure AND e2e passed in
the same run (fix round 1 verified in CI). The full log is preserved at
`~/workspace/cowboy-city/pr25-simcore-log-r2.txt`. This is the sequential-
exposure pattern the round-1 report anticipated: the suite aborts at the
first failure, so S0-F01/F-07/ORDER had never executed in CI before this
run. S0-F07 and S0-ORDER still have not — if a later fixture surfaces in
the next run, it will be the same pattern, not a new regression class.

**Verdict: ENGINE bug — in Step 0's own F-01 plumbing. The test and the
fixture are correct; no assertion changed.**

**Root cause, proven in pure logic before any fix was attempted** (harness
mirroring the two production snapshot paths over one in-memory store —
the suite's own seeded values: ob1 resting/100, ob2 resting/250, ob3
built/999, action citing only ob1):

1. Dispatcher path (`snapshotForAction` → `materializeSnapshot`): the
   plan resolves exactly as the F-01 contract requires — the query binds
   the full resting set despite the subset citation, changes
   `fixtureRestingOrders: null → 2`, `fixtureOrderBookRubars: null → 350`.
   The test's preview/confirm therefore stored a good plan; `previewPlanHash`
   is sound. (This is also why the failure was silent: nothing about the
   preview looks wrong.)
2. Committer path (`commitResolution` step 4): the in-transaction
   recompute runs over `snapshotFromDocs(docs, now)`, which hardcoded
   `queries: []`. The orderbook handler looks up its materialized record
   in `ctx.snapshot.queries`, finds none, and returns the
   `READ_PLAN_MISSING` rejection plan. Recomputed planHash ≠ the
   dispatcher's planHash, and the committer's step-4 comparison returns
   `{ status: "stale-preview" }` — a *spurious* stale: the world never
   moved. The dispatcher files the action under `actionsStale`, stores
   a fresh (identical) preview, and the action never commits. Hence
   `actionsCommitted` excludes it, deterministically, on every wake.
3. The carrying contract existed and was documented: `CommitRequest.
   queryRecords` states the records ride the request so the transaction
   can re-verify the query read "exactly like a doc read", and the
   dispatcher passes `queryRecords: snapshot.queries`. Only the last
   hop was missing — `commitResolution` never handed them to the
   snapshot its recompute runs over. No query-plan action of any kind
   could ever have committed; FIXTURE-ORDERBOOK is simply the first
   query-plan action kind in the system, which is why Phase 2 (doc-path
   read plans only) never exposed it.

**The fix** (commit `97d7c6e`, engine only):

- `lib/sim/resolver.ts` — `snapshotFromDocs(docs, now, queries = [])`
  now takes the plan's `SnapshotQueryRecord[]` and passes them to
  `assembleSnapshot`. Comment records the contract: result DOCS are the
  transaction's own re-reads; the records are what let the recompute
  find its materialized set.
- `lib/sim/committer.ts` — step 4 builds the tx snapshot as
  `snapshotFromDocs(docs, now, req.queryRecords ?? [])`.
- `lib/sim/readers.ts` — header comment corrected: it claimed the
  committer re-executes queries in-transaction via
  `buildFirestoreQuery`; it never did (that is the PR-F residual), and
  the stale claim is part of how the missing hop read as covered.

**Why parity is safe, not just hopeful:** with the records re-attached,
the recompute handler derives count/total from `snapshot.docs` — the
transaction's re-reads — keyed by the recorded `resultPaths`. Any
content change to a result doc since materialization is caught twice:
the head comparison (`expectedStateHeads` vs tx heads — every result
doc rides `snapshotPaths`) and the planHash comparison itself. A result
doc deleted since materialization reads back `null` and trips the same
checks. What remains uncaught in-transaction is only a *new* doc
joining the result set between the dispatcher's materialization and
the commit — the already-documented PR-F residual (this pinned SDK's
Transaction has no typed query read), unchanged by this fix and not
worsened by it: membership changes between **preview and wake** are
caught by the dispatcher's own planHash comparison over a fresh
materialization, which is exactly the S0-F01 e2e's second half, and
that path never reaches the committer. F-02's null-honesty and the
"citations never source a money/authority read" rule are untouched —
the handler, the read-plan hook, and the seeds are all unchanged.

**Evidence:**

- Pure harness (pre-fix tree): dispatcher plan resolved with planHash
  `832092fc…`; committer-shaped recompute rejected `READ_PLAN_MISSING`,
  planHash `905191e4…`, parity false. Failure reproduced without the
  emulator, matching CI's symptom chain end for end.
- Pure harness (post-fix tree): committer recompute resolves with
  planHash `832092fc…` — byte-identical to the dispatcher plan.
- New suite fixture (commit `91c9bb9`): "S0-F01 pure" pins this
  contract inside `tests/sim-core.test.ts` itself — parity with the
  records re-attached, `READ_PLAN_MISSING` without — so a future
  refactor that drops the records fails loudly at this fixture instead
  of surfacing as a silently-never-committing wake. All additive; no
  existing assertion touched.
- `tsc --noEmit` clean; scoped ESLint clean over the four touched
  files. Full `npm run build` was green pre-round and the engine delta
  is three files; the e2e re-proof is the Sim core CI job on the
  updated PR (the sandbox cannot run the emulator — standing finding).

**Commits this round (local, author Rafe — Theo pushes):**
`97d7c6e` engine fix; `91c9bb9` suite pure fixture; this report section.
The branch tip for the push is the report commit following this section.
