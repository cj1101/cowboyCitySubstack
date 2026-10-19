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
| `npm run emulators` | Auth, Firestore, and Storage emulators |
| `npm run migrate` | Optional legacy import (needs a service account) |
| `npx tsx scripts/sim-genesis.ts` | Sim genesis (emulator only; production run is guarded and a separate ops decision) |
| `npx tsx scripts/sim-ensure-city.ts <factionId>` | Lazily create one claimed city's sim docs from the even-start template (emulator only) |
| `npx tsx scripts/sim-phase1-verify.ts` | Phase 1 data-shape verification (P1-G2/G3/G4) against the emulator |
| `npx tsx scripts/sim-run-wake.ts` | Run one fabric wake (undo ops, confirmed actions, one ripeness scan) against the emulators — emulator only; production wakes are player-caused, never scheduled |
| `npx tsx scripts/sim-verify-log.ts` | Verify the standing Log (hash chain, counter/world agreement, Log⇄state bijection, citations) against the emulator |

The sim layer (Phase 1) adds Firestore collections `sim_world`, `sim_counters`, `sim_log_entries`, `sim_cities`, `sim_stat_allocations`, `sim_actions`, `sim_resolutions`, `sim_publications`, and `sim_intel_records`. Client writes to authoritative sim state are denied for every identity; only the fabric committer identity (custom claims, `lib/sim/` + rules) writes, and cities are created lazily from an identical even-start template the first time a claimed city is switched on — no stats are seeded from lore. Nothing in Phase 1 is deployed: the rules/index changes in this repo take effect only when someone deliberately deploys them, and production genesis is a separate guarded step.

Phase 2 adds the resolver core in `lib/sim/` (resolver, committer, dispatcher, pendings with Action-Gated Ripening, the dependency-checked undo engine, the Baseline registry, and the standing-Log verifier), two collections (`sim_pending_consequences`, `sim_undo_operations`), the member-facing Log page at `/log` with a personal audit-workbook export, and a rules amendment: Log entries and manifests become committer-deletable (never updatable — that delete path is what lawful undo uses), the action-confirmation clause is fixed and hash-bound to the stored preview, and the Baseline registry fails closed — nothing may cite the unratified draft. The world only ever changes inside a player-caused wake; there is no scheduler. Nothing in Phase 2 is deployed either, and production genesis remains a separate guarded step.

## Changelog

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
