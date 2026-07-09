# Cowboy City Lore — Production Deployment

Deploy the Next.js app to **IONOS** at **suarezhouse.net**. This app requires a **Node.js runtime** — it cannot run on FTP-only shared hosting.

## Hosting requirements

| IONOS product | Works? | Notes |
|---------------|--------|-------|
| **VPS / Cloud Server** | Yes | Install Node.js 20+, run `npm start`, reverse-proxy with nginx |
| **Dedicated server** | Yes | Same as VPS |
| **Shared web hosting** (FTP only) | No | No Node.js process — FileZilla upload alone will not work |

**FileZilla** is useful for uploading project files to a VPS, but the server must also run Node.js and keep the process alive.

---

## Before you start — gather these details

Fill in when you have IONOS access (do not commit passwords to git):

| Item | Your value |
|------|------------|
| IONOS product type | `________________` (VPS / shared / other) |
| Server hostname / IP | `________________` |
| SSH username | `________________` |
| SSH port | `22` (default) |
| App directory on server | e.g. `/var/www/cowboy-city-lore` |
| Public URL | `https://suarezhouse.net` or `https://lore.suarezhouse.net` |
| Node.js version on server | `20+` required |

---

## Deploy checklist

Use this when your server credentials are ready:

- [ ] Confirm server supports Node.js 20+ (`node -v`)
- [ ] Upload project files (FileZilla SFTP or `git clone`)
- [ ] Copy `.env.local` to server (never commit)
- [ ] Run `npm install && npm run build`
- [ ] Start app with PM2: `pm2 start npm --name cowboy-city -- start`
- [ ] Configure nginx reverse proxy → `http://127.0.0.1:3000`
- [ ] Point `suarezhouse.net` DNS A record to server IP
- [ ] Enable HTTPS (Let's Encrypt / IONOS SSL)
- [ ] Add production domain to Firebase Auth authorized domains
- [ ] Deploy Firebase rules: `firebase deploy --only firestore:rules,storage`
- [ ] Run smoke test: [SMOKE_TEST.md](SMOKE_TEST.md)

---

## 1. Local production build (test before upload)

On your dev machine:

```powershell
npm install
npm run build
npm start
```

Open **http://localhost:3000** and verify. Stop with `Ctrl+C` when done.

---

## 2. Upload files to IONOS

### Option A — FileZilla (SFTP)

1. Open FileZilla → **File → Site Manager → New Site**
2. Protocol: **SFTP** (not plain FTP, if available)
3. Host: your server IP or hostname
4. Logon type: Normal (username + password) or Key file
5. Upload the project folder **excluding**:
   - `node_modules/` (reinstall on server)
   - `.next/` (rebuild on server)
   - `.git/` (optional)
6. **Do upload** (securely, outside git):
   - `.env.local`
   - `firebase-service-account.json` (only if running migration on server)

### Option B — Git (preferred if SSH available)

```bash
ssh YOUR_USER@YOUR_SERVER_IP
cd /var/www
git clone YOUR_REPO_URL cowboy-city-lore
cd cowboy-city-lore
```

Copy `.env.local` separately (scp, SFTP, or password manager).

---

## 3. Install Node.js on the server (VPS)

If Node is not installed (Ubuntu/Debian example):

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # should print v20.x or higher
```

---

## 4. Build and run on the server

```bash
cd /var/www/cowboy-city-lore   # your app directory
npm install
npm run build
npm start                      # test — listens on port 3000
```

### Keep it running with PM2

```bash
sudo npm install -g pm2
pm2 start npm --name cowboy-city -- start
pm2 save
pm2 startup                    # follow printed command for boot persistence
```

---

## 5. Reverse proxy (nginx)

Expose the app on port 80/443. Example `/etc/nginx/sites-available/cowboy-city`:

```nginx
server {
    listen 80;
    server_name suarezhouse.net www.suarezhouse.net;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Enable and reload:

```bash
sudo ln -s /etc/nginx/sites-available/cowboy-city /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

For a subdomain (e.g. `lore.suarezhouse.net`), change `server_name` and add a DNS A record for `lore`.

### HTTPS

Use IONOS SSL or Certbot:

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d suarezhouse.net -d www.suarezhouse.net
```

---

## 6. Firebase configuration for production

### Authorized domains

In Firebase Console → Authentication → Settings → Authorized domains, add:

- `suarezhouse.net`
- `www.suarezhouse.net`
- `lore.suarezhouse.net` (if using subdomain)

### Deploy security rules

From your dev machine (requires [Firebase CLI](https://firebase.google.com/docs/cli)):

```powershell
firebase login
firebase use cowboycityrealm
firebase deploy --only firestore:rules,storage
```

Rules live in `firestore.rules` and `storage.rules` (see `firebase.json`).

### Environment variables on server

Copy `.env.local` to the server. All `NEXT_PUBLIC_FIREBASE_*` values are baked in at **build time** — if you change them, run `npm run build` again.

| Variable | Required on server |
|----------|-------------------|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Yes |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | Yes |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | Yes |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | Yes |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | Yes |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | Yes |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | Only for `npm run migrate` |

---

## 7. One-time data migration (legacy PHP schema)

If you still have old `users.username` / `posts.author_username` data:

```bash
npm run migrate
```

Review Firestore after migration before announcing cutover.

---

## 8. Smoke test

Run the full checklist in **[SMOKE_TEST.md](SMOKE_TEST.md)** before announcing cutover:

- [ ] Sign up / sign in at `https://suarezhouse.net`
- [ ] Create a faction and post
- [ ] Sheriff dashboard at `/sheriff` (admin user)
- [ ] Images upload (Storage rules deployed)
- [ ] App survives server reboot (PM2 running)

---

## Troubleshooting

| Issue | Check |
|-------|--------|
| Site not loading | DNS A record points to server IP? nginx running? |
| 502 Bad Gateway | Is `pm2 status` showing cowboy-city online? Port 3000 listening? |
| Firebase permission denied | Deploy rules; user signed in; domain in Firebase Auth |
| Auth redirect fails | Add `suarezhouse.net` to Firebase authorized domains |
| Admin can't access `/sheriff` | Set `isAdmin: true` on user doc in Firestore |
| Changes not visible after deploy | Re-run `npm run build` after env changes |

---

## Security notes

- Keep `.env.local` and service account JSON off git and shared drives.
- Use SFTP (not plain FTP) when uploading secrets via FileZilla.
- Only trusted friends should have accounts (open signup within the friend group).
- Enable HTTPS before sharing the public URL.

---

## Alternative: Cloudflare Tunnel (laptop hosting)

If you prefer running on a Windows laptop instead of IONOS, see the archived laptop + Cloudflare Tunnel flow in git history, or run locally with `npm run dev` for testing.
