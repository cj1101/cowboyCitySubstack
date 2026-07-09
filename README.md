# Cowboy City Lore Platform

A private lore social network for the Cowboy City Minecraft realm — factions, characters, debates, wiki, and a chronological feed. Built with Next.js 15, Firebase, and Tailwind CSS.

The original PHP + Firebase prototype lives in [`legacy/`](legacy/) for reference during migration.

## Prerequisites

- **Node.js** 20+ and npm
- **Firebase project** — reuses the existing `cowboycityrealm` project
- **Firebase Admin service account** JSON (for migration script and server-side operations)
- **Git** (optional, for version control)
- **IONOS server** with Node.js 20+ at **suarezhouse.net** (see [DEPLOY.md](DEPLOY.md))

## Environment Variables

1. Copy the example file:

   ```bash
   cp .env.example .env.local
   ```

2. Fill in values from your Firebase console (Project Settings → General → Your apps):

   | Variable | Description |
   |----------|-------------|
   | `NEXT_PUBLIC_FIREBASE_API_KEY` | Web API key |
   | `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | e.g. `cowboycityrealm.firebaseapp.com` |
   | `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | e.g. `cowboycityrealm` |
   | `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | e.g. `cowboycityrealm.firebasestorage.app` |
   | `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | Messaging sender ID |
   | `NEXT_PUBLIC_FIREBASE_APP_ID` | Web app ID |
   | `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID` | Analytics ID (optional) |

3. For server-side Firebase Admin (migration script), either:
   - Set `FIREBASE_SERVICE_ACCOUNT_PATH=./firebase-service-account.json`, or
   - Set `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, and `FIREBASE_PRIVATE_KEY`

   **Never commit** `.env.local` or service account JSON files.

See [`.env.example`](.env.example) for all variables.

## Local Dev

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Firebase Auth setup

In the Firebase Console:

1. Enable **Email/Password** sign-in under Authentication → Sign-in method.
2. Create a Firestore database if not already present.
3. Deploy rules: `firebase deploy --only firestore:rules,storage`

### First Sheriff (admin)

After signing up, set `isAdmin: true` on your user document in Firestore (`users/{uid}`). Then open `/sheriff` for moderation and HTML approvals.

## Production on IONOS

The app deploys to **suarezhouse.net** on an IONOS VPS with Node.js:

```bash
npm run build
npm start
```

Use **PM2** on the server so `npm start` survives reboots. nginx reverse-proxies HTTPS to port 3000.

Full step-by-step (FileZilla upload, nginx, Firebase, checklist): **[DEPLOY.md](DEPLOY.md)**

> **Note:** This is a Next.js app — FTP-only shared hosting will not work. The server must run Node.js.

## Switching Computers

1. Clone or copy this repo to the new machine.
2. Run `npm install`.
3. Copy these files securely (USB, password manager, encrypted share — **not** git):
   - `.env.local`
   - `firebase-service-account.json` (if using path-based Admin auth)
4. On the new host (or IONOS server):
   ```bash
   npm run build
   npm start
   ```
5. Configure nginx + PM2 on the server (see DEPLOY.md).
6. Deploy Firebase rules if you changed them: `firebase deploy --only firestore:rules,storage`

If migrating from the old PHP app, run the one-time migration on a machine with Admin credentials:

```bash
npm run migrate
```

## Project Structure

```
app/                  # Next.js App Router pages
components/           # React components (auth, factions, sheriff, …)
lib/                  # Firebase client + admin SDK, Firestore helpers
scripts/              # One-time migration (migrate-legacy-data.ts)
legacy/               # Original PHP prototype (reference only)
firestore.rules       # Firestore security rules
storage.rules         # Storage security rules
firebase.json         # Firebase deploy config
DEPLOY.md             # Production + IONOS (suarezhouse.net) runbook
IMPLEMENTATION_CHECKLIST.md  # Feature tracking
SMOKE_TEST.md             # End-to-end smoke test checklist
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Development server (Turbopack) |
| `npm run build` | Production build |
| `npm start` | Run production server |
| `npm run migrate` | Migrate legacy Firestore schema (one-time) |

## Current Status

**v1 complete.** All phases (0–7) shipped. See [`IMPLEMENTATION_CHECKLIST.md`](IMPLEMENTATION_CHECKLIST.md) and run [`SMOKE_TEST.md`](SMOKE_TEST.md) before production cutover.

## License

Private project for the Cowboy City realm friend group.
