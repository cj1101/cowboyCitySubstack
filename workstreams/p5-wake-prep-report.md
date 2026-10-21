# PR-4 — Wake completion: prep report (Rafe, Phase 5 Build Lead)

Branch `phase5/wake-completion` on `phase5/situations-assembled`
(tip `d36088d`; PR #40's content by descent). NOT pushed — Theo
pushes via the API lane after tree verification. If PR #40 needs a
fix round, this branch's base shifts with it; nothing here depends
on #40's remote head beyond descent.

## 1. What landed

| File | Change |
|---|---|
| `lib/sim/wakeSteps.ts` | NEW (~1,300 lines). Pure wake-pass step resolvers + the envelope claim planner. |
| `lib/sim/wakePasses.ts` | NEW (~700 lines). The pass executor (`runWakePasses`), the delegated-action pipeline, the claim/requeue transactions. |
| `lib/sim/committer.ts` | `sourceKind` gains `"wake-pass"` (+ `passStep`/`cycleId` on the request; the input hash projects the step); Step 4 gains the wake-pass branch; the Step 3 pending-claim abort is fenced to the pending source kinds. |
| `lib/sim/dispatcher.ts` | `runWake` runs the passes after the undo phase over this wake's manifests; collects situation candidates + action-phase followups; `WakeSummary.passes`; `envelopeWorker` opt. |
| `lib/sim/snapshot.ts` | `wakeChangedWorld` learns pass commits (`passResolutionsCommitted`). |
| `lib/sim/delegation.ts` | One seam export: `readSituationActionSpec` (the module's defensive spec reader, shared with the trigger pass). No behavior change. |
| `lib/sim/rules/governance.ts` | F-E9 fix in `planEnvelopeSpawn` (+ `actionCreatedAtIso`); F3 decline completion in `situation.handle`. |
| `lib/sim/situations.ts` | `SituationHandling.outcomeVerb` (additive, canonical null); `recordSelfHandling` carries it; return-to-open clears it; delegation/silence constructors set null. |
| `firestore.rules` | `sim_actions` create gains the fenced fabric-committer branch for delegated-action docs (§6 below). |
| `tests/rules.test.ts` | 7 assertions pinning that fence. |
| `tests/wake-harness.ts` | NEW, 22 checks (W1–W22), chained into `test:sim`. |
| `tests/governance-harness.ts` | G12 (3 checks): the decline completion. 54 → 57. |
| `scripts/sim-run-wake.ts` | Step order documented as wired; `--worker-fixture` option. |
| `package.json` | `test:sim` chains the wake harness after the situations harness. |
| `README.md` | Test-table row, Phase 5 PR-4 section, changelog line (standing every-PR rule). |

## 2. The wake step order, as wired

1. **Confirmed actions**, each followed by its own action's ripeness
   scan (the landed Phase 2 order; scan candidates are the
   wake-start `WakeScanState` array — a pending created mid-wake is
   NOT a candidate until the next wake; harness W21).
2. **Queued undo ops** (unchanged).
3. **Phase 5 passes** (`runWakePasses`), in this order:
   a. **needsAttention conversions** — flagged pendings convert via
      the module's `planAttentionConversion`; converted cards JOIN
      this wake's delegation candidate set. (This pass also IS the
      first-Phase-5-wake backfill driver: the conversion is a pure
      function of the pending's stamp, so running it every wake over
      every flagged pending is the backfill; idempotence proven
      across two wakes, W12.)
   b. **Delegation pass** — for each Situation this wake's commits
      created or touched (candidates are read off the wake's own
      resolution manifests, never a live scan): `evaluateDelegation`
      → wait/no-match write NOTHING; escalate/blocked write the
      evaluation entry only; fire composes `applyDelegationFire`
      (an envelope fire merges the `planEnvelopeSpawn` core into the
      same plan — one write, the fire entry is the record).
   c. **Standing-team trigger pass** — over the no-match cards only:
      the city's team is contemplated in npcId order and the FIRST
      contemplated candidate governs (the F3 no-shopping discipline,
      W8). Postures: silent / unempowered (no contemplated
      candidate) / no-act (act-for-me but the card carries no action
      spec — a trigger match is a permission fact, not an act
      generator) / escalate-tier-b (evaluation entry only) / act /
      draft (ask-first → `awaiting_owner`).
   d. **Action-phase followups** — cards whose delegated action
      resolved/rejected during THIS wake's action phase complete
      (handled at the action's own `lastLogSeq`, or returned to
      open). Followups are also collected from later wakes: a
      delegated action deferred past its birth wake completes its
      card in the wake its action finally resolves.
   e. **§8 silence pass** — no-match cards whose posture is silent
      (the contemplated NPC) or unempowered (no candidate at all)
      commit `buildSilenceCommit` with the P5-K9 actor resolution
      (NPC actor + mandate citation, or the owner member actor with
      the approved "didn't say anything" copy). The step VERIFIES
      its posture claim against a fresh derivation and a fresh
      delegation evaluation before composing — a stale claim no-ops
      (W11). Person-scoped cards are excluded (no team answers for a
      person).
   f. **Envelope claim pass** — QUEUED/RUNNING envelopes planned by
      the pure claim planner (cap 5/wake), claimed in a transaction,
      executed by the operated worker, and completed by the terminal
      step INSIDE its own commit transaction (revalidation
      re-derived there, §4). Same-wake spawns are claimable (the
      queue is read after the delegation pass commits). Without a
      worker the pass claims NOTHING and reports the deferral —
      claiming without executing would burn attempts and strand
      envelopes RUNNING.
4. **Terminal snapshot refresh** iff the world changed — now
   including pass commits.

Passes never run ripeness scans, and the undo phase never triggers
a pass step: step products (a delegated action, a spawned envelope)
are the NEXT wake's business, except the same-wake envelope claim
the brief names. The passes run only when the wake is not aborted;
a pass-level integrity abort propagates to the wake summary.

**No scheduler exists.** `scripts/sim-run-wake.ts` remains an
operated, emulator-only runner; the §1.4 bars (no timers, no
autonomous evolution) are acceptance criteria and hold: nothing in
this PR creates work without an operated wake over player actions.

## 3. The pass machinery

- **Step specs are addresses, not payloads.** A `WakePassStep`
  carries ids (and, for envelope terminals, the worker's outcome).
  The committer's wake-pass branch re-derives the plan from the
  transaction's own snapshot via `resolveWakePassStep`; the
  recomputed plan governs wholesale (no plan-hash parity — the
  AGR philosophy generalized from delegated actions to every pass
  step), and a zero-entry recompute returns
  `{ status: "aborted", code: "PASS_STEP_NOOP" }` BEFORE seq
  allocation, so a no-op step consumes no seq and writes nothing.
  Every step plan carries exactly one summary entry, so a step's
  own summary seq is uniformly `counterHead.lastSeq + 1`.
- **Budgets live at the executor** (P5-K5; the modules stay pure):
  rule fires ≤ 10/wake; delegated resolutions ≤ 5/wake/city
  (delegation fires and trigger acts share the city's count);
  envelope claims ≤ 5/wake (the planner's cap). A capped fire
  writes nothing — the card rests open and the cap is recorded in
  the pass summary's notes.
- **The delegated-action pipeline** creates the real action doc
  (deterministic id; NPC actor citing the standing mandate;
  `structuredAction` merged with the `delegatedVia` citation;
  `threadRef` to the card; born `confirmed`), previews it through
  `computePreview`, stores the preview + a `confirmation` block
  whose `authorityType` is `"mandate"` — **the mandate IS the
  confirmation; no member confirmation step exists for a delegated
  act** (PR-2 §6's W4 contract) — then claims and commits it
  through the ordinary action path, so the authority stage re-runs
  inside the commit transaction (the TC-N09 bite). One stale-preview
  retry (release + re-preview); a second stale leaves the doc
  `confirmed` for a later wake's action phase (its followup is
  collected there). Commit failures release the claim with
  `lastAttempt` recorded.
- **Claim/requeue transactions** mirror the dispatcher's claim
  discipline over the committer's Firestore handle. Envelope
  records carry no `stateVersion` field; none is written. The
  claim object `{ cycleId, leaseId, claimedAt, leaseExpiresAt }`
  written by the claim transaction IS the run record (see §4,
  Vera flag 4).

## 4. PR-2 flags and Vera remainders — discharged

- **F-E8 DISCHARGED.** The claim planner classifies an envelope
  whose `lastError.code` is `cancelled_before_claim` (and status
  FAILED) as `terminal-without-output`: never claimed, never
  executed, no output fabricated. The envelopes module's
  completion invariants are NOT rewritten (harness W13).
- **F-E9 DISCHARGED BY FIX — it was a live bug.** Probe (two
  snapshots differing only in instant, resolved through the real
  `resolveAction`): an owner-direct `envelope.spawn` without an
  explicit `availableAt` produced DIFFERENT plan hashes, because
  the default was the snapshot instant — preview and commit can
  never share an instant, so **such a spawn could never commit**
  (an infinite stale-preview loop). The default in
  `planEnvelopeSpawn` is now the action doc's own stored
  `createdAt` (via `actionCreatedAtIso`, handling ISO string /
  Date / Timestamp shapes), identical at both derivations; an
  explicit `availableAt` still wins. Harness W20 pins two-instant
  parity. Named residual: the `snapshot.now` fallback remains only
  for action docs carrying no `createdAt` at all (legacy fixtures);
  pass spawns always pass `availableAt` explicitly and never reach
  it.
- **F-E7 DISCHARGED.** `buildTaskEnvelope` does not store a
  spawn-source field (nor `spawnActionId`/`clientRequestId` — the
  stored record is the builder's subset; the brief §9.4 rules
  fences describe a richer shape than the builder emits — recorded
  here as a divergence, not silently harmonized). Provenance for
  execution-time revalidation is therefore read from the spawn's
  own Log entry at `sim_log_entries/{pad12(env.createdSeq)}`: a
  `delegationFire` classification key ⇒ `"delegation-rule"` (the
  module's stored literal), else `"owner-direct"`.
- **Vera authority flag 2 remainder (claim-revalidation timing)
  DISCHARGED.** Revalidation is re-derived inside the terminal
  step — i.e., inside the terminal transaction's own derivation,
  from the stored NPC + mandate records as they stand at
  completion, projected through the STAGE's own projection
  (`projectAuthorityView`, which verifies the stored
  `mandateHash`). Note the dialect trap this avoids:
  `lib/authority/view.ts` reads the authority dialect and is only
  faithful for the module's own harness; over real (NPCS-dialect)
  docs it fails closed spuriously. The stage projection is the
  faithful reader and is what both the terminal step and the
  delegation step's mandate-version citation use. Harness: W15
  (mandate revoked between queue and claim → the worker's DONE
  never lands; FAILED + `authority_changed` + a FAILED output
  carrying the refusal), W16 (the E9 pair: rule-spawned refuses on
  a flip to silent; owner-direct survives the same flip).
- **Vera authority flag 4 remainder (`runStartSeq`) — position
  stated.** The landed envelope record carries no run/`runStartSeq`
  field (the builder drops it), and PR-4 adds none: the claim
  object written at claim time is the run record. If a future
  surface needs a run start SEQ, it is derivable from the claim
  transaction's own Log adjacency, not from a new field invented
  here.
- **`revocationReaches("ripening") === false` STANDS** — per the
  assembly instruction, stated not "fixed": the bite is the stage
  re-run at delegated-action commit plus this pass's terminal-step
  revalidation.

## 5. F3 — June's W4 flag: DECIDED, wired here

**Decision: declining a draft completes through the §6.3A decision
record.** `situation.handle` carrying `structuredAction.outcome =
"declined"` composes `markSituationHandled` into its own
resolution: the card lands `handled` with `resolvedSeq` = the
decision entry's own summary seq and `resolvedByResolutionId` = the
handle action's resolution. Grounds: the brief itself names
declining "a complete outcome (handled-by-declining, §6.1 state
machine)" whose draft "stays inert in history" (§11's
ConfirmationCard text), and §3.3 puts the outcome verb on the card
and in the Log — both now literally true: `handling.outcomeVerb`
is stored on the card (new additive field on `SituationHandling`;
`recordSelfHandling` carries it; return-to-open clears it, since a
returned card was not decided) and the entry's classification
carries `outcome: "declined"`. The §6.3A rule is not broken but
completed: for a decline, the decision IS the flow's resolution —
no further act exists that could mark the card — so the marking
fires inside the decision's own transaction, which is the rule's
own exception shape ("inside the transaction that logs the flow's
own resolution"). Without the verb, the record-and-stay-open
default is byte-for-byte unchanged; the verb does not widen the
§9.6 audience gate. Governance harness G12 pins all three halves.
Consequence for the gate: **P5-G11's confirmation half can close
on PR-4 (engine) + PR-5 (the decline control June wires to this
verb)** — it does not need a follow-up kind. PR-5 note: June's
awaiting_owner cards currently offer handle/silence and state that
drafts bind nothing; the decline affordance should now submit
`situation.handle` with `outcome: "declined"`.

## 6. Positions the wiring forced (each named)

1. **Pass placement after the undo phase.** The brief lists undo
   inside the wake steps and defers to Phase 2 §8 ordering; the
   landed order (actions → undo) is preserved, and passes consume
   action+scan commits only. Undo never triggers a pass step.
2. **Committer `wake-pass` source kind + recompute-governs +
   `PASS_STEP_NOOP`** (§3). The Step 3 pending-claim abort is
   fenced to `pending-ripening`/`pending-voiding` (it previously
   fired for every non-`action` kind and would have aborted every
   wake-pass commit as `PENDING_CLAIM_LOST`).
3. **A rules addition rides this PR** (the PR-3 "no rules change"
   posture does not survive contact with the delegated-action
   pipeline): the landed `sim_actions` create clause was
   member-only born-`received`, so NO identity could create an
   NPC-actor action doc. The new branch admits the fabric committer
   creating exactly the pass shape: `actor.type == 'npc'`,
   `source == 'wake-pass'`, `status == 'confirmed'`, and
   preview/confirmation/resolutionId/firstLogSeq/lastLogSeq all
   null. Member create posture untouched; 7 rules assertions pin
   the fence (CI Rules job is their venue; the emulator cannot run
   in the build sandbox).
4. **Delegated-action confirmation = the mandate** (§3).
5. **No ripeness scans after pass commits** — step products wait
   for the next wake (the brief's step order names none).
6. **Converted attention cards join the same wake's delegation
   candidates.**
7. **Trigger governance: first contemplated candidate governs**
   (F3 discipline extended to the trigger pass; W8).
8. **Ask-first draft surface = the `awaiting_owner` card + its Log
   entry.** No separate draft artifact exists in the landed
   shapes; flagged for PR-5/W4 + Koda review. (June's F3 is
   resolved independently of this — §5.)
9. **Silence scoping exclusions:** person-scoped cards; cards the
   rulebook waits/escalates/blocks/drafts; "no-act" cards (an
   act-for-me posture with no action spec gets NO §8 entry — §8
   answers permission facts, and that card's silence belongs to
   its owner's own `situation.silence`).
10. **The claim pass claims nothing without a worker** (§2f).
11. **FAILED terminals return the delegated card in-plan**
    (`returnSituationToOpen` composed into the terminal step when
    the card stands `delegated` citing the task); DONE/NEED-INFO
    leave the card delegated — the owner's move (W17).
12. **Spawn-refusal fallback inside fire composition:** if the
    envelope-spawn core refuses (or does not produce exactly one
    write), the fire degrades to the blocked
    handler-authority-changed evaluation entry — no transition, no
    envelope (W22).

## 7. Carried, named

- **NEED-INFO question-Situation linkage (P5-G8's exact-question
  card) DEFERRED to PR-7/W6.** A NEED-INFO terminal writes the
  outcome + entry carrying the worker's exact question; the
  question-Situation mint is W6's. Nothing is lost — the question
  text is in the output record and the entry.
- **Vera authority flag 5** (envelope results re-entering
  evaluation as seven-check citations): NOT wired in PR-4.
  Outputs land in their threads; citation re-entry is carried to
  the gate record as an open item.
- **PR-5 inputs from June's W4 report** (recorded for the PR-5
  assembly; no PR-4 action): F2 (envelope.spawn requires a
  standing NPC record — one-off persona spawns route to Settings
  in the UI; engine-side persona spawning is a fabric question,
  not forked), F4 (the composer passes
  `authorIsSittingMayor: false` — shared-city rules honestly
  refused pre-Phase-7 office records), F7 (rule fire-stats use a
  dot-path Log query — the gate should confirm the index posture).

## 8. Regression (local, 2026-10-20)

Full pure battery green: cat1 ✓ · defense 12 ✓ · chains 34 ✓ ·
cat2 34 ✓ · acq 14 ✓ · market 27 ✓ · lore 27 ✓ · close-out 29 ✓ ·
governance **57** ✓ · situations 32 ✓ · wake **22** ✓ · NPC core
36 ✓ · authority all-pass ✓ · envelopes all-pass ✓.
`npm run typecheck` green; ESLint clean on touched files (one
pre-existing warning in PR-3 code remains); `npm run build` green.
The emulator-backed suites (rules, sim-core) cannot execute in the
build sandbox (no Java / rules-upload 503 — the standing sandbox
blocker); CI's Rules + Sim core jobs are their venue, as with
every prior PR.

**P5-D6 untouched** — no version-pointer or undo-restore work
anywhere in this PR.

## 9. PR draft

**Title:** Phase 5 PR-4 — Wake completion: dispatcher passes, claim pass with execution-time revalidation, F-E9 fix, handled-by-declining

**Body:**

Phase 5 PR-4 of the seven-PR train (prep report:
`workstreams/p5-wake-prep-report.md`). The dispatcher's steps 4–6
land as passes over the wake's own commits — delegation,
standing-team trigger, §8 silence, needsAttention conversion +
backfill, and the envelope claim pass — behind a new committer
`wake-pass` source kind whose step specs are addresses re-derived
in-transaction. Wired order: actions+scans → undo → conversions →
delegation → trigger → followups → silence → claims (cap 5) →
refresh iff changed. No scheduler; the §1.4 bars hold.

Discharged here: F-E8 (cancelled_before_claim =
terminal-without-output at the planner; module invariants
untouched), **F-E9 (a real bug — owner-direct spawns without
`availableAt` could never commit; the default now derives from the
action's stored `createdAt`, parity pinned)**, F-E7 (provenance
from the spawn's Log entry), Vera's flag-2 remainder
(revalidation re-derived inside each terminal transaction) and
flag-4 remainder (position stated: the claim object is the run
record). `revocationReaches("ripening") === false` stands, as
recorded. **F3 decided + wired** (June's W4 flag): declining
completes through `situation.handle` + outcome verb `"declined"`
(handled-by-declining, §6.1; verb on the card and in the Log), so
P5-G11's confirmation half is closable at the gate on PR-4 + PR-5.

One rules addition: a fenced fabric-committer create branch for
delegated-action docs in `sim_actions` (+7 rules assertions) — the
landed member-only clause made delegated actions impossible for
any identity.

Regression: full pure battery green incl. governance 54 → 57,
situations 32, new wake harness 22 (chained into `test:sim`);
typecheck, lint, `next build` green. Emulator suites run in CI.

**Built, not live (A-2).** This PR is built, not live: the
P2-K15 production chain has not run — no production fabric user
(committer + worker roles), no production rules deploy, no
production indexes deploy, no production genesis, no operated
production wake path. Live-form gate rows (G1 fabric cycles, G8
worker claim/lease/crash, G9 committer fences, G12 wake-created
Situation) close only when that chain executes. P5-D6 is untouched
by this PR and remains PENDING Koda ratification.

---

## 10. CI fix round 1 (PR #41, Sim core) — Rafe

**Failure.** CI's Sim core job (PR #41, head f512995) failed where the
required Install job and the Rules job were green: sim-core ran green
through genesis / fund lifecycle / causality / baseline / stale
preview / ripening / ceilings / voiding, then crashed at
tests/sim-core.test.ts:999 inside runWake — SnapshotError
LOG_NOT_INITIALIZED out of materializeStepSnapshot
(wakePasses.ts:163 ← commitStep:190 ← runWakePasses:557). Log saved
at ~/workspace/cowboy-city/pr41-simcore-log.txt.

**Root cause (the dispatch hypothesis, corrected on evidence).** The
world was NOT uninitialized: line 999 is CK7e's third
invalid-preparation wake in a fully genesis'd world — headSeq()
reads sim_counters/log via the Admin SDK immediately before it. The
defect is the wake-step READ PLAN. wakeStepSeedPaths seeded
["sim_world/current", "sim_counters/head", …] — and no
sim_counters/head doc exists anywhere in the system (single grep
hit: that line). assembleSnapshot (resolver.ts) refuses any doc map
lacking sim_counters/log, so materializeStepSnapshot's first
buildSnapshot threw for EVERY step kind, on ANY world, the first
time any wake actually had a pass candidate. Every other read plan
in the resolver (collectActionReadPaths, collectRipeningReadPaths)
carries the counter; the step plan alone did not. CK7e is simply the
first emulator scenario to produce a candidate: its third failed
generation attempt flips the pending to needsAttention, the
attention pass (runWakePasses step 3½) finds it in the same wake,
and commitStep materializes the conversion step. Nothing earlier in
the suite — and nothing in the pure wake harness, which drives
resolveWakePassStep over hand-built fixture snapshots and never
runs the seed-path materialization — could reach the throw.

**Fix (one line, at the read-plan layer).** wakeStepSeedPaths now
seeds "sim_counters/log" in place of the phantom "sim_counters/head",
with the contract stated in a comment at the site. The step snapshot
then carries the real counter head, so step plans bind the head they
resolve against and the committer's in-transaction head comparison
includes the counter — the same treatment action and ripening
commits have always had. NO try/catch was added and no gate was
needed: candidate discovery was already correct (attention iterates
flagged pendings only; delegation/trigger/silence iterate this
wake's candidates; follow-ups iterate the wake's follow-ups; claim
steps are reached only after a real claim + worker outcome), so on
a genuinely uninitialized world every candidate set is empty, no
step materializes, and the wake stays byte-identical. Conversely, a
step WITH candidates on a world whose counter is missing is a
corrupt world, and LOG_NOT_INITIALIZED still throws loudly there —
deliberately not swallowed.

**Sibling sweep.** (a) Claim planner: planEnvelopeClaims is pure
over envelope records; envelope-terminal/failure steps share the
same materializeStepSnapshot path — fixed by the same line.
(b) Delegated-action pipeline (wakePasses.ts:252) builds its
snapshot from collectActionReadPaths — already carries the counter;
unaffected. (c) Attention read-back materialization (line 563) —
same path, same fix. (d) Terminal refresh: refreshSnapshotAfterWake
runs only when wakeChangedWorld reports commits (impossible on an
uninitialized world) and is failure-isolated by construction
(try/catch; the error is logged, never propagated). (e) Play-core
never ran in CI (it follows sim-core in the job); it exercises the
same dispatcher, so the fixed seam is its coverage too — it runs in
the fix round's CI.

**Regression pin.** Wake harness W23 (new): for all seven step
kinds, wakeStepSeedPaths must include sim_counters/log and must not
name sim_counters/head — the seed contract is now asserted in the
pure battery, at the exact seam that broke.

**Local regression (2026-10-20).** Wake harness 22 → 23 green;
full pure battery green at landed counts (cat1, defense 12,
chains 34, cat2 34, acq 14, market 27, lore 27, close-out 29,
governance 57, situations 32); tsc clean; ESLint clean on touched
files; next build green. Emulator suites (sim-core incl. CK7e,
play-core, rules) remain CI's venue — the sandbox emulator blocker
is unchanged.

### CI fix round 2 (PR #41, Sim core) — Rafe

**Failure.** Round 1's seed fix worked — steps materialize and
commit — and the suite advanced from line 999 to line 1035, where
CK7e's closing verifyOk failed: verifier finding STATE_MISSING,
"sim_situations/sit_7cfce0e57541acfadc4ff0bca76c_81 was written by
wake_silence_cac89d45f92a3be07269 but does not stand". Log saved at
~/workspace/cowboy-city/pr41-simcore-log-r2.txt. Install and Rules
jobs green again; only Sim core failed.

**The three dispatched leads, each tested against the code.**
(a) *Manifest claims a write the transaction never performed* —
DEAD. The committer builds the manifest's writeSet FROM finalWrites
(committer.ts: `writeSet = finalWrites.map(...)`) and applies those
same finalWrites in Step 7 of the SAME transaction (`tx.set` for
every non-delete write; `tx.set` creates-or-replaces, so even an
"update" op lands the full doc). A manifested state write is
applied atomically with its manifest; there is no code path where
the two diverge. (b) *Planned-vs-recomputed ID divergence* — DEAD
by construction, twice over. The situation ID has exactly one
computation (buildSituationDoc's): a pure function of the dedupe
key and the source seq, where the conversion's sourceSeq is the
pending's immutable originSeq (the `_81` suffix IS fund3's
originSeq); planAttentionConversion reads the link stamp off the
built card precisely so the stamp cannot diverge from the doc.
And under recompute-governs, the manifest and the applied write
both come from the in-transaction recomputed plan regardless.
(c) *A later step deleted the doc* — DEAD. The only sim deletes
are committer plan deletes (no plan deletes a situation) and
undo.ts erasures (which erase the manifest with the resolution;
no undo runs in CK7e). The verifier's own per-path writer sort
names wake_silence — not a deleter — as last writer, op ≠ delete.

**Positive proof the doc stands.** The silence step committed at
all only because its in-transaction recompute (resolveSilenceStep)
read the situation out of the transaction snapshot and returned a
non-empty plan: a missing doc yields emptyPlan → PASS_STEP_NOOP
abort → NO manifest. The wake_silence manifest exists, so the doc
stood at silence-commit time; nothing after it in CK7e touches
sim_situations (the final wake ripens the pending — P5-K8's patch
lands on the pending only — and the card rests terminal-silent).

**Root cause — the test's world assembly is stale, not the
engine, not the verifier.** tests/sim-core.test.ts `assembleWorld`
collects stateDocs from a fixed list written in Phase 2 (cities +
subcollections, allocations, pendings, publications, intel,
character extensions). `sim_situations` was never added: no
sim-core scenario wrote the collection until PR-4's passes began
converting CK7e's flagged pending (attention creates the card;
silence updates it in the same wake). verifyStandingLog's
bijection compares manifest writeSets (recordClass state/pending)
against the CALLER-SUPPLIED stateDocs; a written-but-uncollected
collection is indistinguishable from a vanished doc, and
STATE_MISSING is the correct report for the input it was given.
The verifier is right; its test-side input predates Phase 5. The
pure harnesses were never exposed: they hand-build their
StandingWorld inputs and include what they write (the governance
harness's verifyWorld carries sim_npcs + sim_mandates/versions).

**Fix (one line, at the indicted layer — the test).**
assembleWorld now also collects `sim_situations`, with a comment
stating the discipline: stateDocs covers every collection this
venue's resolutions can write; sim_task_envelopes /
sim_task_outputs join the list in the same change that first
makes a scenario here write them. NO lib/ code changes in this
round — the engine, committer, and verifier are untouched, and
the verifier is deliberately NOT taught to ignore uncollected
collections: STATE_MISSING is the undo-erasure tripwire, and
blinding it to whole collections would defeat it.

**Sweep of the other step kinds for the same class.** Every
wake-step state-class write, by collection: attention →
sim_situations (create) + sim_pending_consequences (collected);
delegation fire → sim_task_envelopes (the spawn core's single
write, re-claimed "state" at wakeSteps.ts:613) + sim_situations
(transition); trigger → sim_situations (transition) + the
delegated action's own resolution (its handler's writes, all in
collections its venue collects); silence → sim_situations;
envelope-terminal → sim_task_outputs + sim_task_envelopes (+ a
sim_situations return-to-open on FAILED); envelope-failure →
sim_task_envelopes + a system sim_situations card;
situation-followup → sim_situations. In the CK7e fixture world
only attention + silence can fire (no NPCs, teams, rules, or
envelopes exist to contemplate), so sim_situations is the
complete set for this venue today; envelopes/outputs get their
standing-state coverage in tests/npc-core.test.ts, the Phase 5
-native suite (PR-7 wiring per countersign A-1). play-core has no
verifyStandingLog input at all — no second copy of the stale
list exists.

**Pin.** None added to the pure battery, deliberately: the seam
is "an emulator test's hand-maintained collection list vs the set
of collections manifested resolutions can write" — a pure check
could only re-list the collections and drift against the very
list it guards. This seam is emulator-venue only; CI's sim-core
suite is the pin (it now drives a manifested sim_situations
write end-to-end and asserts the standing Log verifies clean).

**Local regression (2026-10-20).** Full pure battery green at
landed counts (cat1, defense 12, chains 34, cat2 34, acq 14,
market 27, lore 27, close-out 29, governance 57, situations 32,
wake 23); tsc clean; ESLint clean on the touched test; next build
green. Emulator suites remain CI's venue — CK7e's closing
verifyOk is the case to watch in this round.
