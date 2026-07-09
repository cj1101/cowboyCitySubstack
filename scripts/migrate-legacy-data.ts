/**
 * One-time migration: legacy users.username + posts.author_username
 * → factions / characters / faction_members schema.
 *
 * Usage:
 *   npm run migrate
 *
 * Requires Firebase Admin credentials in .env.local (see .env.example).
 * Safe to re-run: skips users that already have a faction with matching slug.
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue, type Firestore } from "firebase-admin/firestore";

function loadEnvLocal(): void {
  const envPath = resolve(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function loadServiceAccount(): Record<string, string> {
  const accountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (accountPath) {
    const absolutePath = resolve(process.cwd(), accountPath);
    return JSON.parse(readFileSync(absolutePath, "utf8"));
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (projectId && clientEmail && privateKey) {
    return { projectId, clientEmail, privateKey };
  }

  throw new Error(
    "Missing Firebase Admin credentials. Set FIREBASE_SERVICE_ACCOUNT_PATH or inline env vars."
  );
}

function getDb(): Firestore {
  if (getApps().length === 0) {
    initializeApp({ credential: cert(loadServiceAccount() as Parameters<typeof cert>[0]) });
  }
  return getFirestore();
}

function slugify(username: string): string {
  return username
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

interface LegacyUser {
  uid: string;
  username?: string;
  email?: string;
  displayName?: string;
  isAdmin?: boolean;
  live_html?: string;
  pending_html?: string;
  status?: string;
}

interface LegacyPost {
  id: string;
  author_username?: string;
  factionId?: string;
  characterId?: string;
  title?: string;
  body?: string;
  type?: string;
  createdAt?: FirebaseFirestore.Timestamp;
}

const DEFAULT_COLORS = { primary: "#5a3e2b", secondary: "#d4af37" };

async function migrateUsers(db: Firestore): Promise<Map<string, string>> {
  const usernameToFactionId = new Map<string, string>();
  const usersSnap = await db.collection("users").get();

  for (const userDoc of usersSnap.docs) {
    const data = userDoc.data() as LegacyUser;
    const username = data.username?.trim();
    if (!username) {
      console.log(`  skip user ${userDoc.id}: no username field`);
      continue;
    }

    const slug = slugify(username);
    const existing = await db
      .collection("factions")
      .where("slug", "==", slug)
      .limit(1)
      .get();

    if (!existing.empty) {
      const factionId = existing.docs[0].id;
      usernameToFactionId.set(username.toLowerCase(), factionId);
      console.log(`  skip faction for @${username}: already exists (${factionId})`);
      continue;
    }

    const factionRef = db.collection("factions").doc();
    const htmlStatus =
      data.status === "pending_review"
        ? "pending_review"
        : data.live_html
          ? "approved"
          : undefined;

    await factionRef.set({
      name: username,
      slug,
      colors: DEFAULT_COLORS,
      bio: "",
      ownerUids: [userDoc.id],
      liveHtml: data.live_html ?? null,
      pendingHtml: data.pending_html ?? null,
      htmlStatus: htmlStatus ?? null,
      createdAt: FieldValue.serverTimestamp(),
      migratedFromUser: userDoc.id,
    });

    await db
      .collection("faction_members")
      .doc(`${userDoc.id}_${factionRef.id}`)
      .set({
        uid: userDoc.id,
        factionId: factionRef.id,
        role: "owner",
      });

    const characterRef = db.collection("characters").doc();
    await characterRef.set({
      factionId: factionRef.id,
      name: username,
      title: data.isAdmin ? "Sheriff" : "Citizen",
      isActive: true,
      createdAt: FieldValue.serverTimestamp(),
      migratedFromUser: userDoc.id,
    });

    usernameToFactionId.set(username.toLowerCase(), factionRef.id);
    console.log(`  created faction "${username}" (${factionRef.id}) + character (${characterRef.id})`);
  }

  return usernameToFactionId;
}

async function migratePosts(
  db: Firestore,
  usernameToFactionId: Map<string, string>
): Promise<void> {
  const postsSnap = await db.collection("posts").get();
  let migrated = 0;
  let skipped = 0;

  for (const postDoc of postsSnap.docs) {
    const data = postDoc.data() as LegacyPost;

    if (data.factionId && data.characterId) {
      skipped++;
      continue;
    }

    const authorUsername = data.author_username?.toLowerCase();
    if (!authorUsername) {
      console.log(`  skip post ${postDoc.id}: no author_username`);
      skipped++;
      continue;
    }

    const factionId = usernameToFactionId.get(authorUsername);
    if (!factionId) {
      console.log(`  skip post ${postDoc.id}: unknown author @${data.author_username}`);
      skipped++;
      continue;
    }

    const charactersSnap = await db
      .collection("characters")
      .where("factionId", "==", factionId)
      .limit(1)
      .get();

    if (charactersSnap.empty) {
      console.log(`  skip post ${postDoc.id}: no character for faction ${factionId}`);
      skipped++;
      continue;
    }

    const characterId = charactersSnap.docs[0].id;
    const postType = ["announcement", "build", "lore", "debate", "event", "wiki"].includes(
      data.type ?? ""
    )
      ? data.type
      : "lore";

    await postDoc.ref.update({
      factionId,
      characterId,
      type: postType,
      title: data.title ?? "Untitled",
      body: data.body ?? "",
      mentions: { factions: [], characters: [], posts: [] },
      pinned: false,
      migratedFromAuthor: data.author_username,
      updatedAt: FieldValue.serverTimestamp(),
    });

    migrated++;
    console.log(`  migrated post ${postDoc.id} (@${data.author_username})`);
  }

  console.log(`\nPosts: ${migrated} migrated, ${skipped} skipped`);
}

async function main(): Promise<void> {
  loadEnvLocal();
  const db = getDb();

  console.log("=== Cowboy City Legacy Data Migration ===\n");
  console.log("Step 1: Migrate users → factions + characters\n");

  const usernameToFactionId = await migrateUsers(db);

  console.log(`\nStep 2: Migrate posts (author_username → factionId/characterId)\n`);
  await migratePosts(db, usernameToFactionId);

  console.log("\n=== Migration complete ===");
  console.log("Review Firestore data, then deploy rules: firebase deploy --only firestore:rules,storage");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
