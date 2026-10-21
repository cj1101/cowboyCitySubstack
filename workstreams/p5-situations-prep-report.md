# Phase 5 W3 — Situations + delegation: prep report (Vera)

Branch `p5/situations-delegation` off `phase5/assembly-base` (`b728863`,
master `b8ddf93` content). NOT pushed — Theo's API lane. Four commits,
all Vera-authored: situations module · delegation module · banking-
addendum absorption · harness + two harness-driven corrections.

**Verdict: the W3 module layer is complete to brief §§6–8 + App. steps
7–8.** `lib/sim/situations.ts` (builders, dedupe upsert, handling
transitions, §6.5 producers, §6.4 conversion, §8 silence, GAP-1
ripening-occasion producer) and `lib/sim/delegation.ts` (Dana's
five-step evaluation, narrower-of resolution, rule-fire payloads, the
shared composer validator). Harness `tests/situations-harness.ts`:
**32/32 checks green**, every composed plan through the real
`validatePlan` + `finalizePlan`; tsc + eslint clean. No edits to
registry, rules, indexes, dispatcher, or resolver — all Lead assembly,
listed in §3.

## 1. What the module guarantees, in brief language

- **Cards mint only from occasions.** A Situation is created inside a
  Resolution Event (a §6.5 producer: escalation / incident / proposal)
  or at a ripening (the GAP-1 producer, §4 below) — never by a sweep
  noticing a derived state. Felix's governing distinction, adopted
  verbatim as a header invariant in `situations.ts`.
- **Dedupe is structural + behavioral.** `dedupeKey` = sha256 over
  (sourceKind, sourceId, kind, audience); the deterministic doc ID
  incorporates the source event's seq, so a re-fired event refreshes
  its card, a newer event supersedes (old card badged in history,
  never actionable), and a stale event is ignored. A terminal
  namesake is history — re-fire never resurrects or clobbers it.
- **P5-K8 by construction.** The §6.4 conversion's pending patch
  contains exactly one key — `attentionSituationId`. Handling the
  Situation (any transition) cannot touch the pending; the flag
  clears only when the pending itself resolves. The harness proves
  the module half of P5-G12 (byte-identical pending after a full
  convert → handle lifecycle).
- **Delegation judges once, on the selected rule.** Dana's order:
  wait rules win outright → candidates by (specificity, priority,
  ruleId) → step 4 judges ONLY the selected candidate against live
  authority (narrowest of NPC / mandate / rule modes; per-named-cap
  min) → Tier B escalates for act-for-me and drafts for ask-first;
  over-cap refuses whole. A dead mandate on the best rule blocks —
  it does NOT fall through to a broader live rule (Petra §3.5's
  no-fall-through, generalized; flagged F3).
- **Silence is a first-class outcome with the approved copy.** One
  entry, `changes: []`, summary text `No response — <city>'s leader
  didn't say anything (seq N)` (banned words mechanically excluded
  in the harness); the plan's ONLY write is the situation doc
  (§8.1(3) state-hash discipline, exported as a checkable helper).
  P5-K9: teamless silence is attributed to the owner member record;
  an NPC present takes the NPC actor with its mandate citation.

## 2. Corrections the harness caught in my own design (record)

1. **Deterministic-ID supersede collision.** IDs derived from the
   dedupeKey alone made a superseding card land on the SAME path —
   `planWrite` would fold it and the superseded history card would
   never exist. IDs now incorporate the source seq
   (`sit_<hash28>_<seq>`); the residual degenerate case (null source
   seq + changed payload) refuses loudly
   (`DEDUPE_SUPERSEDE_COLLISION`) instead of folding silently.
