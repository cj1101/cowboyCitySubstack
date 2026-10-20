# Cowboy City Lore

A private multimedia chronicle for Charles and his friends. Cities such as Cascadia, Cowboy City, Evan City, Coronado Springs, Turtle Shores, Kelpington, Chess City, and Wythria post updates about their Minecraft realm. The worlds stay independent and aware of each other. Realm-wide bodies such as the UR and the ICTC tribunal live in the lore, not in a separate permissions system.

Built with Next.js 15, React 19, TypeScript, Tailwind 4, TipTap, and Firebase Auth, Firestore, and Storage on the `cowboycityrealm` project. Deployed on Vercel.

The original PHP prototype is in [`legacy/`](legacy/) for reference.

## What members can do

- Create an account and use the realm immediately. A sheriff can still suspend or remove an account from `/sheriff`. Approval can be turned back on with `REQUIRE_APPROVAL` in `lib/membership.ts`.
- Keep a personal profile, then found one or more city accounts (banner, crest, description, lore, and a feed). Co-owners still work.
- Publish chronological posts with rich text, photo and video galleries, content warnings, drafts, and scheduled posts.
- Reference other posts, tag cities so the post shows on each city feed, and use `@mentions`.
- Comment in or out of character, react, follow cities, and get in-app notices.
- Message one person or a small group. Only participants can read a thread.
- Record Settlement Years (for example Year 391) and eras. `/timeline` interleaves every city.
- Upload a city map or an optional realm map and drop pins.
- Keep a per-city wiki (characters, places, factions, laws, species, teams) with `[[wiki links]]`, hover previews, and stat tables.
- Search posts, wiki entries, and cities, and export your cities and posts as JSON or a zip.

There is no canon, rumor, or retcon status.

## Environment variables

Copy the example file and fill in the web app config from Firebase Console → Project settings → Your apps:

```bash
cp .env.example .env.local
```

| Variable | Required on Vercel |
|----------|--------------------|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Yes |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | Yes |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | Yes |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | Yes |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | Yes |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | Yes |
| `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID` | Optional |

The site does **not** use a Firebase Admin service account. Sheriff actions, messages, and notices are written by the browser and enforced by `firestore.rules` and `storage.rules`. Membership is signed-in and not suspended.

`npm run migrate` is optional and still accepts a service account if you need to import the old PHP data. Do not put that key in Vercel.

For local emulator work only, set `NEXT_PUBLIC_USE_FIREBASE_EMULATORS=true`. Leave it unset in production.

## Sheriffs

Root sheriffs are email addresses hardcoded in the rules, not an environment variable:

- `firestore.rules` → `rootAdminEmails()`
- `storage.rules` → the same list inside `isRootAdmin()`

The lists are `charlie@suarezhouse.net` and `cjtheswimmer1101@gmail.com`. Keep both files identical, then deploy the rules. A root sheriff signs up like anyone else. The client asks Firestore once to set `isAdmin: true`. The rules allow it only when the Auth email is on the list. If that write is refused, the page stays put. It does not retry.

From `/sheriff` a sheriff can:

- suspend or remove a person
- grant or revoke the sheriff flag on another person

Approve, deny, and email invites stay in the code behind `REQUIRE_APPROVAL` (currently false).

Extra emails can also be stored on the Firestore document `config/admins` as `{ emails: ["friend@example.com"] }`. Rules read that list. Only an existing sheriff can write it.

Root allowlisted emails can always restore their own access. Suspend still works for sheriffs who are not on that list.

## Local development

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Emulators

```bash
npm run emulators
```

In another terminal, with `NEXT_PUBLIC_USE_FIREBASE_EMULATORS=true` in `.env.local`:

```bash
npm run dev
```

Rules tests (Firestore and Storage emulators):

```bash
npm run test:rules
```

Sim core tests (Phase 2 engine suite — resolver, committer, pendings/ripening, undo — against the Firestore and Auth emulators):

```bash
npm run test:sim
```

Enable Email/Password in Firebase Authentication before using production. Storage uses `cowboycityrealm.firebasestorage.app` (`NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`). That bucket starts in production mode and denies every request until rules are released onto it. Deploy rules and indexes when they change:

```bash
npx firebase login
npx firebase deploy --only firestore:rules,firestore:indexes,storage --project cowboycityrealm
```

`firestore:rules` and `firestore:indexes` publish `firestore.rules` and `firestore.indexes.json`. `storage` releases `storage.rules` onto `cowboycityrealm.firebasestorage.app` (the `media` target in `.firebaserc`).

## Development workflow

