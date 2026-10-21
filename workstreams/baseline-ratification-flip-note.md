# World Baseline 1.0 — ratification flip: build note (Rafe, Phase 5 Build Lead)

Branch `baseline/ratify-1.0` in `baseline-flip-clone`, off current
master `d30cc4f`. NOT pushed — Theo verifies and pushes.

## The act this records

CJ ratified the World Baseline in the War Room on 2026-10-20 (Option A,
Vera's recommendation in `workstreams/baseline-ratification-pack.md`):
§1 of `workstreams/world-baseline-ratification-draft.md` is now
Baseline 1.0. Under the Baseline's own precedence (§1.2.2.5) CJ's
ruling is tier-1 and is itself the ratifying act (this closes the
P2-K2 process call); this PR is the reviewed code change that makes
the registry match the ruling — the pack §3 form: one line, its own
PR, never a runtime mutation. The Phase 7 Town Hall adoption remains
available as the in-world confirmation of an act already in force.

## Base verification

Local base branch `assembly/base-master-d30cc4f` at `a7a7eb3` (the
PR-5 assembled tip) — its tree `8078ccb2d85a8099bc83c47b085fc1321845f37d`
verified byte-identical to remote master `d30cc4f`'s tree via the API
before any edit. Three commits ride the branch (registry flip; CK4;
README + this note).

## Hash verification (stop condition — PASSED)

Before flipping, the stored `docHash` was verified two ways:

1. **Registry as found:** `lib/sim/baseline/registry.ts`,
   `PRODUCTION_BASELINE_REGISTRY.versions[0]` =
   `{ version: "world-baseline-1.0", status: "draft", docHash:
   "db01a43ab1e6015d18d82cc09bf48cddea70a320bad44617f9d39e6a4e0d63ae",
   effectiveFromSeq: null }` — the stored hash matches the motion's
   hash exactly.
2. **Independent recomputation** from the draft file on disk
   (`world-baseline-ratification-draft.md` §1 only, pack §2 method:
   §1 span extracted, CRLF→LF, trailing newlines stripped + exactly
   one, SHA-256 over UTF-8): recomputed
   `db01a43ab1e6015d18d82cc09bf48cddea70a320bad44617f9d39e6a4e0d63ae`
   — identical. The text CJ adopted is the text the registry names.

The Baseline document itself is NOT amended by this PR; no §1 text
changed, so the hash stands as ratified.

## The diff (exact)

**`lib/sim/baseline/registry.ts`** — the flip is one line:
`status: "draft"` → `status: "ratified"` on the `world-baseline-1.0`
entry. `version`, `docHash`, every section `textHash` value, and
`effectiveFromSeq: null` are untouched. Three comments are updated to
record the act (the file header's status paragraph; the
`effectiveFromSeq` field note; the production-registry comment) — no
other code in the file changes.

Why `effectiveFromSeq` stays null: pack §3 fixes the semantics — the
ratified entry carries null in the code registry until production
genesis stamps the version + hash on `sim_world/current`, and the
version is citable from production seq 1 onward via that stamp.
Stamping is motion (b)/(c) of pack §2 and belongs to the P2-K15
production chain (production genesis), not to this PR.

## Consumer map + dispositions

Every consumer of the registry was read before the flip. Citability
selection everywhere runs through `citableBaselineVersion`
(registry → `baselineContextFor` in `lib/sim/rules/registry.ts`, the
resolver's delivery path and `lib/sim/resolver.ts:1016`, preview and
committer manifest stamps): it selects only `status === "ratified"`
versions whose `effectiveFromSeq` is non-null and ≤ the seq — so
post-flip, selection from the code registry still returns null
pre-genesis, exactly as pack §3 prescribes. Citation *legality* is
the verifier's (`lib/sim/verify.ts`): `BASELINE_UNRATIFIED_CITED`
keys on `version.status !== "ratified"` (TC-W01), the hash check
compares against the stored `docHash`, and the retroactive check
(TC-W04) applies only when `effectiveFromSeq` is non-null. That is
where the flip bites today: a citation of `world-baseline-1.0`
carrying the ratified hash is lawful for the verifier from this
merge; a citation of a draft still fails.

Dispositions:

- `lib/sim/rules/acquisition.ts` (`BASELINE_UNRATIFIED_SOURCE`
  null-reasons): reads citable via the injected registry — behavior
  unchanged pre-genesis. No edit.
- `scripts/sim-run-wake.ts`, `scripts/sim-verify-log.ts`: inject
  `PRODUCTION_BASELINE_REGISTRY` — no status-keyed logic of their
  own. No edit.
- All remaining `"draft"` hits in the tree are other vocabularies
  (allocation draft docs, post status, NPC trigger postures) — none
  key off the Baseline registry. No edit.

## Test dispositions

- **`tests/sim-core.test.ts` CK4 — READS THE PRODUCTION REGISTRY
  (adjusted).** The scenario asserted `status === "draft"`, citable
  null at seqs 1/9999, and a `BASELINE_UNRATIFIED` rejection for a
  Baseline-dependent judgment run on the default (production) deps.
  It now asserts the ratified posture: status `"ratified"`, the
  docHash pinned to `db01a43a…d63ae`, `effectiveFromSeq` null, and
  registry-alone selection still null at any seq (pre-genesis). The
  production-registry rejection case is RETAINED with its asserts
  byte-identical, re-captioned pre-genesis. Fail-closed for genuinely
  unratified text stays proven by a NEW case: a test-local registry
  carrying the same production text at status `"draft"` (built by
  mapping the production versions) — never citable at any seq, and a
  `fixture_market_judgment` against it rejects
  `BASELINE_UNRATIFIED`, one rejected entry citing nothing. The
  narrative-unruled case, the no-entry-cites-the-production-text
  sweep, and all F10 fixture halves are unchanged. CK4 remains an
  emulator suite — CI is its venue; the registry-level assertions
  were additionally exercised locally by a pure probe (below).
- **`lib/sim/baseline/fixtures.ts` / F10 fixture registry:**
  self-contained (both fixture versions ratified inside the fixture
  world) — untouched by design; the machinery was always exercised
  there, never against the production text.
- **`tests/play-core.test.ts`, `lib/sim/rules/allocation.test.ts`:**
  inject the production registry as dispatcher deps only; no
  Baseline-status assertions; citable behavior unchanged. No edit.
- **Pure harnesses** (`tests/*-harness.ts`): all use fixture/local
  registries. No edit.

## Regression

(Local run on the branch tip; emulator suites are CI's venue — the
sandbox emulator blocker is unchanged.)

- Registry probe (pure tsx, by name): production entry status
  `"ratified"`; docHash `db01a43a…d63ae`; `effectiveFromSeq` null;
  `citableBaselineVersion(production, 1)` = null;
  `citableBaselineVersion(production, 9999)` = null; draft copy
  citable null at 1/9999; fixture registry citable =
  `baseline-fixture-0.1` at seq 50, `baseline-fixture-0.2` at seq 100.
- Pure battery at landed counts (see the report to Theo for the run
  record): cat1, defense 12, chains 34, cat2 34, acq 14, market 27,
  lore 27, close-out 29, governance 57, situations 32, wake 23.
- `tsc --noEmit` clean; ESLint clean on touched files
  (`lib/sim/baseline/registry.ts`, `tests/sim-core.test.ts`);
  `next build` green.
- CI on the PR re-runs the emulator suites, incl. CK4 in full —
  that is the case to watch.

## PR draft

**Title:** World Baseline 1.0 — ratification (CJ ruling, 2026-10-20)

**Body:**

CJ ratified the World Baseline in the War Room on 2026-10-20
(Option A of Vera's `workstreams/baseline-ratification-pack.md`,
closing P2-K2): §1 of `workstreams/world-baseline-ratification-draft.md`
is adopted as World Baseline 1.0, version `world-baseline-1.0`, doc
hash `db01a43ab1e6015d18d82cc09bf48cddea70a320bad44617f9d39e6a4e0d63ae`.
Under the Baseline's own precedence (§1.2.2.5) the ruling is the
ratifying act; this PR is the reviewed code change that records it.

The change: one line in `lib/sim/baseline/registry.ts` —
`status: "draft"` → `"ratified"` on the `world-baseline-1.0` entry —
plus the recording comments. The stored `docHash` was verified
before the flip by independent recomputation from the draft §1
under the registry's §5.2 normalization: it matches exactly. The
adopted text is not edited; the hash stands as ratified.

Per pack §3, the entry's `effectiveFromSeq` stays null in the code
registry until production genesis stamps the version + hash on
`sim_world/current` (citability from production seq 1 arrives with
that stamp — a P2-K15 production-chain step, not this PR). What
changes at this merge: citations of `world-baseline-1.0` carrying
the ratified hash are lawful for the standing-Log verifier (its
TC-W01 check keys on status); resolver selection of a citable
version still returns null pre-genesis, by the pack's fixed
semantics.

Tests: `tests/sim-core.test.ts` CK4 asserted the draft posture
against the production registry; it now asserts the ratified
posture (status, pinned docHash, null `effectiveFromSeq`, selection
still null pre-genesis), retains the production rejection case
re-captioned pre-genesis, and keeps fail-closed proven against a
test-local draft copy of the same text (never citable; a
Baseline-dependent judgment against it rejects
`BASELINE_UNRATIFIED`). The F10 fixture registry is untouched.
README changelog records the ratification per the standing rule.

Built, not live — nothing is deployed by this PR, and no production
step (genesis, the `sim_world/current` stamp, deploys) is taken or
implied by it.