2. **changes[] grammar.** My first transitions emitted `changes`
   for the situation doc; `validatePlan`'s F-02 reconciler resolves
   change fields ONLY inside the entry city's doc tree, so a
   top-level `sim_situations` claim reconciles with no write.
   Landed convention (defensive's `sim_cases`, lore's wiki entries):
   top-level record effects ride `recordsCreated`/`recordsUpdated`
   + the manifest write set. Transitions now return
   `changedFields` (for the caller's `planWrite`); fire/silence
   entries carry `changes: []`.

## 3. Assembly list for Rafe (W2 / W4 / W6 consumption)

**W2 wake wiring (brief §1.3 steps 4–6, as passes over THIS wake's
commits per the assembly plan §2.2 — never live scans):**

- Step 4 (auto-delegation pass): for each Situation committed this
  wake, load the audience city's active rules + a
  `HandlerAuthorityView` per candidate (npc doc + mandate root
  status + current version from Cato's `lib/npcs`) and call
  `evaluateDelegation({ situation, rules, authorityFor })` from
  `lib/sim/delegation.ts`. On `fire`: `applyDelegationFire(plan,
  snapshot, situation, fire, ctx)` (silence fires route into the
  §8 commit inside it). On `escalate` / `blocked-*`:
  `buildDelegationEvaluationEntry(...)` puts the refusal on the Log
  (§5.5 discipline). On `wait` / `no-match`: nothing — the card
  rests open. Budgets: delegated resolutions 5/wake/city, rule
  fires 10/wake (P5-K5) — caller-enforced; the evaluator is pure.
- Step 5 (envelope claim pass): fire kind `envelope` carries an
  `EnvelopeSpawnInput` minus the spawn-action fields
  (`spawnActionId`, `clientRequestId`, `availableAt`, `createdSeq`)
  — W2 completes it and calls Vera's `lib/envelopes` spawn path.
  Kind `delegated-action` carries the pre-validated structured
  action spec for the resolver-stage handler.
- Step 6 / steady state (§6.4): call `planAttentionConversion` for
  pendings in the SAME pass that sets `needsAttention` at attempt 3,
  and `planAttentionBackfill` once on the first Phase 5 wake over
  the flagged backlog. Both return `{ situation, pendingPatch }`;
  the caller plan-writes the situation (recordClass "state") and
  folds the patch into the pending write. Callers must NOT add
  `needsAttention` to the patch — the module's shape is the P5-K8
  guarantee.
- Ripening composition (GAP-1, §4): inside any ripening resolution,
  after the pending's own effects, call
  `occasionSpecFromPending(pending.payloadSpec)`; when non-null,
  build via `buildRipeningOccasionSituation(...)` and fold with
  `planSituationUpsert`/`applySituationUpsert` in the same plan.
  NO new dispatcher pass is needed or wanted.

**W4 surfaces:** situation shapes + transitions are the queue's
contract (`recordSelfHandling`, `recordDelegation`,
`returnSituationToOpen`, `markSituationHandled`,
`buildSilenceCommit`/`applySilenceCommit` for the owner's explicit
silence action). The composer binds `validateDelegationRuleDraft`
from `lib/sim/delegation.ts` — the SAME function W1/W6 rules tests
exercise (§7.3: one validator, two consumers). Rule saves persist
via `buildDelegationRuleVersion` + `computeRuleHash`.

**W1/W6 (not mine, named for completeness):** registry entries for
the P5-K6 action names; §9 rules for `sim_situations` /
`sim_delegation_rules` (member read/write per brief §9; the module
assumes rules caps: kind ≤ 80 chars — see F6); §10 equality indexes
(`dedupeKey`, audience+status, city+status); `tests/npc-core.test.ts`
assertions for the gate rows this module pre-proves in pure logic
(P5-G12's module half, dedupe, narrower-of, Tier B refusal, silence
shape) — the emulator halves (dispatcher passes, rules behavior)
remain W6's.

## 4. Felix banking addendum — resolutions (named per instruction)

Felix's governing distinction is ADOPTED VERBATIM (see §1).
Dedupe patterns E/P/X map onto the module as: E = single-event
sources (deterministic ID per event) · P = the ripening producer
below · X = episode keying on the incident builder.

- **GAP-1 — RESOLVED by ADDING the producer class** (Felix's
  preference + Theo's lean; my call as module owner). New exports in
  `situations.ts`: `RipeningOccasionSpec`, `occasionSpecFromPending`,
  `buildRipeningOccasionSituation`. The spec rides the pending's
  `payloadSpec.occasion` (set by the creating act — §3.4 installment
  creator, DIF premium machinery); the producer is invoked from the
  ripening Resolution Event itself, so atomicity and the causedBy
  chain hold and W2 needs no routing change. Kind `system`
  CONFIRMED for B2/B3/K1/K3/K4 (schedule markers from the world's
  own machinery). Zero-due occasions mint no card — the creating
  family simply does not call the builder; the ripening marker
  entry still lands. Pattern X keying CONFIRMED against §6.1's
  grammar: `episodeSourceId(subjectKey, episodeClass)`; the upsert
  accumulates (new card built from standing state, old badged
  superseded); episode cards close via `markSituationHandled` in
  the curing event, or supersede when a closing event replaces
  them (D2 over D1).
- **GAP-2 — RESOLVED by WIDENING spillover.** The class covers
  "events naming a city OR a chartered bank/corporation and its
  counterparties." `buildIncidentSituation` gained
  `subject: { kind: "city" | "corporation", id }` (stamped in
  `detail.subject`) + `episode` inputs. Covers B-08→borrower (B4),
  custodial rejection→bank owner (K2), B-10→depositors/borrowers/
  owner (D1/D2/B6/K5).
- **GAP-3 — DECLINE CONFIRMED.** Shareholders of a failed bank get
  NO card. No occasion names them, and a card with no decision on
  it violates §6.2's three-decisions contract — it would be a
  notification, and only `major` situations generate even a
  notifications pointer. Tier-(d)'s outcome is the liquidation /
  closing entries' public fact + the M-10/R-07 surface. Ruled
  explicitly, not left silent.
- **GAP-4 — CONFIRMED.** Felix's ◊ assignments (B3, B6,
  B7-rides-B6, K1, K4, D2 = `important`) read as event-class
  severities AS THEY BEAR ON THE RECIPIENT — the same event (B-10)
  is `major` for a depositor (D1) and `important` for a borrower
  whose terms didn't change (B6). Non-◊ stand: B4/K2/K5/D1 `major`;
  B1/B2/B5/K3 `routine`. Mechanical consequence, named as a PR-6
  build note: PR-6 must SET the major flag on the B-08, B-10, and
  custodial-rejection (failure-evidence) Log entries — a `major`
  card's causing entry carries the flag (§6.1). GAP-4 is joint
  with Osei at the gate; this is the producer-side half.
- **SPEC-1 — CONFIRMED: the DIF premium chain perpetuates AT
  RIPENING.** Felix's reading stands against V2-§1.3's letter
  ("perpetuated by each settlement"): with settlement-only
  perpetuation, "two consecutive periods unsettled" is
  unreachable and the delinquency ladder can never deepen.
  Successor mechanics, specified here for PR-6 item 12:
  (1) a premium pending's ripening lands the due marker entry
  (zero state effects), mints/updates the K3/K4 Situation via
  GAP-1 when the due figure > 0 (marker only when 0), and creates
  the successor pending — all inside the ripening Resolution
  Event via the landed ripening machinery. (2) Successor
  `requiredSeq` = the ripened pending's `requiredSeq` +
  PREMIUM_PERIOD_SEQS (schedule-anchored; coincides with the
  amendment's `lastPremiumSettledSeq + PREMIUM_PERIOD_SEQS` when
  periods settle on time, stays defined when none do).
  (3) The successor is generation-1 of a FRESH chain rooted at the
  ripening Resolution Event (new chainId; NOT generation+1 —
  `PENDING_GENERATION_CAP` = 3 would kill the chain at period 3;
  successive premiums are obligations of the standing charter, not
  a causal fan-out), its `payloadSpec` citing `premiumChain
  { bankCorporationId, periodIndex, previousPendingId }`, with a
  deterministic pendingId derived from (bank, period
  index/requiredSeq) so a re-driven ripening cannot double-schedule
  (PR-6 names the scheme; determinism is the requirement).
  (4) Settlement (B-12) creates NO pending — it pays arrears,
  terminals the K3 card, and states the ladder before/after.
  V2-§1.3's perpetuation sentence is superseded on this point;
  Felix conforms the amendment text on his next touch, or PR-6's
  body records the deviation with this ruling as its authority.
  (5) The chain perpetuates regardless of ladder state (suspended
  banks still accrue; zero-base periods produce markers only);
  charter surrender/liquidation ends the chain — no successor is
  scheduled by a ripening after the charter ends.
  NOT mine, carried for the record: BNK-D4 (Dana, Phase 5 data
  step), BNK-D15 (Koda at adoption; PR-6 builds owner-only),
  BNK-D5 (display-only credit standing), BNK-D18 (founding by
  adoption act), addendum item 15 export scope (Lead's ruling).

## 5. Flags for ratification (mine — confirm or replace at assembly)

- **F1 — Conversion severity.** The §6.4 system Situation is
  severity `important`, not `major`: a generation failure is an
  operational fact for the origin owner, not a major world event;
  `major` cards drive the notifications pointer (§6.2), which a
  stuck pending should not spam. Replace if the gate wants the
  pointer.
- **F2 — Specificity generalization.** Dana's named trio (city +
  kind + counterparty) is generalized to a count over all
  constraining match dimensions (cityIds, counterpartyCityIds,
  sourceKinds, situationKinds, rubars bound, tags). Ordering among
  equal-specificity rules is (priority asc, ruleId asc) — total and
  deterministic either way.
- **F3 — Step-4 no-cascade (generalized).** The evaluator judges
  only the selected candidate; a blocked/escalating best rule does
  not fall through to lesser matches. Generalized from Petra
  §3.5's dead-mandate rule to ALL step-4 refusals for consistency:
  the owner's most specific instruction governs the matter, and
  its refusal is the outcome (on the Log via the evaluation
  entry). This is the flag most likely to be contested — it is a
  deliberate reading, named here, not an accident.
- **F4 — ruleHash field set.** `{ ruleId, ownerUid, cityId,
  version, priority, match, handler, caps, alwaysWait, enabled }`
  (status/effectiveSeq excluded per §2.7's payload rule), mirroring
  the open question on Cato's mandateHash field set — ratify the
  pair together.
- **F5 — Silence actor when no-permission meets an NPC.** Where a
  city HAS NPCs but none holds permission for the matter, P5-K9's
  teamless reading extends: the silence is the OWNER's non-act
  (member actor), because no NPC was empowered to answer. The NPC
  actor is used only when an identified NPC's own mode or a
  silence-rule produced the non-response.
- **F6 — Kind bound.** `SITUATION_KIND_MAX_LENGTH = 80` is a build
  choice for W1's rules caps (the kind set is open by design;
  `STARTING_SITUATION_KINDS` is informational only, never a gate).
- **F7 — Refresh-vs-supersede materiality.** An upsert refreshes
  (updatedAt only) iff title/summary/detail/severity are
  canonically equal AND the source seq is unchanged; any material
  change or newer seq supersedes. A same-seq material change with
  a null source seq refuses (`DEDUPE_SUPERSEDE_COLLISION`, §2.1) —
  producers stamping real source seqs never meet it.
- **F8 — Delegated-action spec location.** A fire's actionable
  payload rides `detail.delegatedAction` ({ actionType,
  structuredAction, targetCityIds }), producer-stamped and read
  defensively (malformed = absent → envelope fire, never a
  half-trusted action). W2's resolver-stage dispatch consumes it;
  if the gate prefers a typed detail union, this is the seam.

## 6. Honest limits

The harness is pure-logic by design (the sandbox cannot run the
emulator; CI's Sim core job is the venue of record per addendum
A-1). What it does NOT prove: dispatcher pass integration (W2),
Firestore rules behavior for the two new collections (W1/W6),
envelope spawn execution against a live store (W2/W6), and the
UI queue (W4). Everything the module itself promises — shapes,
dedupe, conversion discipline, evaluation order, narrower-of,
composer refusals, silence shape/actors, citation completeness —
is asserted against the real landed engine code, not mocks.