- **Every PR updates this README.** If a change alters behavior, setup, or project status, the same PR updates the relevant section above and adds a dated line to the Changelog below. A PR with no README change needs a stated reason in its description.
- **CI is required.** The GitHub Actions check `Install · Typecheck · Lint · Build` (`npm ci` -> typecheck -> lint -> build, Node 24) runs on every PR and push to `master`, and branch protection requires it green before merge.
- **Rules tests run in CI, non-required for now.** A second check, `Rules tests (non-required)`, runs `npm run test:rules` against the Firebase emulators on every PR and push. It is deliberately **not** in branch protection — a red run does not block merges — and stays non-required until it runs green and stable on unmodified `master` (Priya's promotion criteria), at which point a separate PR promotes it.
- **Sim core tests run in CI, non-required.** A third check, `Sim core tests (non-required)`, runs `npm run test:sim` (the Phase 2 engine suite) against the Firebase emulators on every PR and push, under the same terms: not in branch protection, promoted only by a separate PR after green, stable runs on unmodified `master`.
- **Parallel PRs are normal.** Several contributors (human and agent) may have PRs open at once; keep each PR to one concern so they can merge in any order.
- **Merging:** the PR author or another team member/agent merges once CI is green and the change matches its description. Production deploys stay a deliberate human-approved step (Vercel), never an automatic side effect of a merge beyond the normal Vercel flow.

## Production on Vercel

1. Import this GitHub repo in Vercel. Framework preset: Next.js. Root directory: the repo root.
2. Add the seven `NEXT_PUBLIC_FIREBASE_*` variables. Redeploy after changing them so they are baked into the client bundle.
3. In Firebase Console → Authentication → Settings → Authorized domains, add the Vercel domain (for example `your-project.vercel.app`) and any custom domain.
4. `npx firebase deploy --only firestore:rules,firestore:indexes,storage --project cowboycityrealm` when you can sign in to the Firebase CLI. Until that deploy, Firestore still has the July rules, and the Storage bucket denies every upload and download.
5. Open the site and sign up. A root sheriff email can open `/sheriff` to suspend or remove members once the new rules are deployed.

Step-by-step notes are in [DEPLOY.md](DEPLOY.md). An IONOS VPS with Node, PM2, and nginx remains an alternative there. It is not required.

## Project structure

```
app/                  # Next.js App Router pages
components/           # React components
lib/                  # Firebase client, Firestore helpers
lib/sim/              # Sim layer: template, genesis, lazy creation, resolver core (Phase 2)
lib/dashboard/        # Dashboard data layer: panel registry, prefs, snapshot read path (Phase 3)
lib/stats/            # Stat sheets + why-links (Phase 3)
lib/entity/           # Entity pages: resolution, function state, galleries (Phase 3)
lib/trust/            # Published-claim assessments — per-member, never a system verdict (Phase 3)
lib/export/           # Excel workbooks: Log, dashboard, city, entity, assessments (Phases 2–3)
lib/bugs/             # In-app bug reporting: dialog, reports, triage (Phase 3)
lib/play/             # Play-loop intake: client helpers over buildActionDoc, preview views (Phase 4)
firestore.rules       # Firestore security rules
firestore.indexes.json
storage.rules
firebase.json
scripts/              # Optional legacy migration (Admin SDK); sim ops scripts (emulator-only)
tests/rules.test.ts   # Emulator tests for approval, DMs, city ownership, sim layer
tests/sim-core.test.ts # Phase 2 engine suite (resolver/committer/ripening/undo)
legacy/               # Original PHP prototype
```

City pages are served at `/cities/...`. The older `/factions/...` URLs rewrite to the same screens. Firestore still stores cities in the `factions` collection so existing co-ownership and data keep working.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript |
| `npm run test:rules` | Security rules emulator tests |
| `npm run test:sim` | Phase 2 sim core emulator tests (resolver, committer, ripening, undo) |
| `npx tsx tests/cat1-harness.ts` | Phase 4 Catalogue I pure handler harness (structures/laws; no emulator) |
| `npx tsx tests/defense-harness.ts` | Phase 4 Defensive pure handler harness (R-18/R-37; no emulator) |
| `npm run emulators` | Auth, Firestore, and Storage emulators |
| `npm run migrate` | Optional legacy import (needs a service account) |
| `npx tsx scripts/sim-genesis.ts` | Sim genesis (emulator only; production run is guarded and a separate ops decision) |
| `npx tsx scripts/sim-ensure-city.ts <factionId>` | Lazily create one claimed city's sim docs from the even-start template (emulator only) |
| `npx tsx scripts/sim-phase1-verify.ts` | Phase 1 data-shape verification (P1-G2/G3/G4) against the emulator |
| `npx tsx scripts/sim-run-wake.ts` | Run one fabric wake (undo ops, confirmed actions, one ripeness scan) against the emulators — emulator only; production wakes are player-caused, never scheduled |
| `npx tsx scripts/sim-verify-log.ts` | Verify the standing Log (hash chain, counter/world agreement, Log⇄state bijection, citations) against the emulator |

The sim layer (Phase 1) adds Firestore collections `sim_world`, `sim_counters`, `sim_log_entries`, `sim_cities`, `sim_stat_allocations`, `sim_actions`, `sim_resolutions`, `sim_publications`, and `sim_intel_records`. Client writes to authoritative sim state are denied for every identity; only the fabric committer identity (custom claims, `lib/sim/` + rules) writes, and cities are created lazily from an identical even-start template the first time a claimed city is switched on — no stats are seeded from lore. Nothing in Phase 1 is deployed: the rules/index changes in this repo take effect only when someone deliberately deploys them, and production genesis is a separate guarded step.

Phase 2 adds the resolver core in `lib/sim/` (resolver, committer, dispatcher, pendings with Action-Gated Ripening, the dependency-checked undo engine, the Baseline registry, and the standing-Log verifier), two collections (`sim_pending_consequences`, `sim_undo_operations`), the member-facing Log page at `/log` with a personal audit-workbook export, and a rules amendment: Log entries and manifests become committer-deletable (never updatable — that delete path is what lawful undo uses), the action-confirmation clause is fixed and hash-bound to the stored preview, and the Baseline registry fails closed — nothing may cite the unratified draft. The world only ever changes inside a player-caused wake; there is no scheduler. Nothing in Phase 2 is deployed either, and production genesis remains a separate guarded step.

Phase 3 makes the sim visible: home (`/`) becomes the customizable dashboard (the feed moves to `/feed`) — eleven panels over a fabric-written public snapshot (`sim_dashboard_snapshots`, refreshed at the end of any world-changing wake; freshness is judged by Log sequence, never by clock) with per-member layout prefs (`sim_dashboard_prefs`, owner-only). City pages gain the Sim sheet (the same component the dashboard's my-city panel mounts) with why-links into the Log (which gains the matching field-filtered view), a published-claims block that keeps owner-published figures visibly separate from verified stats, and a per-member trust layer (`sim_trust_assessments`: credible / bullshit / unsure marks, shareable as an attributed read-only view, never a system verdict) including the gated compare view (TC-P03, ruled Reading A: claim + a source the viewer legitimately holds + their arithmetic delta — nothing else). Buildings and businesses get their own entity pages (sim record or pin/wiki presentation on one template), Excel workbooks land for the dashboard, cities, entities, and a member's own assessments (fail-closed; guests and ungranted viewers get nothing), and in-app bug reporting ships end to end (`bug_reports` + rules, report dialog + footer, `/reports`, Sheriff triage, exactly two notifications per report, and the on-demand backup archive in the fabric job's format). Nothing in Phase 3 is deployed either; the snapshot's first writer is the fabric's next wake, and production steps remain separate guarded decisions.

Phase 4 opens with Step 0, an engine-hardening pass over `lib/sim/` (no new player surface): rule descriptors gain a **read-plan contract** — collection reads (order-book shape) are declared by descriptor code, materialized into the resolver snapshot, and bound into the manifest's input set exactly like doc reads, so actor citations can add reliance but can never narrow or source an authority- or money-critical read; **plan writes fold** — one write per doc per resolution, computed against the planned doc, with `validatePlan` reconciling every entry's `changes[]` against the folded writes (the old replace semantics could drop one of two effects on the same doc while the Log claimed both); and **prepared payloads are bound end to end** on the action path — a worker's judgment payload is hashed into the preview, stored on the action doc, passed verbatim to the committer, and recorded in the manifest, so a swapped payload goes stale instead of committing (handlers never read judgment from the member's own action). The wake order (actions commit → per-action ripeness scan → queued undo ops → terminal dashboard-snapshot refresh) is locked by a same-wake race test. New engine fixtures (`fixture_orderbook`, `fixture_judgment`) exercise the three contracts in the Sim core suite. Nothing is deployed; production steps remain separate guarded decisions.

Module 0, the Phase 4 data step, stamps the shapes every later module builds against: a fabric backfill (`scripts/sim-phase4-data-step.ts`, emulator-only) writes Vera's locked `pointBudget: 400` onto any unstamped allocation doc and the honest-unbuilt `defensePosture` default onto any city doc missing one — single-field writes, idempotent, and self-verified by a byte-compare assertion pass that proves nothing outside the two target fields changed (the template builders already stamp both at creation). The corporation record gains its Phase 4 shape in `lib/sim/corporations.ts` — `ownerMemberId` as the one ownership fact validation may read, `companyCashRubars`, per-city `taxPayables`, and `legacyBookRubars` (provenance only). And the allocation commit path is now exactly one: owners can only ever save drafts (`commit_requested` is the committer's, set when queueing the confirmed `allocate_season0` action), and allocation `versions` docs are committer-created only. A new Phase 4 suite, `tests/play-core.test.ts`, carries the data-step evidence in CI.

The play loop opens to members with the Intake UI (step 2, `components/play/` + `lib/play/`): the Phase 3 dashboard action-box shell becomes the live intake. A member composes an action in their own words or through a structured form for a registered kind; the browser's only writes are the born-`received` action doc (the landed `buildActionDoc`, one idempotency key per draft) and the hash-bound confirmation — there is no client write path to sim state. When the fabric returns a preview, the preview card renders the stored record exactly (the resolver's summary, the exact deltas grouped by city, spillover, pendings disclosed as a class with their delay arithmetic, and the warnings — rejection and legal exposure surface here, not after the fact), and Petra's never-bind confirmation card names what will happen, what it costs, and what cannot be undone before the member's own confirm act. The box then follows the action through its lifecycle, including its Log seqs once resolved and the erased state a lawful undo leaves behind. Structured kinds are offered only when a handler is registered for them; the catalog ships empty of product entries at this step (the landed registry still holds only Phase 2 fixtures) and gains an entry as each catalogue step lands. Assembly mounts the box in the dashboard's Take-an-action panel (the Phase 3 shell's data contract unchanged) and on every city page locked to that city, with the offered kinds reconciled against the fabric registry's live kind index at both mounts.

