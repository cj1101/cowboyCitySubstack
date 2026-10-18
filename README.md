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
firestore.rules       # Firestore security rules
firestore.indexes.json
storage.rules
firebase.json
scripts/              # Optional legacy migration (Admin SDK)
tests/rules.test.ts   # Emulator tests for approval, DMs, city ownership
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
| `npm run emulators` | Auth, Firestore, and Storage emulators |
| `npm run migrate` | Optional legacy import (needs a service account) |

## Changelog

- 2026-10-17 — Security (PR-A): Next.js 15.5.20 → 15.5.27 (clears all 12 `next` advisories, incl. 2 critical RCEs in the Image Optimization API — GHSA-p293-qw3h-jr36, GHSA-2xp9-vwfh-vxw4); `eslint-config-next` in lockstep; `sharp` → 0.35.5 via `overrides` (clears 3 libvips CVEs on the live `next/image` path). (PR: security/pr-a-next-sharp)
- 2026-10-17 — CI: non-required `Rules tests (non-required)` job added to `.github/workflows/ci.yml` (`npm run test:rules` on the Firebase emulators; Java 21 + Node 24; emulator debug logs uploaded as artifacts on failure). It is not in branch protection and stays non-required until green and stable on unmodified `master`. (PR: ci/test-rules-job)
- 2026-10-17 — Development workflow documented (this section): README-with-every-PR rule, PR template added. (PR: docs/readme-convention)
- 2026-10-17 — Phase 0: CI established. GitHub Actions workflow `.github/workflows/ci.yml` runs `Install · Typecheck · Lint · Build` on PRs and pushes to `master`; branch protection requires the check. Node pinned to 24 to match Vercel. (PR #14)

## License

Private project for the Cowboy City realm friend group.
