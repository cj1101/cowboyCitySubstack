# Cowboy City Lore — Implementation Checklist



Track v1 feature completion. Check items as they ship. Phase 0 items are marked where applicable.



## Phase 0 — Foundation



- [x] Next.js 15 App Router + TypeScript + Tailwind scaffold

- [x] Git repo + `.gitignore`

- [x] Legacy PHP prototype moved to `legacy/`

- [x] Firebase client config via env vars (`lib/firebase.ts`)

- [x] Firebase Admin SDK setup (`lib/firebase-admin.ts`)

- [x] `firestore.rules` and `storage.rules` sketches

- [x] Cowboy/western dark theme (ported from `legacy/style.css`)

- [x] `/login` and `/signup` pages (email/password)

- [x] Auth context/provider (`AuthProvider`)

- [x] `README.md` and `.env.example`

- [x] `npm run build` passes



## Phase 1 — Identity



- [x] Faction CRUD (create, read, update, delete)

- [x] Multi-owner assignment (`ownerUids` / `faction_members`)

- [x] Character CRUD per faction

- [x] `FactionSwitcher` component in nav

- [x] Faction directory page (`/factions`)

- [x] Structured faction profile pages (`/factions/[slug]`)

- [x] Faction edit page (`/factions/[slug]/edit`)



## Phase 2 — Posts & Feed



- [x] Post type: Announcement

- [x] Post type: Build (with carousel)

- [x] Post type: Lore

- [x] Post type: Debate

- [x] Post type: Event

- [x] Post type: Wiki

- [x] Create post flow (`/posts/new`) with type picker + character selector

- [x] Global chronological feed (`/`)

- [x] Faction filter on feed

- [x] Pinned admin announcements

- [x] Firebase Storage carousel upload for builds

- [x] TipTap rich text editor



## Phase 3 — Debates, Polls, Reactions



- [x] Debate thread UI on post detail (`/posts/[id]`)

- [x] Reply stance tags: for / against / neutral

- [x] Poll create inside debate posts

- [x] Poll vote (one vote per user)

- [x] Reaction bar: agrees / disputes / witnessed

- [x] One reaction per user per post



## Phase 4 — Wiki + Lore Graph



- [x] Per-faction wiki with sections (large content)

- [x] Wiki tab on faction page

- [x] Wiki editor with section reorder

- [x] `@mention` parsing on save (factions, characters, posts)

- [x] Lore graph page (`/lore-graph`)

- [x] Mention autocomplete in editor



## Phase 5 — Prototype Parity



- [x] Custom HTML faction page design layer

- [x] Glassmorphism feed overlay on faction pages

- [x] Submit custom HTML for approval (`pendingHtml`)

- [x] Sheriff HTML approval queue (approve/reject)

- [x] Visual design parity with legacy prototype



## Phase 6 — Admin, Deploy, Migration



- [x] Sheriff dashboard (`/sheriff`)

- [x] Delete any post (admin moderation)

- [x] Manage users and factions (admin)

- [x] Sheriff HTML approval queue (approve/reject faction `pendingHtml`)

- [x] Hardened `firestore.rules` (deploy-ready)

- [x] Hardened `storage.rules` (deploy-ready)

- [x] `firebase.json` for rules deploy

- [x] Data migration script (`scripts/migrate-legacy-data.ts`)

- [x] `DEPLOY.md` with Cloudflare Tunnel steps

- [x] README: Production on Laptop, Cloudflare Tunnel, Switching Computers

- [x] `.env.example` completeness check



## Phase 7 — Polish & QA



- [x] Mobile responsive pass on all routes

- [x] Firestore rules audit (documented in `SMOKE_TEST.md` §9)

- [x] End-to-end smoke test checklist (`SMOKE_TEST.md`)

- [x] Timeline condensed view (`/timeline`) — optional, cut last



## Transcript Requirements (summary)



| Feature | Status |

|---------|--------|

| Faction identity (post as character) | [x] |

| Multi-faction owners | [x] |

| 6 post types | [x] |

| Global chronological feed + filters | [x] |

| Debates with stance tags | [x] |

| Polls in debates | [x] |

| Build carousels | [x] |

| Per-faction wiki | [x] |

| @mention lore linking | [x] |

| agrees / disputes / witnessed reactions | [x] |

| Sheriff delete any post | [x] |

| Open signup | [x] |

| Responsive mobile UI | [x] |



## Prototype Parity (from legacy PHP)



| Feature | Status |

|---------|--------|

| Custom HTML faction pages | [x] |

| HTML approval workflow | [x] |

| Rich text editor (TipTap) | [x] |

| Sheriff's Dashboard | [x] |

| Reuse `cowboycityrealm` Firebase project | [x] |