The Allocation module (brief step 3) makes the founding build playable. `lib/allocation/` + `components/allocation/` carry the client half: the slider editor over Vera's locked rules (400-point pool, eight allocatable indices — spirit, culture, infrastructure, stability, law, influence, military, defense — integer values 0–80, drafts at any sum, commit only at exactly 400 with unspent points surfaced as an error, never banked; the five stocks are never allocatable; earned space above 80 is named in the UI). Committing is an action, not a status write: the editor's two-step confirmation saves the final map as the head draft and submits an `allocate_season0` action whose payload binds that draft by version + hash; the binding confirmation is the member's hash-bound confirmation on the action's fabric preview. `lib/sim/rules/allocation.ts` is the R-35 handler: it re-validates commit-grade at resolution (exact sum, bounds, completeness, the draft binding, the map's own hash, the Module 0 pool stamp, one-commit-ever, owner authority — or the sitting mayor alone for the shared city), and its commit plan writes the eight values into `sim_cities.stats`, the allocation doc's commit fields, and the first `versions/v1` record, logging the city's first entries (one rule-effect entry carrying all eight changes + the action-summary). The module's draft hashes come from the sim layer's canonical module directly (the browser hash port is deleted). Nothing is deployed; page wiring of the editor into the city surface lands with the play-loop UI work. Assembly (Lead): `R-35` is registered in the rule registry (`allocate_season0` resolves through it); `firestore.rules` gains a fabric read branch on the allocation doc and its `versions` subcollection (the dispatcher's read-plan materialization and undo-restore re-reads run under the committer identity — the P2-K16 pattern; member/guest draft privacy unchanged, proven in the rules suite); `firestore.indexes.json` gains the brief §12.4 collection-group `versions` index (`cityId` + `commitSeq`) serving allocation history; and `tests/play-core.test.ts` gains the P4-G1 battery sections C1/C3/C5 against the registered descriptor.

