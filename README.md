# Cowboy City Lore

A private multimedia chronicle for Charles and his friends. Cities such as Cascadia, Cowboy City, Evan City, Coronado Springs, Turtle Shores, Kelpington, Chess City, and Wythria post updates about their Minecraft realm. The worlds stay independent and aware of each other. Realm-wide bodies such as the UR and the ICTC tribunal live in the lore, not in a separate permissions system.

Built with Next.js 15, React 19, TypeScript, Tailwind 4, TipTap, and Firebase Auth, Firestore, and Storage on the `cowboycityrealm` project. Deployed on Vercel.

The original PHP prototype is in [`legacy/`](legacy/) for reference.

## What members can do

- Request to join. They cannot post or read members-only posts, cities, maps, wiki, or messages until a sheriff approves them.
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

The site does **not** use a Firebase Admin service account. Approvals, invites, messages, and notices are written by the browser and enforced by `firestore.rules` and `storage.rules`.

`npm run migrate` is optional and still accepts a service account if you need to import the old PHP data. Do not put that key in Vercel.

For local emulator work only, set `NEXT_PUBLIC_USE_FIREBASE_EMULATORS=true`. Leave it unset in production.

## Sheriffs

Root sheriffs are email addresses hardcoded in the rules, not an environment variable:

- `firestore.rules` → `rootAdminEmails()`
- `storage.rules` → the same list inside `isRootAdmin()`

The lists are `charlie@suarezhouse.net` and `cjtheswimmer1101@gmail.com`. Keep both files identical, then deploy the rules. A root sheriff signs up like anyone else. On the next page load the client asks Firestore to mark that account approved and `isAdmin: true`. The rules allow it only when the Auth email is on the list.

From `/sheriff` a sheriff can:

- approve, deny, suspend, or remove a person
- invite an email (that address is approved automatically when it signs up)
- grant or revoke the sheriff flag on another approved person

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

Enable Email/Password in Firebase Authentication before using production. Deploy rules and indexes when they change:

```bash
firebase login
firebase use cowboycityrealm
firebase deploy --only firestore,storage
```

`firebase deploy --only firestore` publishes `firestore.rules` and `firestore.indexes.json`. Storage rules deploy with the `storage` target.

## Production on Vercel

1. Import this GitHub repo in Vercel. Framework preset: Next.js. Root directory: the repo root.
2. Add the seven `NEXT_PUBLIC_FIREBASE_*` variables. Redeploy after changing them so they are baked into the client bundle.
3. In Firebase Console → Authentication → Settings → Authorized domains, add the Vercel domain (for example `your-project.vercel.app`) and any custom domain.
4. Put the real sheriff emails in `firestore.rules` and `storage.rules`, then `firebase deploy --only firestore,storage`.
5. Open the site, sign up with a root sheriff email, and approve everyone else from `/sheriff`.

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

## License

Private project for the Cowboy City realm friend group.
