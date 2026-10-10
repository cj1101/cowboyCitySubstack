# Deploy Cowboy City Lore

The primary host is **Vercel**. Firebase Auth, Firestore, and Storage stay on the `cowboycityrealm` project. The site does not need a service-account private key.

## 1. Firebase, before the first visit

1. Firebase Console → Authentication → Sign-in method → enable **Email/Password**.
2. Root sheriffs are `charlie@suarezhouse.net` and `cjtheswimmer1101@gmail.com` in both `rootAdminEmails()` (`firestore.rules`) and `isRootAdmin()` (`storage.rules`). Storage is the bucket `cowboycityrealm.firebasestorage.app` in `us-east1`. It was created in production mode, so every upload and download is denied until `storage.rules` is released onto that bucket. `firebase.json` and `.firebaserc` pin the `media` target to that bucket. Deploy:

   ```bash
   npx firebase login
   npx firebase deploy --only firestore:rules,firestore:indexes,storage --project cowboycityrealm
   ```

   That publishes `firestore.rules`, `firestore.indexes.json`, and `storage.rules` onto `cowboycityrealm.firebasestorage.app`. The client must use `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=cowboycityrealm.firebasestorage.app` on Vercel preview and production. Redeploy the site after changing that variable so the value is baked into the client bundle.

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

1. Open the Vercel URL and create an account. Every new account is a member. There is no waiting room.
2. Sign up with an email in `rootAdminEmails()` if you want `/sheriff`. The app asks Firestore once to set `isAdmin: true`. The July rules reject that write. The new rules allow it. A refusal does not reload the page.
3. Open `/sheriff` to suspend or remove members after the new rules are deployed.

## 4. Checks

- A new account lands on the feed. It does not see "Waiting for the Sheriff".
- A suspended or removed account sees a single blocked screen and can still open settings.
- Storage uploads fail for suspended and removed accounts.

Optional legacy import (Admin SDK, not used by the website):

```bash
npm run migrate
```

## Alternative: IONOS VPS

A Node 20 VPS can still run `npm run build && npm start` behind nginx on port 3000, with PM2 keeping the process up. That path needs the same `NEXT_PUBLIC_FIREBASE_*` variables in `.env.local` before the build, plus the VPS hostname added to Firebase authorized domains. Shared FTP hosting cannot run this app. Vercel is the supported setup.
