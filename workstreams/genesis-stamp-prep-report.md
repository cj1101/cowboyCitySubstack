# Go-live fix B-1 — Baseline stamp at genesis: build note

**Author:** Rafe (Muse Eng), production-chain owner · **Date:** 2026-10-21
**Branch:** `go-live/baseline-stamp` in `genesis-stamp-clone`, built on
local commit `3309f4a` whose tree (`fb6a4d27…`) was verified via the
GitHub API to equal remote master `7cd7286`'s tree (the PR #45 merge).
**Spec:** `workstreams/go-live-readiness.md` blocker B-1 (§2.4) +
runbook §3.3's two cases. **Gate:** 0a of the consolidated execution
order — this PR's merge SHA becomes the Step 3 candidate.
**Status:** built + verified locally; NOT pushed (Theo pushes/merges).

## What landed

1. **Stamp selection** (`lib/sim/baseline/registry.ts`):
   `ratifiedBaselineForGenesis(registry)` returns the registry's
   ratified version, or null when none is ratified. Multi-version
   ordering follows `citableBaselineVersion`'s (greatest in-force seq;
   a still-null `effectiveFromSeq` counts as in force from genesis).
2. **Genesis stamps at creation** (`lib/sim/genesis.ts`): `runGenesis`
   merges `{ baselineVersion, baselineDocHash }` — sourced from the
   registry entry, never a literal in the genesis path — into the
   world doc when a ratified version exists. When none exists, **no
   stamp fields are written at all**: the world doc is byte-for-byte
   the pre-stamp shape (runbook §3.3's unratified case; the projection
   may later arrive only via a logged Resolution Event). The registry
   is injectable via `GenesisOptions.baselineRegistry` (default: the
   production registry) so the unratified case is exercisable.
   `buildSimWorldDoc` itself is unchanged — the stamp lives in the
   genesis path, which owns the write set (readiness fix item 1's
   stated locus option).
3. **Post-commit assertion** (`lib/sim/genesis.ts`): after commit, the
   stored world doc's stamp must equal the registry's ratified
   version/hash — a silent omission now fails genesis loudly; in the
   unratified case the stored doc must carry no stamp fields.
4. **Projection at deps injection** (`lib/sim/baseline/registry.ts` +
   scripts): `projectBaselineStamp(registry, worldDoc)` is pure and
   fail-closed — it returns an effective registry whose stamped entry
   carries `effectiveFromSeq` = the world doc's genesis seq, only when
   the stamp names a registry-carried **ratified** version whose
   stored docHash equals the stamp's. Missing doc, missing fields,
   unknown version, draft version, or hash mismatch all return the
   registry unchanged, and the input registry is never mutated (its
   `effectiveFromSeq: null` is the pre-genesis fail-closed posture).
   Wired at the two landed injection entry points the readiness doc
   names: `scripts/sim-verify-log.ts` (projects from the world doc it
   already reads) and `scripts/sim-run-wake.ts` (reads
   `sim_world/current` through its own client before `runWake`; an
   unreadable doc leaves the registry unprojected and prints a warning
   naming the fallback — the fail-closed direction, never a silent
   pretence that the stamp applied). The Log page's display lookup
   (`app/log/page.tsx`) is not a deps-injection point and is untouched.

## Re-pin inventory (deliberate, each commented at the site)

- **sim-core CK1**: now asserts the standing world doc carries
  `baselineVersion: "world-baseline-1.0"` + the stored docHash. (The
  pre-B-1 posture — no such fields — was implicit; the re-pin makes
  the new posture explicit.)
- **sim-core CK4**: the production-registry assertions stand verbatim
  (status ratified, docHash pinned, `effectiveFromSeq` null,
  registry-alone selects nothing at seqs 1/9999) and a new block
  asserts the projection posture over the suite's own stamped world:
  projected → citable 1.0 from seq 1; the same world with the stamp
  fields deleted → projects nothing. The draft-registry fail-closed
  proofs below it (BASELINE_UNRATIFIED judgment rejection) are
  untouched and still fail closed.
- **Rules suite P1-G4**: NOT re-pinned — it asserts the genesis
  *entry's* `baseline: null`, and B-1 stamps the *world doc* only;
  the entry posture is unchanged by design (readiness fix item 4's
  conditional does not trigger).
- **No fixture field-set re-pins were needed**: no suite or script
  asserts the world doc's exact field set (fields are read
  individually everywhere; `firestore.rules` fences no world-doc
  keys — committer create/update is claim-gated only), and the
  genesis write-set digest recomputes over the stored docs, stamp
  included, on both sides.

## G-2 rider — INCLUDED (readiness §1.4 disposition (a))

Small and self-contained, as scoped: `tests/rules.test.ts` gains two
contexts — `fabric: true` with `fabricRole` **missing**, and with it
**misspelled** (`"commiter"`) — and denial assertions on both
claim-gated paths (committer-only `sim_world/current` update;
either-role `sim_fabric_status/current` create) inside the existing
P1-G1 block. Denials only; the assertions write nothing. No user docs
are seeded for the negative uids: both clauses are claim-only, so the
denials are attributable to the claim shape alone.

## Verification (local; emulator suites are CI's venue)

- `tsc --noEmit`: clean.
- Scoped ESLint (all touched files): 0 errors; 1 warning — the
  pre-existing `_dropped` unused-var in `tests/rules.test.ts`
  (untouched region, recorded in earlier rounds).
- `next build`: exit 0.
- Full pure battery green at landed counts — governance 59, banking
  54, situations 32, wake 27, closeout 29, chains 34, cat2 34, cat1
  all, defense 12, acq 14, market 27, lore 27 — plus the NEW
  `tests/baseline-stamp-harness.ts`: **9 checks** (stamp selection
  incl. the draft-selects-nothing case; stamped-doc shape sourced
  from the registry; projection citable from seq 1; non-mutation of
  the code registry; stamp-less worlds unchanged; hash-mismatch,
  unknown-version, and draft-registry projections all fail closed),
  chained into `test:sim` after the wake harness.
- Rules + Sim core emulator suites: CI's venue (not run locally —
  the sandbox emulator cannot boot). Expected CI evidence on the PR:
  CK1's stamp assertions, CK4's projection block, and the G-2
  denials, all inside the existing jobs; no job/protection changes.

## Carried

- The genesis Log entry's `baseline: null` posture stands (Phase 1
  assertion; the stamp is world-doc state, not entry content).
- Gate 0b (B-2 amendment + production-log recording) is Theo's
  record act, not this PR.