Phase 4's finance module (step 4) lands the money layer in `lib/finance/` plus its rule handlers in `lib/sim/rules/finance.ts`: the account model over Module 0's shapes (personal accounts at `sim_member_accounts/{memberId}`, treasuries as `stats.treasuryRubars`, company cash on the corporation record — characters, NPCs and guests hold no accounts), the **transfer primitive** every Rubar movement composes through (validated lines, netted per event, each line landing in the Log's `changes[]`), and a pure **conservation checker** (`lib/finance/conservation.ts`) proving the paired-posting identity and the two money bridges (settlement cash; source-classified claim money) over event records. Rules landed: **F-01** (open an account; the 250,000 R genesis grant is a mint inside the opening event, exactly once, with lazy-open as step 0 of any money-touching action and a pure backfill planner for pre-Phase-4 members), **F-02** (member transfers — public, transfer class, refused in full on shortfall; there is no covert transfer), **F-03** (fund a company from the owner's personal account), **F-05** (treasury spend, budget class with the shortfall logged; company payees are refused with the F-10 citation), and **F-12** (contribute to your own city's treasury — one-way, no reverse path exists). The **banking slice** (member companies can be real banks, per CJ's ruling) adds **B-01** charter/surrender (owner-only, 100,000 R minimum capital, terms recorded verbatim on the corporation's `bank` block), **B-02** deposits as recorded claims at `sim_bank_deposits` (custody is not ownership; the liability aggregate moves in the same event, assertion A-B1), **B-03** withdrawals and **B-04** cash-paid interest settlement under the **custodial** shortfall class — payments validate against *unencumbered* cash (cash − deposit liabilities − the 20% liquid-reserve floor), never the raw balance, and refuse in full. Loans, credit creation mechanics, and deposit insurance are Phase 5/7: the deposit record's provenance field and the loan record shape are reserved now so nothing migrates later, and no code asserts that creation cannot happen. Descriptors register into the rule registry, the checker wires into the standing verifier, and the `sim_member_accounts`/`sim_bank_deposits` rules + index blocks land as Lead assembly items with the module's integration PR; nothing here is deployed.

Catalogue I (Phase 4 step 5: structures & city) lands the first product rule family as two new files under `lib/sim/rules/`, written against the Step 0 contracts and awaiting the Lead's single registry assembly edit: `structures.ts` carries the R-05 project spine (phase costs treasury-paid under budget-class discipline — a part-paid phase does not complete and its shortfall is logged), the completion rules that fire inside the completing Resolution Event in table order (R-01 civic/cultural, R-02 commercial/industrial with its founding dividend and supplier spillover, R-03 housing — households form by the completion action itself, immigration zero-sum, R-04 transport/infrastructure with endpoint connection records in the landed `connection:<cityId>:live` trait spelling, R-38 military — the index named by the owner-declared `profile.supports`, rejected at proposal when neither branch is named), R-16/R-19 (demolish uninhabited / mothball, both refusing inhabited structures toward R-17, which is not in the v1 subset), and R-24 repair. Structure function is **derived, never stored**: `isStructureFunctioning` reads `status == complete && condition == 100` from the record at resolution time, so any damage stops a building's function until a repair restores it, and `housingUnits` counts functioning housing only, recomputed inside every structures-touching event. Natural geography is fixed ground truth: records marked `profile.geography: "natural"` are refused by every handler in the family, while man-made features are ordinary R-05 projects. `laws.ts` carries R-08/R-09 (laws enter in force with only table-vocabulary effects applied — the rest is recorded narrative-only — plus the standing law +2 / stability +1; repeal marks, never deletes, and never undoes passage effects), finance's F-08 tax vocabulary riding R-08 (the tax schedule is *derived* from in-force laws, never stored; unset components are not assessed), and the F-09/F-10/F-11 handlers (versioned budget authorizations that never mutate in place and never move money; budget-class service-contract payments that record the contract-payment taxable fact for F-06; payroll with withholding computed from the law-derived schedule, the net leg to `exterior:households:{cityId}` as a Log-only line, and partial runs flagged `payrollShortfall` in the open). A pure harness, `tests/cat1-harness.ts` (`npx tsx tests/cat1-harness.ts`, no emulator), drives 19 scenarios through the handlers' declared read plans and runs every resolved plan through the real `validatePlan` — F-02 reconciliation included — with the family descriptors registered in-process exactly as the assembly edit will register them. Two assembly items ride with the Lead: the registry merge itself (plus finance's §2.4 descriptor additions, exported alongside the descriptors), and a `firestore.rules` match block for the `budgets/` subcollection, which has none today (structures/households/laws/corporations all do). Nothing is deployed; production steps remain separate guarded decisions.

Defensive & posture (Phase 4 step 8) lands R-18 and R-37 as a new family file, `lib/sim/rules/defensive.ts`, written against the Step 0 contracts and awaiting the Lead's single registry assembly edit. R-18 ships in its **Phase 4 fixed-class form**: an `attack_city` action declares a damage class — **property** (each named structure −40 condition, target infrastructure −3), **inhabited** (property effects plus displacement: every household resident in a named structure becomes `displaced`, its record persisting; population falls by the displaced persons when set; spirit −4), or **economic** (GDP −1.5%, treasury skimmed by min(treasury, 0.5% of GDP) — both skipped-and-logged when GDP is null) — and the attacker pays in full, never scaled (law −5, stability −2, influence −3) plus an **automatic tier-2 legal case** recorded at `sim_cases/{caseId}` and on the attacker's `legalExposure`; CJ's espionage carve-out (a case only if the target users say so) governs the R-27 espionage class and is stated, not applied, in the case entry — open attack is not espionage. A city whose `military` is null cannot initiate (rejected, logged — P4-G1-C7); natural geography is refused as a damage target; damage writes condition (ruined at zero) and structure function stays derived through Catalogue I's predicate, with `housingUnits` recomputed in the same event. R-37 posture rides Module 0's `defensePosture` record: `prepare_defenses` is owner-authored and treasury-paid at the recorded amount (refused in full past the treasury; amounts over 10% of the treasury carry the proposal flag), replacing any prior posture; `stand_down_defenses` ends it with no refund; and any hostile resolution against the city **consumes** a standing posture. One flagged interpretation rides with the Lead: v2's Phase 4 form publishes no numeric posture damage reduction (the +10 DEF term belongs to the Phase 7 contest), so the class values apply as written whether or not the target is postured — the reduction, if ratified, is the single named constant `PHASE4_POSTURE_DAMAGE_FACTOR`. A pure harness, `tests/defense-harness.ts` (no emulator), drives 12 scenarios — all three classes, ruin and derived-function stop, displacement, posture lifecycle and consumption, null-GDP skips, the null-military rejection, and the rejection battery — through the handlers' declared read plans, running every resolved plan through the real `validatePlan` (F-02 reconciliation included), with the family descriptors registered in-process exactly as the assembly edit will register them. Assembly items for the Lead: the registry merge itself, and a `firestore.rules` posture for the new `sim_cases` collection (its first records are written here; recommendation in `workstreams/p4-defense-prep-report.md`). Assembly (Lead): `R-18`/`R-37` are registered in the rule registry (`attack_city` resolves to R-18; `prepare_defenses`/`stand_down_defenses` to R-37); `firestore.rules` gains the `sim_cases` posture (committer-only writes, viewer reads — the recommendation as approved — proven in the rules suite); and `tests/defense-harness.ts` is chained into `test:sim` alongside the Catalogue I harness. No index or UI changes in this PR; nothing deployed.

## Changelog

- 2026-10-20 — Phase 4 Defensive + posture (step 8): new rule family file `lib/sim/rules/defensive.ts` (R-18 Phase 4 fixed-class form — property/inhabited/economic classes, actor costs in full, automatic tier-2 case at `sim_cases/` + `legalExposure`, espionage carve-out preserved, posture consumption, null-military rejection per P4-G1-C7, derived function via Catalogue I's predicate; R-37 `prepare_defenses`/`stand_down_defenses` over the Module 0 posture record) plus the pure harness `tests/defense-harness.ts` (12 scenarios; every resolved plan passes `validatePlan` incl. F-02). One flag for ratification: the Phase 4 posture damage factor is pinned at 1 (v2 publishes no fixed-class reduction). Registry assembly and a `sim_cases` rules posture are flagged for the Lead in `workstreams/p4-defense-prep-report.md`. No rules/index/UI changes in this PR; nothing deployed. (PR: p4/defensive)
- 2026-10-19 — Phase 4 Catalogue I (step 5, structures & city): new rule family files `lib/sim/rules/structures.ts` (R-05 spine; R-01–R-04 + R-38 completions inside the completing event; R-16/R-19 with the R-17 refusal redirect; R-24; derived structure function — never a stored flag; natural-geography refusal posture) and `lib/sim/rules/laws.ts` (R-08/R-09 + the F-08 tax vocabulary with the law-derived schedule; F-09 versioned budget authorizations; F-10 service-contract payments recording the F-06 taxable fact; F-11 payroll with law-derived withholding and `payrollShortfall`), plus the pure harness `tests/cat1-harness.ts` (19 scenarios; every resolved plan passes `validatePlan` incl. F-02). Registry assembly, the finance §2.4 descriptor additions merge, and a `budgets/` rules match block are flagged for the Lead in `workstreams/p4-cat1-prep-report.md`. No rules/index/UI changes in this PR; nothing deployed. (PR: p4/catalogue-structures)
- 2026-10-19 — Phase 4 Finance primitives (step 4 / module c) + F-12: `lib/finance/**` (account model + F-01 lazy-open/genesis grant + backfill planner, transfer primitive, banking shapes/surfaces, pure conservation checker) and `lib/sim/rules/finance.ts` (F-01/F-02/F-03/F-05/F-12 + B-01–B-04 cash-paid handlers with declared read plans; FINANCE_DESCRIPTOR_META carries finance §2.4's shortfallClass/ledgersTouched/invokesRules). No registry, rules, index, or UI changes in this module — those are Lead assembly items enumerated in the prep report. (PR: p4/finance-core)
- 2026-10-19 — Phase 4 Allocation (brief step 3): the Season-0 allocation module — `lib/allocation/` (locks as pure logic, draft saves through the owner draft fence; the browser canonical port deleted in favor of `lib/sim/canonical`, P4-K15) and `components/allocation/` (the two-step no-respec editor, re-verified against current `app/globals.css`); the commit rewired from a browser status write to an `allocate_season0` action through the preview/confirm loop (P4-K14: `lib/allocation/commitAction.ts` submits via the landed intake builder, payload = final map + draftVersion + draftHash); new R-35 handler `lib/sim/rules/allocation.ts` (commit-grade validation, F-01 read-plan hook for the allocation doc + first version, three-write commit plan + the city's first Log entry pair) with a pure resolver harness. No registry, rules, or index edits in this PR — the Lead registers R-35, adds the §12.4 versions-by-`cityId` + `commitSeq` index, and one flagged rules branch (fabric read of the allocation docs) at assembly; see `workstreams/p4-allocation-module-prep-report.md`. (PR: phase4/allocation)
- 2026-10-19 — Phase 4 Step 0: engine hardening (F-01 read plans, F-02 planWrite folding + `validatePlan` changes↔writes reconciliation, F-07 prepared-payload binding on the action path; wake-order lock test). `lib/sim/` only plus Sim core test additions; no rules, index, or UI changes. One residual noted for the client-SDK upgrade (PR-F): the pinned SDK's transaction API has no typed query read, so collection-query membership is bound at dispatcher materialization (same wake step, digest-recorded in the manifest) rather than re-executed inside the commit transaction. (PR: phase4/step0-engine-hardening)
- 2026-10-19 — Phase 4 Intake UI (step 2): live action intake in `components/play/` (ActionBox composer + lifecycle tracker, PreviewCard, never-bind ConfirmationCard, generic StructuredActionForm) over `lib/play/` client helpers (submit/confirm/subscribe fenced to the landed `sim_actions` rules clause; kind catalog + form-state + preview formatting). The browser writes only the action doc and its hash-bound confirmation; structured kinds are offered only when registered — the catalog carries no product entries yet. (PR: p4/intake-ui)
- 2026-10-19 — Phase 4 Module 0 (data step): pool-stamp + `defensePosture` backfill script (emulator-only, idempotent, assertion-verified byte-compare); corporation record shape (`ownerMemberId`, `companyCashRubars`, `taxPayables`, `legacyBookRubars`) in `lib/sim/corporations.ts`; allocation fence narrowed so owners target only `draft` and `versions` creates are committer-only (exactly one allocation commit path); new `tests/play-core.test.ts` Phase 4 suite wired into `test:sim`. (PR: phase4/module0)
- 2026-10-19 — Phase 3: dashboard, stat sheets, entity pages, trust layer, bug reporting. Home becomes the customizable dashboard (11 panels; registry of 14 with 3 reserve-hidden; per-member prefs; guests get a fixed guest set, participation panels absent). New collections + rules blocks: `sim_dashboard_snapshots` / `sim_dashboard_prefs` (snapshot committer-written, public-tier only; prefs owner-only behind the full-member fence), `sim_trust_assessments` (§11.3), `bug_reports` (§11.4) + `bug-reports/` storage block; one new sim index (`sim_publications` cityId + publishedAtSeq) + the two `bug_reports` composites. Dispatcher gains the terminal snapshot-refresh step. The Log page honors why-link query state (city preset, field-filtered view, click-time anchor resolution). TC-P03 ships as ruled (Reading A, Variant A at the gate). No production deploy, genesis, or data access in this PR. (PR: phase3/dashboard-stat-sheets)

- 2026-10-18 — Security (PR-B): TipTap/ProseMirror editor chain updated — `@tiptap/*` 3.27.1 → 3.32.0, `prosemirror-view` → 1.42.6 (clears the paste-handling XSS GHSA-c8x8-7fp4-3x9w and the `@tiptap/core` ReDoS/`__proto__` advisories). (PR: security/pr-b-editor-chain)
- 2026-10-18 — Security (PR-D): `firebase-admin` 13 → 14 (`^13.2.0` → `^14.5.0`; installed 13.10.0 → 14.5.0), refreshing the whole admin subtree onto current majors (`@google-cloud/firestore` 7 → 9, `@google-cloud/storage` 7 → 8, `google-gax` 4 → 6, `google-auth-library` 10 → 11); the unused `lib/firebase-admin.ts` is deleted in the same PR (zero importers — the only Admin SDK consumers left are local scripts). Admin-SDK-subtree only; no runtime dependency changes. (PR: security/pr-d-firebase-admin)
- 2026-10-18 — Dev tooling: firebase-tools 15.33 → 15.34 (dev-only CLI, zero runtime surface; emulator/rules-test chain refreshed). firebase-tools 15.34 drops its `proxy-agent`, `universal-analytics`, and `@apphosting/common` dependency chains — 23 dev-only lockfile nodes pruned, no additions and no other version changes; clears the `basic-ftp` advisory (GHSA-c475-qrg2-pj4r) by removal. (PR: security/pr-e-firebase-tools)
- 2026-10-17 — Phase 2: Log + resolver core. `lib/sim/` gains the pure resolver (preview/commit parity, Baseline fail-closed registry, unruled narrative path), the one-transaction committer (manifest v2 with full snapshots, `inputHash` idempotency, write/manifest ceilings), the wake dispatcher, pendings with Action-Gated Ripening (R-32/33/34 machinery; delays derived, never rolled; no scheduler anywhere), the dependency-checked undo engine (LIFO suffix unwinding, snapshot restore, S1–S7 refusals, content-free proof in `sim_undo_operations`), entry hash v2 (v1 kept for genesis only), and the standing-Log verifier. `firestore.rules` amendment: Log/resolutions committer-delete-only (never update), action confirmation fixed (§9.4 — hash-bound, key-fenced; the Phase 1 clause made confirmation impossible), action create tightened to `received`-only, new `sim_pending_consequences` + `sim_undo_operations` blocks, committer deletes for undo restores. `firestore.indexes.json` gains the Phase 2 query indexes + exclusions. New surfaces: `/log` page + personal audit-workbook export (`write-excel-file`); scripts `sim-run-wake.ts` / `sim-verify-log.ts`; tests `tests/sim-core.test.ts` (`npm run test:sim`) + the Phase 2 section of `tests/rules.test.ts`; CI gains the non-required `Sim core tests (non-required)` job. No production deploy, genesis, or data access in this PR. (PR: phase2/log-resolver-core)
- 2026-10-17 — Phase 1: sim data foundation. `firestore.rules` gains the sim-layer helpers and match blocks (client writes to sim state denied for all identities; fabric-committer-only writes; owner allocation drafts field-fenced; publications create-only; Log create-only in Phase 1); `firestore.indexes.json` gains the Phase 1 sim indexes and field exclusions; `lib/sim/` adds the even-start template + `baselineHash`, the idempotent emulator-guarded genesis procedure, and lazy city creation (`ensureSimCity` — unowned factions get no sim presence, and lazy creation writes no Log entry); `tests/rules.test.ts` gains the P1-G1/G5/G6/G7 rules tests plus P1-G2/G3/G4 data checks; `scripts/sim-*.ts` are the emulator-only ops entry points. No production deploy, genesis, or data access in this PR. (PR: phase1/sim-data-foundation)
- 2026-10-17 — Security: transitive dependency refresh — clears 10 audit nodes (brace-expansion ×2, js-yaml, nanoid, source-map-js, postcss, @fastify/busboy, @grpc/grpc-js (admin copy), fast-xml-parser, protobufjs); lockfile only, no `package.json` changes (list in PR). (PR: security/pr-c-transitive-refresh)
- 2026-10-17 — Security (PR-A): Next.js 15.5.20 → 15.5.27 (clears all 12 `next` advisories, incl. 2 critical RCEs in the Image Optimization API — GHSA-p293-qw3h-jr36, GHSA-2xp9-vwfh-vxw4); `eslint-config-next` in lockstep; `sharp` → 0.35.5 via `overrides` (clears 3 libvips CVEs on the live `next/image` path). (PR: security/pr-a-next-sharp)
- 2026-10-17 — CI: non-required `Rules tests (non-required)` job added to `.github/workflows/ci.yml` (`npm run test:rules` on the Firebase emulators; Java 21 + Node 24; emulator debug logs uploaded as artifacts on failure). It is not in branch protection and stays non-required until green and stable on unmodified `master`. (PR: ci/test-rules-job)
- 2026-10-17 — Development workflow documented (this section): README-with-every-PR rule, PR template added. (PR: docs/readme-convention)
- 2026-10-17 — Phase 0: CI established. GitHub Actions workflow `.github/workflows/ci.yml` runs `Install · Typecheck · Lint · Build` on PRs and pushes to `master`; branch protection requires the check. Node pinned to 24 to match Vercel. (PR #14)

## License

Private project for the Cowboy City realm friend group.
