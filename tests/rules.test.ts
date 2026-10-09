import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  setDoc,
  Timestamp,
  updateDoc,
} from "firebase/firestore";
import { ref, uploadString } from "firebase/storage";

const PROJECT_ID = "cowboycityrealm";

async function seedUser(
  env: RulesTestEnvironment,
  uid: string,
  data: Record<string, unknown>
) {
  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), "users", uid), data);
  });
}

async function main() {
  const env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync("firestore.rules", "utf8") },
    storage: { rules: readFileSync("storage.rules", "utf8") },
  });

  const postBody = {
    type: "lore",
    factionId: "city1",
    characterId: "",
    title: "Harbor lights",
    body: "A note",
    cityIds: ["city1"],
    referencedPostIds: [],
    spoiler: false,
    pinned: false,
    status: "published",
    authorUid: "friend",
    createdAt: Timestamp.fromDate(new Date("2024-06-01T00:00:00Z")),
  };

  await env.clearFirestore();
  await seedUser(env, "friend", {
    email: "friend@realm.test",
    status: "pending",
    isAdmin: false,
  });
  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), "posts", "p1"), postBody);
  });
  const pending = env.authenticatedContext("friend", { email: "friend@realm.test" });
  await assertFails(getDoc(doc(pending.firestore(), "posts", "p1")));
  await assertFails(
    updateDoc(doc(pending.firestore(), "users", "friend"), { status: "approved", isAdmin: true })
  );
  await assertSucceeds(
    updateDoc(doc(pending.firestore(), "users", "friend"), { displayName: "Friend" })
  );
  console.log("ok approval gate");

  await env.clearFirestore();
  await seedUser(env, "charles", {
    email: "charlie@suarezhouse.net",
    status: "pending",
    isAdmin: false,
  });
  await seedUser(env, "friend", {
    email: "friend@realm.test",
    status: "pending",
    isAdmin: false,
  });
  const charles = env.authenticatedContext("charles", { email: "charlie@suarezhouse.net" });
  await assertSucceeds(
    updateDoc(doc(charles.firestore(), "users", "charles"), { status: "approved", isAdmin: true })
  );
  await assertSucceeds(
    updateDoc(doc(charles.firestore(), "users", "friend"), { status: "approved" })
  );
  console.log("ok root allowlist");

  await env.clearFirestore();
  await seedUser(env, "friend", {
    email: "friend@realm.test",
    status: "approved",
    isAdmin: false,
  });
  await seedUser(env, "other", {
    email: "other@realm.test",
    status: "approved",
    isAdmin: false,
  });
  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), "posts", "live"), postBody);
    await setDoc(doc(context.firestore(), "drafts", "secret"), {
      ...postBody,
      status: "draft",
      authorUid: "other",
      title: "Draft",
    });
    const legacy = { ...postBody, title: "Legacy harbor" };
    delete (legacy as { status?: string }).status;
    await setDoc(doc(context.firestore(), "posts", "legacy"), legacy);
  });
  const friend = env.authenticatedContext("friend", { email: "friend@realm.test" });
  const other = env.authenticatedContext("other", { email: "other@realm.test" });
  await assertSucceeds(getDoc(doc(friend.firestore(), "posts", "live")));
  await assertSucceeds(getDoc(doc(other.firestore(), "drafts", "secret")));
  await assertFails(getDoc(doc(friend.firestore(), "drafts", "secret")));
  const legacySnap = await assertSucceeds(getDoc(doc(friend.firestore(), "posts", "legacy")));
  assert.equal(legacySnap.data()?.status, undefined);
  const listed = await assertSucceeds(
    getDocs(query(collection(friend.firestore(), "posts"), orderBy("createdAt", "desc")))
  );
  assert.deepEqual(listed.docs.map((d) => d.id).sort(), ["legacy", "live"]);
  console.log("ok published vs draft");

  await assertSucceeds(
    setDoc(doc(friend.firestore(), "factions", "city1"), {
      name: "Cascadia",
      slug: "cascadia",
      ownerUids: ["friend"],
      colors: { primary: "#5a3e2b", secondary: "#3d2817" },
    })
  );
  await assertFails(
    setDoc(doc(other.firestore(), "factions", "city2"), {
      name: "Nope",
      slug: "nope",
      ownerUids: ["friend"],
      colors: { primary: "#5a3e2b", secondary: "#3d2817" },
    })
  );
  await assertSucceeds(
    setDoc(doc(friend.firestore(), "faction_members", "friend_city1"), {
      uid: "friend",
      factionId: "city1",
      role: "owner",
    })
  );
  await assertSucceeds(
    setDoc(doc(friend.firestore(), "factions", "city1", "pins", "harbor"), {
      title: "Harbor",
      nx: 0.42,
      ny: 0.18,
      x: 120,
      z: -40,
    })
  );
  await assertFails(
    setDoc(doc(other.firestore(), "factions", "city1", "pins", "stolen"), {
      title: "Stolen",
      nx: 0.1,
      ny: 0.1,
    })
  );
  await assertSucceeds(
    updateDoc(doc(friend.firestore(), "factions", "city1"), { lore: "Dark water and cedar." })
  );
  await assertFails(updateDoc(doc(other.firestore(), "factions", "city1"), { lore: "Stolen." }));
  await assertSucceeds(
    setDoc(doc(friend.firestore(), "posts", "note"), {
      ...postBody,
      title: "Mine",
      status: "published",
    })
  );
  await assertSucceeds(
    updateDoc(doc(friend.firestore(), "posts", "note"), { body: "Revised note" })
  );
  await assertFails(updateDoc(doc(other.firestore(), "posts", "note"), { body: "Hijacked" }));
  await assertSucceeds(
    setDoc(doc(friend.firestore(), "drafts", "note"), {
      ...postBody,
      title: "Mine",
      status: "draft",
    })
  );
  await assertFails(getDoc(doc(other.firestore(), "drafts", "note")));
  console.log("ok city ownership");

  await seedUser(env, "charles", {
    email: "charlie@suarezhouse.net",
    status: "approved",
    isAdmin: true,
  });
  const sheriff = env.authenticatedContext("charles", { email: "charlie@suarezhouse.net" });
  await assertSucceeds(getDoc(doc(friend.firestore(), "conversations", "missing-thread")));
  await assertSucceeds(
    setDoc(doc(friend.firestore(), "conversations", "dm1"), {
      participantUids: ["friend", "charles"],
      lastMessagePreview: "hello",
    })
  );
  await assertSucceeds(
    addDoc(collection(friend.firestore(), "conversations", "dm1", "messages"), {
      senderUid: "friend",
      body: "The harbor is closed.",
    })
  );
  await assertSucceeds(getDoc(doc(sheriff.firestore(), "conversations", "dm1")));
  await assertFails(getDoc(doc(other.firestore(), "conversations", "dm1")));
  await assertFails(getDocs(collection(other.firestore(), "conversations", "dm1", "messages")));
  await assertSucceeds(getDocs(collection(sheriff.firestore(), "conversations", "dm1", "messages")));
  console.log("ok dm privacy");

  await env.clearFirestore();
  await seedUser(env, "friend", {
    email: "friend@realm.test",
    status: "pending",
    isAdmin: false,
  });
  const pendingStorage = env.authenticatedContext("friend", { email: "friend@realm.test" });
  await assertFails(
    uploadString(ref(pendingStorage.storage(), "posts/p1/a.jpg"), "hello", "raw", {
      contentType: "image/jpeg",
    })
  );
  await seedUser(env, "friend", {
    email: "friend@realm.test",
    status: "approved",
    isAdmin: false,
  });
  const approvedStorage = env.authenticatedContext("friend", { email: "friend@realm.test" });
  await assertSucceeds(
    uploadString(ref(approvedStorage.storage(), "posts/missing/a.jpg"), "hello", "raw", {
      contentType: "image/jpeg",
    })
  );
  await assertFails(
    uploadString(ref(approvedStorage.storage(), "posts/missing/notes.txt"), "hello", "raw", {
      contentType: "text/plain",
    })
  );
  console.log("ok storage approval");

  await env.cleanup();
  assert.ok(true);
  console.log("rules tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
