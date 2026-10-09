# Deploy Cowboy City Lore

The primary host is **Vercel**. Firebase Auth, Firestore, and Storage stay on the `cowboycityrealm` project. The site does not need a service-account private key.

## 1. Firebase, before the first visit

1. Firebase Console → Authentication → Sign-in method → enable **Email/Password**.
2. Edit `rootAdminEmails()` in `firestore.rules` and the matching list in `storage.rules` (`isRootAdmin`). Use the real sheriff emails. Deploy:

   ```bash
   npm install -g firebase-tools
   firebase login
   firebase use cowboycityrealm
   firebase deploy --only firestore,storage
   ```

   That publishes `firestore.rules`, `firestore.indexes.json`, and `storage.rules`.

3. After Vercel assigns a URL, add it under Authentication → Settings → **Authorized domains**. Add a custom domain too if you attach one. Local `localhost` is already allowed.

## 2. Import into Vercel

1. Vercel → Add New → Project → import this GitHub repository.
2. Framework preset: **Next.js**. Build command: `npm run build`. Output: Next.js default.
3. Environment variables (all public web config):

   - `NEXT_PUBLIC_FIREBASE_API_KEY`
   - `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`
   - `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
   - `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`
   - `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`
   - `NEXT_PUBLIC_FIREBASE_APP_ID`
   - `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID` (optional)

   Copy them from Firebase Console → Project settings → Your apps. Do not add `FIREBASE_PRIVATE_KEY` or a service-account JSON.

4. Deploy. If you change any `NEXT_PUBLIC_*` value later, redeploy so the client bundle picks it up.

## 3. First sheriff

1. Open the Vercel URL and sign up with an email that is in `rootAdminEmails()`.
2. The app asks Firestore to mark that account approved and `isAdmin: true`. Rules allow it only for those emails.
3. Open `/sheriff`. Approve friends, or invite their email so signup approves them automatically.

## 4. Checks

- A new account sees the waiting screen and cannot open the feed.
- After approval they can found two cities, post, and message.
- Storage uploads fail for anyone who is not approved.

Optional legacy import (Admin SDK, not used by the website):

```bash
npm run migrate
```

## Alternative: IONOS VPS

A Node 20 VPS can still run `npm run build && npm start` behind nginx on port 3000, with PM2 keeping the process up. That path needs the same `NEXT_PUBLIC_FIREBASE_*` variables in `.env.local` before the build, plus the VPS hostname added to Firebase authorized domains. Shared FTP hosting cannot run this app. Vercel is the supported setup.
