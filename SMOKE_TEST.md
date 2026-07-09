# Cowboy City Lore — Smoke Test Checklist

End-to-end verification for realm members and the host before announcing cutover from the legacy PHP app. Run on a real device (phone + laptop) against production or staging with Firebase rules deployed.

**Prerequisites:** `.env.local` configured, `npm run build && npm start` running, Firebase Auth (Email/Password) enabled, `firestore.rules` and `storage.rules` deployed (`firebase deploy --only firestore:rules,storage`).

---

## 1. Auth & Access

- [ ] Open `/` while signed out — landing page shows with Sign In / Sign Up
- [ ] Sign up with a new email at `/signup` — redirects to feed, user doc created in Firestore
- [ ] Sign out and sign back in at `/login`
- [ ] Signed-out users cannot access `/factions`, `/posts/new`, or `/sheriff`
- [ ] Non-admin users cannot access `/sheriff` (redirects to feed)

## 2. Mobile Navigation (phone width ≤ 768px)

- [ ] Nav bar fits without horizontal scroll
- [ ] Hamburger menu opens — shows Factions, Timeline, Lore Graph, New Post
- [ ] Faction/character switcher visible in mobile menu (or nav on tablet+)
- [ ] All primary routes load without layout breakage: `/`, `/factions`, `/timeline`, `/lore-graph`, `/posts/new`

## 3. Factions & Identity

- [ ] `/factions` lists all factions in a responsive grid
- [ ] Create a faction at `/factions/new` — appears in directory
- [ ] Open faction profile `/factions/[slug]` — structured info + custom HTML layer + feed overlay
- [ ] Add characters on faction edit page; select faction + character in nav switcher
- [ ] Multi-owner: second user added as owner can edit faction and post as that faction

## 4. Posts & Feed

- [ ] Create each post type at `/posts/new`: announcement, build, lore, debate, event, wiki
- [ ] Build post: upload 2+ images — carousel displays on post detail
- [ ] Global feed `/` shows posts chronologically; faction filter works
- [ ] Admin: pinned announcement stays at top of feed
- [ ] Post detail `/posts/[id]` renders body, faction colors, character attribution

## 5. Debates, Polls & Reactions

- [ ] Debate post shows thread with for / against / neutral reply stances
- [ ] Create poll on debate (faction member) — vote once per user, tallies update
- [ ] Reaction bar: agrees / disputes / witnessed — one reaction per user per post

## 6. Wiki & Lore Graph

- [ ] Faction wiki tab loads sections; owner can add/reorder/edit sections
- [ ] `@mention` in post or wiki body creates links (faction slug, character, post id)
- [ ] `/lore-graph` lists mention edges; filter by type works
- [ ] `/timeline` shows condensed chronological entries grouped by month

## 7. Custom HTML & Sheriff Queue

- [ ] Faction owner submits custom HTML at `/factions/[slug]/edit` — status becomes `pending_review`
- [ ] Sheriff at `/sheriff` sees submission in HTML Approval Queue with preview
- [ ] Approve — `liveHtml` appears on faction profile design layer
- [ ] Reject — pending HTML cleared, design layer unchanged

## 8. Sheriff Moderation

- [ ] Sheriff deletes a post from Post Moderation table — removed from feed
- [ ] Sheriff grants/revokes admin on another user
- [ ] Sheriff can delete a faction from Faction Management

## 9. Firestore Rules (manual audit)

Verify these behaviors match `firestore.rules` (permission denied = pass):

| Action | Expected |
|--------|----------|
| Unauthenticated read of posts | Denied |
| Member posts as their faction | Allowed |
| Non-member posts as faction | Denied |
| Non-owner edits wiki | Denied |
| Non-admin sets `isAdmin` on signup | Denied (always false) |
| Owner submits `pendingHtml` only | Allowed |
| Owner directly sets `liveHtml` | Denied |
| Admin approves/rejects HTML | Allowed |
| User votes poll twice | Denied (update only own vote) |
| User changes another user's reaction | Denied |

## 10. Storage & External Access

- [ ] Build carousel images upload and display (Storage rules deployed)
- [ ] Faction banner/sigil upload on edit page works
- [ ] Cloudflare Tunnel URL loads app over HTTPS (if production host configured)
- [ ] Friends can sign up and use the app from external network

## 11. Migration (one-time, if applicable)

- [ ] `npm run migrate` run with service account — legacy users/posts mapped to factions/characters
- [ ] Spot-check migrated posts in feed and faction pages

---

## Sign-off

| Tester | Date | Environment | Pass? |
|--------|------|-------------|-------|
| | | local / tunnel URL | |

**Known host setup (not automated):** Firebase Console (Auth, Firestore, Storage), first Sheriff (`isAdmin: true`), rules deploy, Cloudflare Tunnel service, `.env.local` on production laptop.
