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
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  setDoc,
  where,
  Timestamp,
  updateDoc,
} from "firebase/firestore";
import { getBytes, listAll, ref, uploadString } from "firebase/storage";
import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore as getAdminFirestore } from "firebase-admin/firestore";
import { projectFirestoreValue, runGenesis } from "../lib/sim/genesis";
import { ensureSimCity } from "../lib/sim/ensureSimCity";
import {
  BASELINE_HASH,
  EVEN_START_TEMPLATE,
  INITIAL_POINT_BUDGET,
  logEntryDocId,
} from "../lib/sim/template";
import { canonicalJson } from "../lib/sim/canonical";

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
  await assertSucceeds(getDoc(doc(pending.firestore(), "posts", "p1")));
  await assertFails(
    updateDoc(doc(pending.firestore(), "users", "friend"), { status: "approved", isAdmin: true })
  );
  await assertSucceeds(
    updateDoc(doc(pending.firestore(), "users", "friend"), { status: "approved" })
  );
  await assertSucceeds(
    updateDoc(doc(pending.firestore(), "users", "friend"), { displayName: "Friend" })
  );
  const newbie = env.authenticatedContext("newbie", { email: "new@realm.test" });
  await assertSucceeds(
    setDoc(doc(newbie.firestore(), "users", "newbie"), {
      email: "new@realm.test",
      isAdmin: false,
      status: "approved",
    })
  );
  console.log("ok open membership");

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
  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), "posts", "p1"), postBody);
  });
  const friendReader = env.authenticatedContext("friend", { email: "friend@realm.test" });
  await assertSucceeds(
    updateDoc(doc(charles.firestore(), "users", "friend"), { status: "suspended" })
  );
  await assertFails(getDoc(doc(friendReader.firestore(), "posts", "p1")));
  await assertFails(
    updateDoc(doc(friendReader.firestore(), "users", "friend"), { status: "approved" })
  );
  await assertSucceeds(
    updateDoc(doc(charles.firestore(), "users", "friend"), { status: "removed" })
  );
  await assertFails(getDoc(doc(friendReader.firestore(), "posts", "p1")));
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
  await assertSucceeds(
    updateDoc(doc(friend.firestore(), "factions", "city1"), {
      motto: "Cedar and tide",
      population: 900,
      foundedOn: "2019-06-01",
      gallery: ["https://firebasestorage.googleapis.com/v0/b/cowboycityrealm/o/a.jpg"],
    })
  );
  await assertFails(updateDoc(doc(friend.firestore(), "factions", "city1"), { population: -3 }));
  await assertFails(
    updateDoc(doc(friend.firestore(), "factions", "city1"), { motto: "m".repeat(181) })
  );
  await assertFails(
    updateDoc(doc(friend.firestore(), "factions", "city1"), {
      gallery: Array.from({ length: 25 }, (_, index) => `https://example.com/${index}.jpg`),
    })
  );
  await assertFails(updateDoc(doc(other.firestore(), "factions", "city1"), { population: 1 }));
  await assertSucceeds(
    updateDoc(doc(friend.firestore(), "users", "friend"), { minecraftUsername: "Notch" })
  );
  await assertSucceeds(
    updateDoc(doc(friend.firestore(), "users", "friend"), { minecraftUsername: "" })
  );
  await assertFails(
    updateDoc(doc(friend.firestore(), "users", "friend"), { minecraftUsername: "no" })
  );
  await assertFails(
    updateDoc(doc(friend.firestore(), "users", "friend"), { minecraftUsername: "bad name" })
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
  await assertSucceeds(
    uploadString(ref(pendingStorage.storage(), "posts/p1/a.jpg"), "hello", "raw", {
      contentType: "image/jpeg",
    })
  );
  await seedUser(env, "friend", {
    email: "friend@realm.test",
    status: "suspended",
    isAdmin: false,
  });
  const suspendedStorage = env.authenticatedContext("friend", { email: "friend@realm.test" });
  await assertFails(
    uploadString(ref(suspendedStorage.storage(), "posts/p1/b.jpg"), "hello", "raw", {
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

  // Paths the client actually writes, with the content types uploadBytes sends.
  await assertSucceeds(uploadString(ref(approvedStorage.storage(), "users/friend/avatar.jpg"), "avatar", "raw", {
    contentType: "image/jpeg",
  }));
  await assertFails(uploadString(ref(approvedStorage.storage(), "users/charles/avatar.jpg"), "nope", "raw", {
    contentType: "image/jpeg",
  }));
  await assertFails(uploadString(ref(approvedStorage.storage(), "users/friend/avatar.jpg"), "txt", "raw", {
    contentType: "text/plain",
  }));
  await assertSucceeds(uploadString(ref(approvedStorage.storage(), "threads/dock/1.jpg"), "thread", "raw", {
    contentType: "image/jpeg",
  }));
  const rootStorage = env.authenticatedContext("charles", { email: "charlie@suarezhouse.net" });
  await assertSucceeds(uploadString(ref(rootStorage.storage(), "realm/overview.jpg"), "map", "raw", {
    contentType: "image/jpeg",
  }));
  await assertFails(uploadString(ref(approvedStorage.storage(), "realm/overview.jpg"), "map", "raw", {
    contentType: "image/jpeg",
  }));
  console.log("ok client upload paths");

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
  await seedUser(env, "charles", {
    email: "charlie@suarezhouse.net",
    status: "approved",
    isAdmin: true,
  });
  await seedUser(env, "visitor", {
    email: "visitor@realm.test",
    status: "approved",
    isAdmin: false,
  });
  const treatyFriend = env.authenticatedContext("friend", { email: "friend@realm.test" });
  const treatyOther = env.authenticatedContext("other", { email: "other@realm.test" });
  const treatySheriff = env.authenticatedContext("charles", { email: "charlie@suarezhouse.net" });
  const treatyVisitor = env.authenticatedContext("visitor", { email: "visitor@realm.test" });
  await assertSucceeds(setDoc(doc(treatyFriend.firestore(), "factions", "city1"), {
    name: "Cascadia",
    slug: "cascadia",
    ownerUids: ["friend"],
    colors: { primary: "#169C9C", secondary: "#FED83D" },
  }));
  await assertSucceeds(setDoc(doc(treatyFriend.firestore(), "faction_members", "friend_city1"), {
    uid: "friend",
    factionId: "city1",
    role: "owner",
  }));
  await assertSucceeds(updateDoc(doc(treatyFriend.firestore(), "users", "friend"), {
    ownsCity: true,
    proofCityId: "city1",
  }));
  await assertFails(updateDoc(doc(treatyOther.firestore(), "users", "other"), {
    ownsCity: true,
    proofCityId: "city1",
  }));
  await assertSucceeds(setDoc(doc(treatyOther.firestore(), "factions", "city2"), {
    name: "Evan",
    slug: "evan",
    ownerUids: ["other"],
    colors: { primary: "#169C9C", secondary: "#FED83D" },
  }));
  await assertSucceeds(setDoc(doc(treatyOther.firestore(), "faction_members", "other_city2"), {
    uid: "other",
    factionId: "city2",
    role: "owner",
  }));
  await assertSucceeds(updateDoc(doc(treatyOther.firestore(), "users", "other"), {
    ownsCity: true,
    proofCityId: "city2",
  }));
  const pendingTreaty = {
    name: "Harbor Accord",
    type: "trade",
    nature: "Docks",
    terms: "No tariff",
    purpose: "Keep trade moving",
    open: false,
    status: "pending",
    proposerCityId: "city1",
    authorUid: "friend",
    currentRevision: 1,
    inviteeCityIds: ["city2"],
    partyCityIds: ["city1"],
    readerUids: ["friend", "other"],
    partyOwnerUids: ["friend"],
    color: "#169C9C",
    lastActionCityId: "city1",
  };
  await assertSucceeds(setDoc(doc(treatyFriend.firestore(), "treaties", "harbor"), pendingTreaty));
  await assertFails(getDoc(doc(treatyVisitor.firestore(), "treaties", "harbor")));
  await assertSucceeds(getDoc(doc(treatyOther.firestore(), "treaties", "harbor")));
  await assertSucceeds(getDoc(doc(treatySheriff.firestore(), "treaties", "harbor")));
  await assertFails(updateDoc(doc(treatyOther.firestore(), "treaties", "harbor"), {
    partyCityIds: ["city1", "city2"],
    status: "active",
    lastActionCityId: "city1",
    updatedAt: Timestamp.now(),
  }));
  await assertSucceeds(setDoc(doc(treatyFriend.firestore(), "treaties", "harbor", "revisions", "1"), {
    number: 1,
    authorCityId: "city1",
    authorUid: "friend",
    name: "Harbor Accord",
    note: "",
  }));
  await assertSucceeds(updateDoc(doc(treatyOther.firestore(), "treaties", "harbor"), {
    partyCityIds: ["city1", "city2"],
    status: "active",
    lastActionCityId: "city2",
    updatedAt: Timestamp.now(),
  }));
  await assertSucceeds(getDoc(doc(treatyVisitor.firestore(), "treaties", "harbor")));
  await assertSucceeds(setDoc(doc(treatyOther.firestore(), "treaties", "harbor", "responses", "city2_1"), {
    cityId: "city2",
    revision: 1,
    decision: "accept",
    uid: "other",
  }));
  await assertFails(setDoc(doc(treatyVisitor.firestore(), "treaties", "harbor", "responses", "stolen"), {
    cityId: "city2",
    revision: 1,
    decision: "accept",
    uid: "visitor",
  }));
  await assertSucceeds(setDoc(doc(treatyOther.firestore(), "treaties", "harbor", "revisions", "2"), {
    number: 2,
    authorCityId: "city2",
    authorUid: "other",
    name: "Harbor Accord",
    note: "Add grain",
  }));
  await assertSucceeds(updateDoc(doc(treatyOther.firestore(), "treaties", "harbor"), {
    currentRevision: 2,
    partyCityIds: ["city2"],
    status: "pending",
    lastActionCityId: "city2",
    name: "Harbor Accord",
    type: "trade",
    nature: "Docks",
    terms: "No tariff on grain",
    purpose: "Keep trade moving",
    open: false,
    proposerCityId: "city1",
    color: "#169C9C",
    inviteeCityIds: ["city2"],
    readerUids: ["friend", "other"],
    partyOwnerUids: ["other"],
  }));
  await assertFails(getDoc(doc(treatyVisitor.firestore(), "treaties", "harbor")));
  await assertSucceeds(setDoc(doc(treatyFriend.firestore(), "treaties", "league"), {
    ...pendingTreaty,
    name: "Open League",
    open: true,
    inviteeCityIds: [],
    readerUids: ["friend"],
    purpose: "A league for every city",
  }));
  await assertSucceeds(getDoc(doc(treatyOther.firestore(), "treaties", "league")));
  await assertFails(getDoc(doc(treatyVisitor.firestore(), "treaties", "league")));
  await assertSucceeds(setDoc(doc(treatyVisitor.firestore(), "threads", "dock"), {
    title: "Dock hours",
    body: "When do the lamps go out?",
    imageUrls: [],
    authorUid: "visitor",
    authorName: "Visitor",
    cityId: null,
    treatyId: null,
    replyCount: 0,
  }));
  await assertSucceeds(addDoc(collection(treatyFriend.firestore(), "threads", "dock", "replies"), {
    body: "After the tide.",
    imageUrls: [],
    authorUid: "friend",
    quoteExcerpt: "Visitor: When do the lamps go out?",
  }));
  await assertSucceeds(updateDoc(doc(treatyFriend.firestore(), "threads", "dock"), {
    replyCount: 1,
    lastActivityAt: Timestamp.now(),
  }));
  await assertFails(setDoc(doc(env.unauthenticatedContext().firestore(), "threads", "nope"), {
    title: "No",
    body: "No",
    imageUrls: [],
    authorUid: "visitor",
    replyCount: 0,
  }));
  console.log("ok treaties and forum");

  const clientTreaty = {
    name: "Cedar Pact",
    type: "alliance",
    nature: "Share the harbor",
    terms: "No tolls",
    purpose: "Keep the cedar moving",
    open: false,
    status: "pending",
    proposerCityId: "city1",
    authorUid: "friend",
    currentRevision: 1,
    inviteeCityIds: ["city2"],
    partyCityIds: ["city1"],
    readerUids: ["friend", "other"],
    partyOwnerUids: ["friend"],
    color: "#169C9C",
    lastActionCityId: "city1",
  };
  await assertSucceeds(setDoc(doc(treatyFriend.firestore(), "treaties", "pact"), clientTreaty));
  await assertFails(setDoc(doc(treatyFriend.firestore(), "treaties", "pact", "revisions", "1"), {
    number: 1,
    authorCityId: "city1",
    name: "Cedar Pact",
    note: "",
  }));
  await assertSucceeds(setDoc(doc(treatyFriend.firestore(), "treaties", "pact", "revisions", "1"), {
    number: 1,
    authorCityId: "city1",
    authorUid: "friend",
    name: "Cedar Pact",
    type: "alliance",
    nature: "Share the harbor",
    terms: "No tolls",
    purpose: "Keep the cedar moving",
    open: false,
    inviteeCityIds: ["city2"],
    note: "",
  }));
  await assertSucceeds(setDoc(doc(treatyFriend.firestore(), "treaties", "pact", "responses", "city1_1"), {
    cityId: "city1",
    revision: 1,
    decision: "accept",
    uid: "friend",
    note: "",
  }));
  await assertFails(setDoc(doc(treatyOther.firestore(), "treaties", "stolen"), {
    ...clientTreaty,
    authorUid: "other",
    proposerCityId: "city1",
    readerUids: ["other"],
    partyOwnerUids: ["other"],
    partyCityIds: ["city1"],
    lastActionCityId: "city1",
  }));
  await assertSucceeds(setDoc(doc(treatyVisitor.firestore(), "factions", "city3"), {
    name: "Listed Only",
    slug: "listed-only",
    ownerUids: ["visitor"],
    colors: { primary: "#169C9C", secondary: "#FED83D" },
  }));
  await assertSucceeds(setDoc(doc(treatyVisitor.firestore(), "treaties", "listed"), {
    ...clientTreaty,
    name: "Listed Pact",
    proposerCityId: "city3",
    authorUid: "visitor",
    inviteeCityIds: ["city2"],
    partyCityIds: ["city3"],
    readerUids: ["visitor", "other"],
    partyOwnerUids: ["visitor"],
    lastActionCityId: "city3",
    purpose: "A pact from a listed owner",
  }));
  await assertSucceeds(setDoc(doc(treatySheriff.firestore(), "factions", "sheriff-city"), {
    name: "Sheriffburg",
    slug: "sheriffburg",
    ownerUids: ["charles"],
    colors: { primary: "#169C9C", secondary: "#FED83D" },
  }));
  await assertSucceeds(setDoc(doc(treatySheriff.firestore(), "faction_members", "charles_sheriff-city"), {
    uid: "charles",
    factionId: "sheriff-city",
    role: "owner",
  }));
  await assertSucceeds(setDoc(doc(treatySheriff.firestore(), "treaties", "admin-pact"), {
    ...clientTreaty,
    name: "Sheriff Pact",
    proposerCityId: "sheriff-city",
    authorUid: "charles",
    inviteeCityIds: ["city1"],
    partyCityIds: ["sheriff-city"],
    readerUids: ["charles", "friend"],
    partyOwnerUids: ["charles"],
    lastActionCityId: "sheriff-city",
    purpose: "An admin owner can propose",
  }));
  await assertSucceeds(setDoc(doc(treatySheriff.firestore(), "treaties", "admin-pact", "revisions", "1"), {
    number: 1,
    authorCityId: "sheriff-city",
    authorUid: "charles",
    name: "Sheriff Pact",
    note: "",
  }));
  await assertSucceeds(uploadString(ref(treatyFriend.storage(), "factions/city1/map.jpg"), "map", "raw", {
    contentType: "image/jpeg",
  }));
  await assertFails(uploadString(ref(treatyOther.storage(), "factions/city1/map.jpg"), "nope", "raw", {
    contentType: "image/jpeg",
  }));
  await assertSucceeds(uploadString(ref(treatyFriend.storage(), "factions/city1/clip.mp4"), "video", "raw", {
    contentType: "video/mp4",
  }));
  await assertSucceeds(uploadString(ref(treatyFriend.storage(), "posts/pact-post/clip.mp4"), "video", "raw", {
    contentType: "video/mp4",
  }));
  await assertFails(getBytes(ref(env.unauthenticatedContext().storage(), "factions/city1/map.jpg")));
  await assertSucceeds(getBytes(ref(treatyFriend.storage(), "factions/city1/map.jpg")));
  await assertFails(getBytes(ref(env.unauthenticatedContext().storage(), "posts/pact-post/clip.mp4")));
  await assertSucceeds(getBytes(ref(treatyOther.storage(), "posts/pact-post/clip.mp4")));
  await assertFails(listAll(ref(env.unauthenticatedContext().storage(), "factions/city1")));
  await assertFails(listAll(ref(treatyFriend.storage(), "factions/city1")));
  await assertSucceeds(listAll(ref(treatySheriff.storage(), "factions/city1")));
  await assertFails(listAll(ref(treatyFriend.storage(), "posts/pact-post")));
  await assertSucceeds(listAll(ref(treatySheriff.storage(), "posts/pact-post")));
  console.log("ok treaty create and city media");

  // Same payload the realm map sends. The parent realm_map/overview doc is absent on purpose.
  const clientPin = {
    title: "North gate",
    note: "A saved pin",
    nx: 0.42,
    ny: 0.18,
    cityId: "city1",
    wikiEntryIds: [] as string[],
    wikiEntryId: null,
    postId: null,
    x: null,
    z: null,
  };
  await assertFails(
    addDoc(collection(treatyFriend.firestore(), "realm_map", "overview", "pins"), clientPin)
  );
  await seedUser(env, "root-only", {
    email: "cjtheswimmer1101@gmail.com",
    status: "approved",
    isAdmin: false,
  });
  const rootOnly = env.authenticatedContext("root-only", { email: "cjtheswimmer1101@gmail.com" });
  const created = await assertSucceeds(
    addDoc(collection(rootOnly.firestore(), "realm_map", "overview", "pins"), clientPin)
  );
  await assertFails(
    addDoc(collection(rootOnly.firestore(), "realm_map", "overview", "pins"), { ...clientPin, title: "" })
  );
  const pinList = await assertSucceeds(
    getDocs(collection(treatyFriend.firestore(), "realm_map", "overview", "pins"))
  );
  assert.equal(pinList.docs.length, 1);
  assert.equal(pinList.docs[0].id, created.id);
  assert.equal(pinList.docs[0].data().title, "North gate");
  assert.equal(pinList.docs[0].data().nx, 0.42);
  assert.equal(pinList.docs[0].data().ny, 0.18);
  await assertSucceeds(
    getDoc(doc(treatySheriff.firestore(), "realm_map", "overview", "pins", created.id))
  );
  await assertFails(
    deleteDoc(doc(treatyFriend.firestore(), "realm_map", "overview", "pins", created.id))
  );
  console.log("ok realm map pins");

  const border = {
    cityId: "city1",
    updatedAt: Timestamp.now(),
    points: [
      { nx: 0.2, ny: 0.2 },
      { nx: 0.4, ny: 0.25 },
      { nx: 0.35, ny: 0.45 },
    ],
  };
  await assertSucceeds(setDoc(doc(treatyFriend.firestore(), "realm_map", "overview", "borders", "city1"), border));
  await assertSucceeds(getDoc(doc(treatyVisitor.firestore(), "realm_map", "overview", "borders", "city1")));
  const lurker = env.authenticatedContext("lurker", { email: "lurker@realm.test" });
  await assertSucceeds(getDocs(collection(lurker.firestore(), "realm_map", "overview", "borders")));
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), "realm_map", "overview", "borders", "city1")));
  await assertFails(setDoc(doc(treatyOther.firestore(), "realm_map", "overview", "borders", "city1"), {
    ...border,
    points: [
      { nx: 0.1, ny: 0.1 },
      { nx: 0.2, ny: 0.1 },
      { nx: 0.2, ny: 0.2 },
    ],
  }));
  await assertFails(setDoc(doc(treatyFriend.firestore(), "realm_map", "overview", "borders", "city1"), {
    ...border,
    points: [
      { nx: 0.2, ny: 0.2 },
      { nx: 1.4, ny: 0.25 },
      { nx: 0.35, ny: 0.45 },
    ],
  }));
  await assertFails(setDoc(doc(treatyFriend.firestore(), "realm_map", "overview", "borders", "city1"), {
    cityId: "city1",
    updatedAt: Timestamp.now(),
    points: [
      { nx: 0.2, ny: 0.2 },
      { nx: 0.4, ny: 0.25 },
    ],
  }));
  await assertSucceeds(setDoc(doc(treatySheriff.firestore(), "realm_map", "overview", "borders", "city2"), {
    ...border,
    cityId: "city2",
  }));
  await assertSucceeds(setDoc(doc(treatyVisitor.firestore(), "realm_map", "overview", "borders", "city3"), {
    ...border,
    cityId: "city3",
  }));
  await assertFails(setDoc(doc(treatyVisitor.firestore(), "realm_map", "overview", "borders", "city1"), border));
  await assertSucceeds(deleteDoc(doc(treatyFriend.firestore(), "realm_map", "overview", "borders", "city1")));
  await assertFails(deleteDoc(doc(treatyVisitor.firestore(), "realm_map", "overview", "borders", "city2")));
  await assertSucceeds(setDoc(doc(treatySheriff.firestore(), "realm_map", "overview", "pins", "keep"), {
    title: "Cascadia",
    nx: 0.22,
    ny: 0.41,
    category: "capital",
    cityId: "city1",
    note: "",
  }));
  await assertFails(setDoc(doc(treatySheriff.firestore(), "realm_map", "overview", "pins", "bad"), {
    title: "Bad",
    nx: 0.22,
    ny: 0.41,
    category: "castle",
  }));
  await assertFails(setDoc(doc(treatyFriend.firestore(), "realm_map", "overview", "pins", "member"), {
    title: "Member pin",
    nx: 0.22,
    ny: 0.41,
    category: "capital",
  }));
  await assertSucceeds(setDoc(doc(treatyFriend.firestore(), "factions", "city1", "pins", "outpost"), {
    title: "Watchtower",
    nx: 0.5,
    ny: 0.5,
    category: "outpost",
  }));
  await assertFails(setDoc(doc(treatyFriend.firestore(), "factions", "city1", "pins", "bad-kind"), {
    title: "Watchtower",
    nx: 0.5,
    ny: 0.5,
    category: "banner",
  }));
  console.log("ok borders and pin categories");

  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), "treaties", "pact-live"), {
      ...clientTreaty,
      name: "Live Pact",
      status: "active",
      partyCityIds: ["city1", "city2"],
      partyOwnerUids: ["friend", "other"],
      readerUids: ["friend", "other"],
      purpose: "A pact both cities signed",
    });
    await setDoc(doc(context.firestore(), "posts", "legacy-search"), {
      type: "lore",
      factionId: "city1",
      title: "Legacy harbor",
      body: "Before keywords",
      authorUid: "friend",
      cityIds: ["city1"],
      status: "published",
    });
  });
  await assertSucceeds(updateDoc(doc(treatyOther.firestore(), "treaties", "pact-live"), {
    partyCityIds: ["city1"],
    status: "broken",
    updatedAt: Timestamp.now(),
    lastActionCityId: "city2",
    partyOwnerUids: ["friend"],
    readerUids: ["friend", "other"],
    brokenByCityId: "city2",
    breakNote: "The harbor dues changed.",
  }));
  await assertSucceeds(getDoc(doc(treatyVisitor.firestore(), "treaties", "pact-live")));
  await assertSucceeds(setDoc(doc(treatyOther.firestore(), "treaties", "pact-live", "responses", "city2_1"), {
    cityId: "city2",
    revision: 1,
    decision: "break",
    uid: "other",
    note: "The harbor dues changed.",
  }));
  await assertFails(updateDoc(doc(treatyVisitor.firestore(), "treaties", "pact-live"), {
    partyCityIds: [],
    status: "broken",
    updatedAt: Timestamp.now(),
    lastActionCityId: "city2",
    brokenByCityId: "city2",
    breakNote: "Not my treaty.",
  }));
  await assertSucceeds(getDocs(query(
    collection(treatyVisitor.firestore(), "treaties"),
    where("status", "==", "broken"),
    where("searchTokens", "array-contains", "pact")
  )));
  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), "treaties", "renew-me"), {
      ...clientTreaty,
      name: "Renew Me",
      status: "active",
      partyCityIds: ["city1", "city2"],
      currentRevision: 1,
      inviteeCityIds: ["city2"],
      readerUids: ["friend", "other"],
      partyOwnerUids: ["friend", "other"],
      purpose: "Needs a new season",
    });
  });
  await assertSucceeds(setDoc(doc(treatyFriend.firestore(), "treaties", "renew-me", "revisions", "2"), {
    number: 2,
    authorCityId: "city1",
    authorUid: "friend",
    name: "Renew Me",
    note: "Renew for another year.",
    kind: "renewal",
    expiresOn: "2027-01-01",
  }));
  await assertSucceeds(updateDoc(doc(treatyFriend.firestore(), "treaties", "renew-me"), {
    currentRevision: 2,
    partyCityIds: ["city1"],
    status: "pending",
    lastActionCityId: "city1",
    name: "Renew Me",
    type: "alliance",
    nature: "Share the harbor",
    terms: "No tolls",
    purpose: "Needs a new season",
    open: false,
    proposerCityId: "city1",
    color: "#169C9C",
    inviteeCityIds: ["city2"],
    readerUids: ["friend", "other"],
    partyOwnerUids: ["friend"],
    expiresOn: "2027-01-01",
    renewOn: "2026-12-01",
    searchTokens: ["renew", "ren", "season"],
  }));
  await assertFails(getDoc(doc(treatyVisitor.firestore(), "treaties", "renew-me")));
  await assertSucceeds(updateDoc(doc(treatySheriff.firestore(), "posts", "legacy-search"), {
    searchTokens: ["legacy", "leg", "harbor"],
  }));
  await assertFails(updateDoc(doc(treatyOther.firestore(), "posts", "legacy-search"), {
    searchTokens: ["nope"],
  }));
  console.log("ok treaty break, renewal, and search tokens");

  await assertSucceeds(setDoc(doc(treatyFriend.firestore(), "posts", "feed1"), {
    type: "lore",
    factionId: "city1",
    authorUid: "friend",
    title: "Lanterns",
    body: "The dock is lit.",
    cityIds: ["city1"],
    referencedPostIds: [],
    spoiler: false,
    pinned: false,
    status: "published",
  }));
  const comment = {
    authorUid: "visitor",
    authorName: "Visitor",
    body: "Those lanterns are bright.",
    createdAt: Timestamp.now(),
  };
  await assertSucceeds(setDoc(doc(treatyVisitor.firestore(), "posts", "feed1", "comments", "c1"), comment));
  await assertSucceeds(getDocs(collection(treatyOther.firestore(), "posts", "feed1", "comments")));
  await assertFails(getDocs(collection(env.unauthenticatedContext().firestore(), "posts", "feed1", "comments")));
  await assertFails(setDoc(doc(treatyVisitor.firestore(), "posts", "feed1", "comments", "empty"), {
    ...comment,
    body: "",
  }));
  await assertFails(setDoc(doc(treatyVisitor.firestore(), "posts", "feed1", "comments", "stolen"), {
    ...comment,
    authorUid: "other",
  }));
  await assertFails(setDoc(doc(treatyVisitor.firestore(), "posts", "missing", "comments", "c1"), comment));
  await assertFails(updateDoc(doc(treatyVisitor.firestore(), "posts", "feed1", "comments", "c1"), {
    body: "Changed.",
  }));
  await assertFails(deleteDoc(doc(treatyOther.firestore(), "posts", "feed1", "comments", "c1")));
  await assertSucceeds(deleteDoc(doc(treatySheriff.firestore(), "posts", "feed1", "comments", "c1")));
  await assertSucceeds(setDoc(doc(treatyOther.firestore(), "posts", "feed1", "comments", "c2"), {
    authorUid: "other",
    authorName: "Other",
    body: "I can see them from the ridge.",
    createdAt: Timestamp.now(),
  }));
  await assertSucceeds(deleteDoc(doc(treatyOther.firestore(), "posts", "feed1", "comments", "c2")));

  await assertSucceeds(setDoc(doc(treatyVisitor.firestore(), "posts", "feed1", "emoji_reactions", "visitor_heart"), {
    uid: "visitor",
    emoji: "heart",
  }));
  await assertSucceeds(setDoc(doc(treatyVisitor.firestore(), "posts", "feed1", "emoji_reactions", "visitor_diamond"), {
    uid: "visitor",
    emoji: "diamond",
  }));
  await assertFails(setDoc(doc(treatyVisitor.firestore(), "posts", "feed1", "emoji_reactions", "visitor_heart"), {
    uid: "visitor",
    emoji: "heart",
  }));
  await assertFails(setDoc(doc(treatyVisitor.firestore(), "posts", "feed1", "emoji_reactions", "visitor_sword"), {
    uid: "visitor",
    emoji: "sword",
  }));
  await assertFails(setDoc(doc(treatyVisitor.firestore(), "posts", "feed1", "emoji_reactions", "other_heart"), {
    uid: "other",
    emoji: "heart",
  }));
  await assertFails(setDoc(doc(treatyVisitor.firestore(), "posts", "feed1", "emoji_reactions", "visitor_heart"), {
    uid: "visitor",
    emoji: "diamond",
  }));
  await assertFails(updateDoc(doc(treatyVisitor.firestore(), "posts", "feed1", "emoji_reactions", "visitor_diamond"), {
    emoji: "crown",
  }));
  await assertSucceeds(getDoc(doc(treatyOther.firestore(), "posts", "feed1", "emoji_reactions", "visitor_diamond")));
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), "posts", "feed1", "emoji_reactions", "visitor_diamond")));
  await assertFails(deleteDoc(doc(treatyOther.firestore(), "posts", "feed1", "emoji_reactions", "visitor_diamond")));
  await assertSucceeds(deleteDoc(doc(treatyVisitor.firestore(), "posts", "feed1", "emoji_reactions", "visitor_heart")));
  await assertSucceeds(deleteDoc(doc(treatySheriff.firestore(), "posts", "feed1", "emoji_reactions", "visitor_diamond")));
  await assertFails(setDoc(doc(treatyVisitor.firestore(), "posts", "missing", "emoji_reactions", "visitor_heart"), {
    uid: "visitor",
    emoji: "heart",
  }));

  await assertSucceeds(setDoc(doc(treatyFriend.firestore(), "threads", "dock", "replies", "r1"), {
    body: "After the tide.",
    imageUrls: [],
    authorUid: "friend",
  }));
  await assertSucceeds(setDoc(
    doc(treatyOther.firestore(), "threads", "dock", "replies", "r1", "emoji_reactions", "other_crown"),
    { uid: "other", emoji: "crown" }
  ));
  await assertFails(setDoc(
    doc(treatyVisitor.firestore(), "threads", "dock", "replies", "r1", "emoji_reactions", "other_crown"),
    { uid: "other", emoji: "crown" }
  ));
  await assertFails(setDoc(
    doc(treatyVisitor.firestore(), "threads", "dock", "replies", "missing", "emoji_reactions", "visitor_blaze"),
    { uid: "visitor", emoji: "blaze" }
  ));
  await assertSucceeds(deleteDoc(
    doc(treatyOther.firestore(), "threads", "dock", "replies", "r1", "emoji_reactions", "other_crown")
  ));
  await assertFails(getDocs(collection(
    env.unauthenticatedContext().firestore(),
    "threads",
    "dock",
    "replies",
    "r1",
    "emoji_reactions"
  )));

  const notice = {
    recipientUid: "other",
    read: false,
    summary: "You're invited to ratify Harbor Accord.",
    href: "/treaties/harbor",
    createdAt: Timestamp.now(),
  };
  await assertSucceeds(setDoc(doc(treatyFriend.firestore(), "notifications", "n1"), {
    ...notice,
    type: "treaty",
    kind: "invite",
  }));
  await assertSucceeds(setDoc(doc(treatyFriend.firestore(), "notifications", "n2"), {
    ...notice,
    type: "reaction",
    summary: "Visitor reacted ❤️ to Lanterns",
    href: "/posts/feed1",
  }));
  await assertSucceeds(setDoc(doc(treatyFriend.firestore(), "notifications", "n3"), {
    ...notice,
    type: "comment",
    summary: "Visitor commented on Lanterns",
    href: "/posts/feed1#comments",
  }));
  await assertSucceeds(setDoc(doc(treatyFriend.firestore(), "notifications", "n4"), {
    ...notice,
    type: "treaty",
    kind: "counter",
    summary: "Counter-proposal on Harbor Accord.",
  }));
  await assertSucceeds(setDoc(doc(treatyFriend.firestore(), "notifications", "n5"), {
    ...notice,
    type: "treaty",
    kind: "ratified",
    summary: "Harbor Accord is ratified and now active.",
  }));
  await assertFails(setDoc(doc(treatyFriend.firestore(), "notifications", "bad-type"), {
    ...notice,
    type: "alert",
  }));
  await assertFails(setDoc(doc(treatyFriend.firestore(), "notifications", "bad-kind"), {
    ...notice,
    type: "treaty",
    kind: "x".repeat(41),
  }));
  await assertFails(getDoc(doc(treatyVisitor.firestore(), "notifications", "n1")));
  await assertSucceeds(getDoc(doc(treatyOther.firestore(), "notifications", "n1")));
  await assertFails(updateDoc(doc(treatyVisitor.firestore(), "notifications", "n1"), { read: true }));
  await assertSucceeds(updateDoc(doc(treatyOther.firestore(), "notifications", "n1"), { read: true }));
  await assertFails(updateDoc(doc(treatyOther.firestore(), "notifications", "n2"), { summary: "rewritten" }));
  console.log("ok social interactions");

  // ======================================================================
  // Sim layer (Phase 1) — P1-G1..G7 (Phase 1 brief §7).
  //
  // Genesis + lazy creation run for real, via the §2/§3 procedures on the
  // Admin SDK pointed at the emulator (emulators:exec sets
  // FIRESTORE_EMULATOR_HOST). Rules assertions use claim-bearing
  // rules-unit-testing contexts. P1-G8 (Osei's adapted V01–V08 over an
  // export) is a separate sign-off, not part of this suite.
  // ======================================================================
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error(
      "sim section requires FIRESTORE_EMULATOR_HOST — run via `npm run test:rules`"
    );
  }
  const adminApp =
    getApps().length > 0
      ? getApps()[0]
      : initializeApp({ projectId: PROJECT_ID }, "sim-phase1");
  const adminDb = getAdminFirestore(adminApp);

  await env.clearFirestore();
  await seedUser(env, "ownerA", { email: "a@realm.test", status: "approved", isAdmin: false });
  await seedUser(env, "ownerB", { email: "b@realm.test", status: "approved", isAdmin: false });
  await seedUser(env, "memberC", { email: "c@realm.test", status: "approved", isAdmin: false });
  await seedUser(env, "adminD", { email: "d@realm.test", status: "approved", isAdmin: true });
  await seedUser(env, "suspendedE", { email: "e@realm.test", status: "suspended", isAdmin: false });
  // Guest stand-in: the accessLevel field is Phase 8's, but the Phase 1
  // helpers already read it (default 'member'); a fixture user carrying
  // 'guest' exercises that branch without migrating any real data.
  await seedUser(env, "guestG", {
    email: "g@realm.test",
    status: "approved",
    isAdmin: false,
    accessLevel: "guest",
  });
  await env.withSecurityRulesDisabled(async (context) => {
    const fs = context.firestore();
    await setDoc(doc(fs, "factions", "cityA"), {
      name: "Fixture City A",
      slug: "fixture-a",
      ownerUids: ["ownerA"],
    });
    await setDoc(doc(fs, "faction_members", "ownerA_cityA"), {
      uid: "ownerA",
      factionId: "cityA",
      role: "owner",
    });
    await setDoc(doc(fs, "factions", "cityB"), {
      name: "Fixture City B",
      slug: "fixture-b",
      ownerUids: [],
    });
    await setDoc(doc(fs, "faction_members", "ownerB_cityB"), {
      uid: "ownerB",
      factionId: "cityB",
      role: "owner",
    });
    await setDoc(doc(fs, "factions", "cityU"), {
      name: "Fixture City U",
      slug: "fixture-u",
      ownerUids: [],
    });
    // Corpus tripwire: a corpus-style figure living ONLY in a cited lore
    // record — the one place it is allowed (P1-G2 corpus-trace scan).
    await setDoc(doc(fs, "wiki_entries", "lore-cityA"), {
      cityId: "cityA",
      title: "Fixture lore",
      gdpRubars: 987654321,
      source: { citation: "fixture corpus doc, planted tripwire" },
    });
  });

  const genesisResult = await runGenesis(adminDb, {});
  assert.equal(genesisResult.status, "created");
  assert.equal((await ensureSimCity(adminDb, "cityA")).status, "created");
  assert.equal((await ensureSimCity(adminDb, "cityB")).status, "created");
  assert.equal((await ensureSimCity(adminDb, "cityU")).status, "unclaimed");

  // Publications fixture for the P1-G1 create-only checks and the P1-G5
  // read-surface checks. Ordering constraint: fixtures in sim_* collections
  // must be seeded after genesis, because genesis verifies a pristine world
  // (its post-commit sweep requires every sim_* collection to start empty).
  await env.withSecurityRulesDisabled(async (context) => {
    const fs = context.firestore();
    await setDoc(doc(fs, "sim_publications", "pubMembers"), {
      cityId: "cityA",
      businessId: null,
      publisherUid: "ownerA",
      version: 1,
      supersedesPublicationId: null,
      status: "published",
      publishedAtSeq: 1,
      claims: [],
      visibility: "members",
    });
  });

  const simCollections = [
    "sim_world",
    "sim_counters",
    "sim_log_entries",
    "sim_cities",
    "sim_stat_allocations",
    "sim_actions",
    "sim_resolutions",
    "sim_publications",
    "sim_intel_records",
    "sim_fabric_status",
    "sim_character_extensions",
  ];
  async function simDocsSerialized(): Promise<string[]> {
    const out: string[] = [];
    for (const name of simCollections) {
      const snap = await adminDb.collection(name).get();
      for (const d of snap.docs) {
        out.push(canonicalJson(projectFirestoreValue(d.data())));
      }
    }
    return out;
  }

  // ---- P1-G2: even start (TC-D04 rewritten) + P1-G3 roster + P1-G4 nulls
  {
    const world = (await adminDb.collection("sim_world").doc("current").get()).data() ?? {};
    const cityA = (await adminDb.collection("sim_cities").doc("cityA").get()).data() ?? {};
    const cityB = (await adminDb.collection("sim_cities").doc("cityB").get()).data() ?? {};
    const allocA = (await adminDb.collection("sim_stat_allocations").doc("cityA").get()).data() ?? {};
    const allocB = (await adminDb.collection("sim_stat_allocations").doc("cityB").get()).data() ?? {};
    const baseA = (cityA.baseline ?? {}) as Record<string, unknown>;
    const baseB = (cityB.baseline ?? {}) as Record<string, unknown>;
    assert.equal(world.evenStartTemplateHash, BASELINE_HASH);
    assert.equal(baseA.baselineHash, BASELINE_HASH);
    assert.equal(baseB.baselineHash, BASELINE_HASH);
    assert.equal(allocA.baselineHash, BASELINE_HASH);
    assert.equal(allocB.baselineHash, BASELINE_HASH);
    const templateJson = canonicalJson(EVEN_START_TEMPLATE.baselineStats);
    assert.equal(canonicalJson(cityA.stats), templateJson);
    assert.equal(canonicalJson(cityB.stats), templateJson);
    assert.equal(canonicalJson(baseA.baselineStats), templateJson);
    assert.equal(allocA.status, "not_started");
    assert.equal(allocB.status, "not_started");
    // The brief's §7 asserts pointBudget == null — that was the pre-lock
    // posture ("null until Vera locks the pool"). Vera's lock landed at
    // 400 (Q-B5 closed) before this build; see phase1-decisions.md.
    assert.equal(allocA.pointBudget, INITIAL_POINT_BUDGET);
    assert.equal(allocB.pointBudget, INITIAL_POINT_BUDGET);
    const serialized = await simDocsSerialized();
    assert.ok(
      serialized.every((s) => !s.includes("987654321")),
      "corpus tripwire leaked into a sim document"
    );

    // P1-G3: unowned = strongly inactive; second lazy creation is a no-op.
    assert.equal((await adminDb.collection("sim_cities").doc("cityU").get()).exists, false);
    assert.equal(
      (await adminDb.collection("sim_stat_allocations").doc("cityU").get()).exists,
      false
    );
    assert.ok(
      serialized.every((s) => !s.includes('"cityU"')),
      "a sim document references the unowned fixture city"
    );
    const cityABefore = canonicalJson(
      projectFirestoreValue(
        (await adminDb.collection("sim_cities").doc("cityA").get()).data() ?? {}
      )
    );
    assert.equal((await ensureSimCity(adminDb, "cityA")).status, "already-exists");
    const cityAAfter = canonicalJson(
      projectFirestoreValue(
        (await adminDb.collection("sim_cities").doc("cityA").get()).data() ?? {}
      )
    );
    assert.equal(cityAAfter, cityABefore);
    assert.equal(cityA.stateVersion, 1);
    // Lazy creation writes no Log entry (decision L-1): genesis is alone.
    assert.equal((await adminDb.collection("sim_log_entries").get()).size, 1);

    // P1-G4: null honesty — present keys, null values, never 0/50.
    const stats = (cityA.stats ?? {}) as Record<string, unknown>;
    for (const key of ["military", "defense", "population", "gdpRubars"]) {
      assert.ok(Object.prototype.hasOwnProperty.call(stats, key), `stats.${key} missing`);
      assert.equal(stats[key], null, `stats.${key} must be null`);
    }
    assert.equal(stats.households, 0);
    assert.equal(stats.housingUnits, 0);
    assert.equal(stats.treasuryRubars, 0);
    assert.equal(cityA.lastChangedSeq, null);
    assert.equal(cityA.seedCityId, null);
    const genesisEntry =
      (await adminDb.collection("sim_log_entries").doc(logEntryDocId(1)).get()).data() ?? {};
    assert.equal(genesisEntry.baseline, null);
    assert.deepEqual(genesisEntry.changes, []);
    assert.equal(genesisEntry.visibility, "public");
  }
  console.log("ok sim genesis, even start, roster, null honesty (P1-G2/G3/G4)");

  const ownerA = env.authenticatedContext("ownerA", { email: "a@realm.test" });
  const ownerB = env.authenticatedContext("ownerB", { email: "b@realm.test" });
  const memberC = env.authenticatedContext("memberC", { email: "c@realm.test" });
  const adminD = env.authenticatedContext("adminD", { email: "d@realm.test" });
  const suspendedE = env.authenticatedContext("suspendedE", { email: "e@realm.test" });
  const guestG = env.authenticatedContext("guestG", { email: "g@realm.test" });
  const anon = env.unauthenticatedContext();
  const fabricCommitter = env.authenticatedContext("fabricSvc", {
    email: "fabric@realm.test",
    fabric: true,
    fabricRole: "committer",
  });
  const fabricWorker = env.authenticatedContext("fabricWkr", {
    email: "worker@realm.test",
    fabric: true,
    fabricRole: "worker",
  });

  // Phase 2: the entry fixture is the v2 form (brief §9.1) — v1 survives
  // only as the genesis carve-out, so a seq-2 fixture must be v2, with the
  // four Phase 2 fields present (null when N/A).
  const validEntry = {
    seq: 2,
    resolutionSeq: 2,
    resolutionId: "test-resolution",
    entryIndexWithinResolution: 0,
    kind: "action-summary",
    resolvedAt: "2026-10-17T00:00:00.000Z",
    rulesVersion: "sim-rules-0.5.0-phase5",
    actor: {
      type: "member",
      memberId: "ownerA",
      npcId: null,
      onBehalfOfMemberId: null,
      mandateId: null,
      mandateVersion: null,
      envelopeId: null,
    },
    actionId: null,
    actionText: null,
    classification: null,
    cityId: "cityA",
    cityIds: ["cityA"],
    ruleIds: [],
    changes: [],
    spilloverFromSeq: null,
    causedBySeq: null,
    correctsSeq: null,
    recordsCreated: [],
    recordsUpdated: [],
    legal: null,
    chronicleDraftId: null,
    major: false,
    summaryText: "test entry",
    visibility: "public",
    baseline: null,
    pendingId: null,
    wakeActionId: null,
    executedDuringSeq: null,
    generation: null,
    prevHash: "a".repeat(64),
    entryHash: "b".repeat(64),
    hashVersion: "cowboy-canonical-json-v2",
  };

  // ---- P1-G1: TC-C01 structural refusal — the single write path.
  {
    const deniedActors = [ownerA, ownerB, memberC, adminD, suspendedE, anon, fabricWorker];
    for (const actor of deniedActors) {
      const fs = actor.firestore();
      await assertFails(updateDoc(doc(fs, "sim_world", "current"), { lastCommittedSeq: 99 }));
      await assertFails(updateDoc(doc(fs, "sim_cities", "cityA"), { traits: ["x"] }));
      await assertFails(
        setDoc(doc(fs, "sim_cities", "cityA", "structures", "x"), { name: "X" })
      );
      await assertFails(setDoc(doc(fs, "sim_log_entries", logEntryDocId(2)), validEntry));
      await assertFails(setDoc(doc(fs, "sim_resolutions", "x"), { resolutionId: "x" }));
      await assertFails(
        setDoc(doc(fs, "sim_intel_records", "x"), {
          collectorUid: "ownerA",
          collectorCityId: "cityA",
          method: { kindLabel: "test", methodRef: "log:1" },
          collectionResolutionId: "r1",
        })
      );
    }
    // The committer succeeds on shape-valid creates.
    const committerFs = fabricCommitter.firestore();
    await assertSucceeds(
      updateDoc(doc(committerFs, "sim_world", "current"), { lastCommittedSeq: 1 })
    );
    await assertSucceeds(
      setDoc(doc(committerFs, "sim_cities", "cityNew"), {
        factionId: "cityNew",
        baseline: { baselineHash: "d".repeat(64) },
      })
    );
    await assertSucceeds(
      updateDoc(doc(committerFs, "sim_cities", "cityA"), { traits: [] })
    );
    await assertSucceeds(setDoc(doc(committerFs, "sim_log_entries", logEntryDocId(2)), validEntry));
    await assertSucceeds(
      setDoc(doc(committerFs, "sim_resolutions", "test-resolution"), {
        resolutionId: "test-resolution",
      })
    );
    await assertSucceeds(
      setDoc(doc(committerFs, "sim_intel_records", "intel1"), {
        collectorUid: "ownerA",
        collectorCityId: "cityA",
        targetCityId: "cityB",
        targetBusinessId: null,
        method: { kindLabel: "survey", methodRef: "sim_actions:test" },
        collectionResolutionId: "test-resolution",
        collectedAtSeq: 2,
        coverage: null,
        reliability: null,
        findings: [],
      })
    );
    // Shape discipline binds the committer too.
    await assertFails(
      setDoc(doc(committerFs, "sim_log_entries", logEntryDocId(3)), {
        ...validEntry,
        seq: 3,
        entryHash: "b".repeat(63),
      })
    );
    await assertFails(
      setDoc(doc(committerFs, "sim_log_entries", logEntryDocId(3)), {
        ...validEntry,
        seq: 3,
        kind: "not-a-kind",
      })
    );
    // Create-only records: update denied for EVERY identity, committer and
    // admin included. Phase 2 amendment (brief §9): DELETE is now the
    // committer's undo path on Log/resolutions/state — but for everyone
    // else, and for publications/intel (never-delete stands), it stays
    // denied. Committer-delete success is asserted in the Phase 2 section
    // below, on fresh fixture docs, so these Phase 1 docs survive for the
    // read-surface checks.
    await assertFails(
      updateDoc(doc(committerFs, "sim_log_entries", logEntryDocId(2)), { major: true })
    );
    await assertFails(deleteDoc(doc(adminD.firestore(), "sim_log_entries", logEntryDocId(2))));
    await assertFails(deleteDoc(doc(fabricWorker.firestore(), "sim_log_entries", logEntryDocId(2))));
    await assertFails(deleteDoc(doc(ownerA.firestore(), "sim_log_entries", logEntryDocId(2))));
    await assertFails(
      updateDoc(doc(committerFs, "sim_resolutions", "test-resolution"), { x: 1 })
    );
    await assertFails(deleteDoc(doc(fabricWorker.firestore(), "sim_resolutions", "test-resolution")));
    await assertFails(
      updateDoc(doc(ownerA.firestore(), "sim_publications", "pubMembers"), { status: "retracted" })
    );
    await assertFails(deleteDoc(doc(committerFs, "sim_publications", "pubMembers")));
    await assertFails(
      updateDoc(doc(committerFs, "sim_intel_records", "intel1"), { coverage: {} })
    );
    // P2-K16 (CJ's N-1 ruling): the committer may delete an intel
    // record — solely as the undo engine's restore path. (Was
    // assertFails under the brief §9 never-delete aside; N-1 +
    // brief §8.6 + the P2-G8 matrix govern. Publications above stay
    // never-delete.) Exercised on a throwaway record: intel1 above is
    // shared fixture state for later sections and must survive.
    await assertSucceeds(
      setDoc(doc(committerFs, "sim_intel_records", "intelUndoRestore"), {
        collectorUid: "ownerA",
        collectorCityId: "cityA",
        targetCityId: "cityB",
        targetBusinessId: null,
        method: { kindLabel: "survey", methodRef: "sim_actions:test" },
        collectionResolutionId: "test-resolution",
        collectedAtSeq: 2,
        coverage: null,
        reliability: null,
        findings: [],
      })
    );
    await assertSucceeds(deleteDoc(doc(committerFs, "sim_intel_records", "intelUndoRestore")));
    await assertFails(deleteDoc(doc(fabricWorker.firestore(), "sim_cities", "cityA")));
  }
  console.log("ok sim structural refusal (P1-G1)");

  // ---- P1-G5: read surface.
  {
    await assertSucceeds(getDoc(doc(memberC.firestore(), "sim_cities", "cityA")));
    await assertSucceeds(getDoc(doc(guestG.firestore(), "sim_cities", "cityA")));
    await assertFails(getDoc(doc(anon.firestore(), "sim_cities", "cityA")));
    await assertFails(getDoc(doc(suspendedE.firestore(), "sim_cities", "cityA")));
    await assertSucceeds(
      getDoc(doc(memberC.firestore(), "sim_log_entries", logEntryDocId(1)))
    );
    // Phase 2 (§9.3): manifest reads narrow to admin + fabric — manifests
    // carry full before/after snapshots of other members' cities.
    await assertFails(getDoc(doc(memberC.firestore(), "sim_resolutions", "test-resolution")));
    await assertSucceeds(getDoc(doc(adminD.firestore(), "sim_resolutions", "test-resolution")));
    await assertSucceeds(getDoc(doc(fabricWorker.firestore(), "sim_resolutions", "test-resolution")));
    await assertSucceeds(getDoc(doc(fabricCommitter.firestore(), "sim_resolutions", "test-resolution")));
    // Counters: admin + fabric only.
    await assertFails(getDoc(doc(memberC.firestore(), "sim_counters", "log")));
    await assertFails(getDoc(doc(ownerA.firestore(), "sim_counters", "log")));
    await assertSucceeds(getDoc(doc(adminD.firestore(), "sim_counters", "log")));
    await assertSucceeds(getDoc(doc(fabricWorker.firestore(), "sim_counters", "log")));
    // Actor-private entry (the §7.1 espionage split): actor + admin only.
    await assertSucceeds(
      setDoc(doc(fabricCommitter.firestore(), "sim_log_entries", logEntryDocId(3)), {
        ...validEntry,
        seq: 3,
        visibility: "actor-private",
      })
    );
    await assertSucceeds(getDoc(doc(ownerA.firestore(), "sim_log_entries", logEntryDocId(3))));
    await assertSucceeds(getDoc(doc(adminD.firestore(), "sim_log_entries", logEntryDocId(3))));
    await assertFails(getDoc(doc(ownerB.firestore(), "sim_log_entries", logEntryDocId(3))));
    await assertFails(getDoc(doc(memberC.firestore(), "sim_log_entries", logEntryDocId(3))));
    // Publications / intel read walls.
    await assertSucceeds(getDoc(doc(memberC.firestore(), "sim_publications", "pubMembers")));
    await assertFails(getDoc(doc(guestG.firestore(), "sim_publications", "pubMembers")));
    await assertSucceeds(getDoc(doc(ownerA.firestore(), "sim_intel_records", "intel1")));
    await assertFails(getDoc(doc(ownerB.firestore(), "sim_intel_records", "intel1")));
    await assertFails(getDoc(doc(memberC.firestore(), "sim_intel_records", "intel1")));
  }
  console.log("ok sim read surface (P1-G5)");

  // ---- P1-G6: publication / intel creation discipline.
  {
    const pubDoc = {
      cityId: "cityA",
      businessId: null,
      publisherUid: "ownerA",
      version: 1,
      supersedesPublicationId: null,
      status: "published",
      publishedAtSeq: 3,
      claims: [
        {
          metric: "gdpRubars",
          claimedValue: 5,
          unit: null,
          periodLabel: null,
          note: null,
        },
      ],
      visibility: "members",
    };
    await assertSucceeds(setDoc(doc(ownerA.firestore(), "sim_publications", "pubA1"), pubDoc));
    await assertFails(
      setDoc(doc(ownerA.firestore(), "sim_publications", "pubBadCity"), {
        ...pubDoc,
        cityId: "cityB",
      })
    );
    await assertFails(
      setDoc(doc(ownerA.firestore(), "sim_publications", "pubBadBiz"), {
        ...pubDoc,
        businessId: "corp1",
      })
    );
    // Fabric never publishes; members never create intel.
    await assertFails(
      setDoc(doc(fabricCommitter.firestore(), "sim_publications", "pubFabric"), pubDoc)
    );
    await assertFails(
      setDoc(doc(ownerA.firestore(), "sim_intel_records", "intelBad"), {
        collectorUid: "ownerA",
        collectorCityId: "cityA",
        method: { kindLabel: "survey", methodRef: "sim_actions:test" },
        collectionResolutionId: "test-resolution",
      })
    );
    // No ref, no record — even for the committer.
    await assertFails(
      setDoc(doc(fabricCommitter.firestore(), "sim_intel_records", "intelNoRef"), {
        collectorUid: "ownerA",
        collectorCityId: "cityA",
        method: { kindLabel: "survey", methodRef: "" },
        collectionResolutionId: "test-resolution",
      })
    );
  }
  console.log("ok sim publication and intel discipline (P1-G6)");

  // ---- P1-G7: allocation draft boundary.
  {
    const allocRef = (actor: typeof ownerA) =>
      doc(actor.firestore(), "sim_stat_allocations", "cityA");
    await assertSucceeds(
      updateDoc(allocRef(ownerA), {
        allocations: { spirit: 50 },
        draftVersion: 1,
        draftHash: "c".repeat(64),
        authorUid: "ownerA",
        status: "draft",
        updatedAt: Timestamp.now(),
      })
    );
    await assertFails(updateDoc(allocRef(ownerA), { pointBudget: 999 }));
    await assertFails(updateDoc(allocRef(ownerA), { baselineHash: "x".repeat(64) }));
    await assertFails(updateDoc(allocRef(ownerA), { committedSeq: 9 }));
    await assertFails(updateDoc(allocRef(ownerA), { status: "committed" }));
    await assertFails(
      updateDoc(allocRef(ownerB), { allocations: { spirit: 1 }, status: "draft" })
    );
    // The load-bearing wall: stats change only through the committer.
    await assertFails(
      updateDoc(doc(ownerA.firestore(), "sim_cities", "cityA"), {
        stats: { spirit: 50 },
      })
    );
  }
  console.log("ok sim allocation draft boundary (P1-G7)");

  // ---- P4 Module 0: allocation fence narrowing (build-prep P4-K14).
  // Brief §3.3 makes allocation commit an allocate_season0 ACTION through
  // the play loop; the committer — never the owner — sets commit_requested,
  // and the first versions doc is a fabric write inside the commit
  // transaction (brief §1.2). Exactly one commit path exists (P4-G12-C1).
  {
    const allocRef = (actor: typeof ownerA) =>
      doc(actor.firestore(), "sim_stat_allocations", "cityA");
    // The owner can no longer flip the status to commit_requested: under
    // the Phase 1 fence this exact write succeeded.
    await assertFails(updateDoc(allocRef(ownerA), { status: "commit_requested" }));
    // Draft saves still work — the narrowing removes the commit path, not
    // the draft path.
    await assertSucceeds(
      updateDoc(allocRef(ownerA), {
        draftVersion: 2,
        status: "draft",
        updatedAt: Timestamp.now(),
      })
    );
    // The one remaining commit path: the committer sets commit_requested.
    await assertSucceeds(
      updateDoc(allocRef(fabricCommitter), { status: "commit_requested" })
    );
    await assertSucceeds(
      updateDoc(allocRef(fabricCommitter), { status: "draft" })
    );
    // Versions: the Phase 1 owner-create clause is gone — an owner create
    // fails even with authorUid == their own uid (the old condition).
    const versionDoc = {
      source: "first_login",
      authorUid: "ownerA",
      previewHash: "d".repeat(64),
      commitSeq: 7,
    };
    await assertFails(
      setDoc(
        doc(ownerA.firestore(), "sim_stat_allocations", "cityA", "versions", "vOwner"),
        versionDoc
      )
    );
    // The committer writes the first version.
    await assertSucceeds(
      setDoc(
        doc(fabricCommitter.firestore(), "sim_stat_allocations", "cityA", "versions", "v1"),
        versionDoc
      )
    );
  }
  console.log("ok sim allocation fence narrowing (P4 Module 0, P4-K14)");

  // ---- P4 Allocation assembly: fabric read of the allocation docs.
  // The R-35 read plan (the allocation doc + versions/v1) is
  // materialized by the dispatcher under the committer identity, and
  // undo-restore transactions re-read the commit's write set (§8.5) —
  // both need the fabric read branch added at assembly (the P2-K16
  // pattern, as on sim_intel_records). Draft privacy for everyone
  // else is unchanged; this section proves both halves. It runs on
  // the Module 0 section's leavings: cityA's allocation doc (draft
  // state) and the committer-written versions/v1 (commitSeq 7).
  {
    const allocRef = (actor: typeof ownerA) =>
      doc(actor.firestore(), "sim_stat_allocations", "cityA");
    const versionRef = (actor: typeof ownerA) =>
      doc(actor.firestore(), "sim_stat_allocations", "cityA", "versions", "v1");
    // The fabric identities read both docs (the branch is the service
    // identity, either role — the production service user carries both).
    await assertSucceeds(getDoc(allocRef(fabricCommitter)));
    await assertSucceeds(getDoc(versionRef(fabricCommitter)));
    await assertSucceeds(getDoc(allocRef(fabricWorker)));
    // The owner still reads their own allocation doc.
    await assertSucceeds(getDoc(allocRef(ownerA)));
    // Draft privacy unchanged: a non-owner member, another city's
    // owner, a guest, and anon cannot read the draft-state doc.
    await assertFails(getDoc(allocRef(memberC)));
    await assertFails(getDoc(allocRef(ownerB)));
    await assertFails(getDoc(allocRef(guestG)));
    await assertFails(getDoc(allocRef(anon)));
    // The committed version stays viewer-readable exactly as landed
    // (v1 carries a commitSeq) — the fabric branch widened nothing.
    await assertSucceeds(getDoc(versionRef(memberC)));
  }
  console.log("ok sim allocation fabric read (P4 assembly, P2-K16 pattern)");

  // ---- P4 Finance assembly: member accounts + bank deposits posture.
  // The finance collections are committer-written only (every client
  // write denied); reads are finance §1.2 / §2.7: an account is its
  // owner's + admin + fabric; a personal deposit is its depositor's +
  // the bank owner's (via the corporation record's ownerMemberId) +
  // fabric; company/treasury deposits are public to viewers. The
  // reserved sim_bank_loans block is fabric/admin-only until Phase 5.
  {
    const committerFs = fabricCommitter.firestore();
    await assertSucceeds(
      setDoc(doc(committerFs, "sim_cities", "cityA", "corporations", "bank1"), {
        corporationId: "bank1",
        ownerMemberId: "ownerA",
        companyCashRubars: 500000,
      })
    );
    await assertSucceeds(
      setDoc(doc(committerFs, "sim_member_accounts", "memberC"), {
        memberId: "memberC",
        cashRubars: 250000,
      })
    );
    await assertSucceeds(
      setDoc(doc(committerFs, "sim_bank_deposits", "depPersonal"), {
        depositId: "depPersonal",
        bankCorporationId: "bank1",
        bankCityId: "cityA",
        depositor: { kind: "personal", memberId: "memberC" },
        principalRubars: 1000,
        status: "active",
        origin: "cash",
      })
    );
    await assertSucceeds(
      setDoc(doc(committerFs, "sim_bank_deposits", "depCompany"), {
        depositId: "depCompany",
        bankCorporationId: "bank1",
        bankCityId: "cityA",
        depositor: { kind: "company", corporationId: "corpX", cityId: "cityA" },
        principalRubars: 2000,
        status: "active",
        origin: "cash",
      })
    );
    await assertSucceeds(
      setDoc(doc(committerFs, "sim_bank_loans", "loanReserved"), {
        loanId: "loanReserved",
        bankCorporationId: "bank1",
      })
    );

    const accountRef = (actor: typeof ownerA) =>
      doc(actor.firestore(), "sim_member_accounts", "memberC");
    // Fabric identities read the account (read-plan materialization +
    // undo re-reads run under the service identity, either role).
    await assertSucceeds(getDoc(accountRef(fabricCommitter)));
    await assertSucceeds(getDoc(accountRef(fabricWorker)));
    // The owner reads their own account; nobody else does.
    await assertSucceeds(getDoc(accountRef(memberC)));
    await assertFails(getDoc(accountRef(ownerA)));
    await assertFails(getDoc(accountRef(ownerB)));
    await assertFails(getDoc(accountRef(guestG)));
    await assertFails(getDoc(accountRef(anon)));
    // Client writes are denied for every identity, the owner included;
    // the committer's write path is the only one (proven by the seeds).
    await assertFails(
      setDoc(doc(memberC.firestore(), "sim_member_accounts", "memberC"), {
        memberId: "memberC",
        cashRubars: 1,
      })
    );
    await assertFails(
      setDoc(doc(memberC.firestore(), "sim_member_accounts", "selfMade"), {
        memberId: "selfMade",
        cashRubars: 1,
      })
    );

    const personalRef = (actor: typeof ownerA) =>
      doc(actor.firestore(), "sim_bank_deposits", "depPersonal");
    // Depositor + bank owner + fabric read a personal deposit.
    await assertSucceeds(getDoc(personalRef(memberC)));
    await assertSucceeds(getDoc(personalRef(ownerA)));
    await assertSucceeds(getDoc(personalRef(fabricWorker)));
    // Another city's owner, a guest, and anon cannot.
    await assertFails(getDoc(personalRef(ownerB)));
    await assertFails(getDoc(personalRef(guestG)));
    await assertFails(getDoc(personalRef(anon)));
    // Deposits are committer-written only, depositor included.
    await assertFails(
      setDoc(doc(memberC.firestore(), "sim_bank_deposits", "depPersonal"), {
        depositId: "depPersonal",
        principalRubars: 1,
      })
    );

    const companyRef = (actor: typeof ownerA) =>
      doc(actor.firestore(), "sim_bank_deposits", "depCompany");
    // Company-sourced deposits are public records to any viewer (§2.7).
    await assertSucceeds(getDoc(companyRef(guestG)));
    await assertSucceeds(getDoc(companyRef(ownerB)));
    await assertFails(getDoc(companyRef(anon)));

    // The reserved loans block: no holder reads until Phase 5's shape.
    const loanRef = (actor: typeof ownerA) =>
      doc(actor.firestore(), "sim_bank_loans", "loanReserved");
    await assertSucceeds(getDoc(loanRef(fabricCommitter)));
    await assertFails(getDoc(loanRef(ownerA)));
    await assertFails(getDoc(loanRef(memberC)));
  }
  console.log("ok sim finance collections posture (P4 Finance assembly)");

  // ---- P4 Defensive assembly: sim_cases posture. Cases are
  // committer-written only (R-18's resolution opens them inside the
  // commit transaction; no client write path exists for any identity,
  // the fabric worker included) and viewer-readable (brief §4.5
  // publishes the charges realm-wide; anon is not a viewer).
  {
    const committerFs = fabricCommitter.firestore();
    await assertSucceeds(
      setDoc(doc(committerFs, "sim_cases", "case_seed1"), {
        caseId: "case_seed1",
        status: "open",
        tier: 2,
      })
    );

    const caseRef = (actor: typeof ownerA) =>
      doc(actor.firestore(), "sim_cases", "case_seed1");
    // Any viewer reads a case: owners, plain members, guests.
    await assertSucceeds(getDoc(caseRef(ownerA)));
    await assertSucceeds(getDoc(caseRef(memberC)));
    await assertSucceeds(getDoc(caseRef(guestG)));
    // Anon is not signed in, hence not a viewer.
    await assertFails(getDoc(caseRef(anon)));
    // Client writes are denied for every identity, the fabric worker
    // included; the committer's write path is the only one (proven by
    // the seed above).
    await assertFails(
      setDoc(doc(memberC.firestore(), "sim_cases", "case_forged"), {
        caseId: "case_forged",
        status: "open",
      })
    );
    await assertFails(
      setDoc(doc(guestG.firestore(), "sim_cases", "case_seed1"), {
        caseId: "case_seed1",
        status: "dismissed",
      })
    );
    await assertFails(
      setDoc(doc(fabricWorker.firestore(), "sim_cases", "case_worker"), {
        caseId: "case_worker",
        status: "open",
      })
    );
  }
  console.log("ok sim cases posture (P4 Defensive assembly)");

  // ---- P4 Chains assembly: funds/ + projects/ posture (prep §5 A-3).
  // Fund terms are published at creation and capacity-project state is
  // public sim state: viewer reads, committer-only writes — the
  // sibling subcollection posture (structures/households/laws).
  {
    const committerFs = fabricCommitter.firestore();
    const fundRef = (actor: typeof ownerA) =>
      doc(actor.firestore(), "sim_cities", "cityA", "funds", "fund_seed1");
    const projectRef = (actor: typeof ownerA) =>
      doc(actor.firestore(), "sim_cities", "cityA", "projects", "proj_seed1");
    await assertSucceeds(
      setDoc(doc(committerFs, "sim_cities", "cityA", "funds", "fund_seed1"), {
        fundId: "fund_seed1",
        status: "active",
      })
    );
    await assertSucceeds(
      setDoc(doc(committerFs, "sim_cities", "cityA", "projects", "proj_seed1"), {
        projectId: "proj_seed1",
        status: "standing",
      })
    );
    // Any viewer reads both records: owners, plain members, guests.
    await assertSucceeds(getDoc(fundRef(ownerA)));
    await assertSucceeds(getDoc(fundRef(memberC)));
    await assertSucceeds(getDoc(projectRef(ownerA)));
    await assertSucceeds(getDoc(projectRef(guestG)));
    // Anon is not signed in, hence not a viewer.
    await assertFails(getDoc(fundRef(anon)));
    await assertFails(getDoc(projectRef(anon)));
    // Client writes are denied for non-committer identities; the
    // committer's write path (proven by the seeds above) is the only
    // one.
    await assertFails(
      setDoc(doc(memberC.firestore(), "sim_cities", "cityA", "funds", "fund_forged"), {
        fundId: "fund_forged",
        status: "active",
      })
    );
    await assertFails(
      setDoc(doc(guestG.firestore(), "sim_cities", "cityA", "projects", "proj_forged"), {
        projectId: "proj_forged",
        status: "standing",
      })
    );
  }
  console.log("ok sim funds/projects posture (P4 Chains assembly)");

  // ---- P4 Acquisition assembly: collection means / posture /
  // verification adoptions. Means are owner-readable world records
  // with committer-only writes; the posture record is fabric-only for
  // EVERYONE else (design C-6 — the city's own owner and admin
  // included); adoptions are member-readable markers, committer-only
  // writes.
  {
    const committerFs = fabricCommitter.firestore();

    // Means: seeded by the committer (the only write path).
    await assertSucceeds(
      setDoc(doc(committerFs, "sim_collection_means", "means_seed1"), {
        meansId: "means_seed1",
        ownerUid: "memberC",
        ownerCityId: "cityA",
        status: "active",
      })
    );
    const meansRef = (actor: typeof ownerA) =>
      doc(actor.firestore(), "sim_collection_means", "means_seed1");
    // The owner, an owner of the owner city, admin, and the fabric
    // identity (materialization + the counter-means query) read it.
    await assertSucceeds(getDoc(meansRef(memberC)));
    await assertSucceeds(getDoc(meansRef(ownerA)));
    await assertSucceeds(getDoc(meansRef(adminD)));
    await assertSucceeds(getDoc(meansRef(fabricWorker)));
    // A non-owner member of another city, a guest, and anon do not.
    await assertFails(getDoc(meansRef(ownerB)));
    await assertFails(getDoc(meansRef(guestG)));
    await assertFails(getDoc(meansRef(anon)));
    // Writes are committer-only — the fabric worker included.
    await assertFails(
      setDoc(doc(memberC.firestore(), "sim_collection_means", "means_forged"), {
        meansId: "means_forged",
        ownerUid: "memberC",
        ownerCityId: "cityA",
        status: "active",
      })
    );
    await assertFails(
      setDoc(doc(fabricWorker.firestore(), "sim_collection_means", "means_worker"), {
        meansId: "means_worker",
        ownerUid: "fabricWkr",
        ownerCityId: "cityA",
        status: "active",
      })
    );
    await assertFails(deleteDoc(doc(memberC.firestore(), "sim_collection_means", "means_seed1")));

    // Posture: fabric service reads; the committer writes. NO client
    // identity reads it — the city's own owner and admin are the
    // discriminative denials (C-6 confidentiality).
    await assertSucceeds(
      setDoc(doc(committerFs, "sim_collection_posture", "cityA"), {
        cityId: "cityA",
        discoveredRunIds: [],
      })
    );
    const postureRef = (actor: typeof ownerA) =>
      doc(actor.firestore(), "sim_collection_posture", "cityA");
    await assertSucceeds(getDoc(postureRef(fabricCommitter)));
    await assertSucceeds(getDoc(postureRef(fabricWorker)));
    await assertFails(getDoc(postureRef(ownerA)));
    await assertFails(getDoc(postureRef(adminD)));
    await assertFails(getDoc(postureRef(memberC)));
    await assertFails(getDoc(postureRef(guestG)));
    await assertFails(getDoc(postureRef(anon)));
    await assertFails(
      setDoc(doc(ownerA.firestore(), "sim_collection_posture", "cityA"), {
        cityId: "cityA",
        discoveredRunIds: ["run_forged"],
      })
    );
    await assertFails(
      setDoc(doc(fabricWorker.firestore(), "sim_collection_posture", "cityB"), {
        cityId: "cityB",
        discoveredRunIds: [],
      })
    );

    // Adoptions: member-readable, committer-only writes.
    await assertSucceeds(
      setDoc(doc(committerFs, "sim_verification_adoptions", "adopt_seed1"), {
        reportId: "pub_report1",
        tier: "material",
      })
    );
    const adoptionRef = (actor: typeof ownerA) =>
      doc(actor.firestore(), "sim_verification_adoptions", "adopt_seed1");
    await assertSucceeds(getDoc(adoptionRef(memberC)));
    await assertSucceeds(getDoc(adoptionRef(ownerA)));
    await assertSucceeds(getDoc(adoptionRef(adminD)));
    // Guests are viewers, not full members; anon is neither.
    await assertFails(getDoc(adoptionRef(guestG)));
    await assertFails(getDoc(adoptionRef(anon)));
    await assertFails(
      setDoc(doc(memberC.firestore(), "sim_verification_adoptions", "adopt_forged"), {
        reportId: "pub_forged",
        tier: "minor",
      })
    );
    await assertFails(
      setDoc(doc(fabricWorker.firestore(), "sim_verification_adoptions", "adopt_worker"), {
        reportId: "pub_worker",
        tier: "minor",
      })
    );
  }
  console.log("ok sim acquisition collections posture (P4 Acquisition assembly)");

  // ----------------------------------------------------------------------
  // Phase 4 step 7 assembly (P4 Market): the five market collections
  // carry the sim_cases posture — committer-only writes, viewer reads.
  // Per collection: the committer seeds; owner/member/guest read;
  // anon does not; member and fabric-worker writes fail (the worker
  // denial is the discriminative half of committer-only).
  // ----------------------------------------------------------------------
  {
    const committerFs = fabricCommitter.firestore();
    const marketSeeds: Array<[string, string, Record<string, unknown>]> = [
      ["sim_market_account", "main", { kind: "market-account", cashRubars: 1000000 }],
      ["sim_market_listings", "corp_seed1", { corporationId: "corp_seed1", status: "listed" }],
      ["sim_holdings", "memberA__corp_seed1", { memberId: "memberA", corporationId: "corp_seed1", quantityShares: 10 }],
      ["sim_market_orders", "ord_seed1", { orderId: "ord_seed1", corporationId: "corp_seed1", status: "resting" }],
      ["sim_market_trades", "trade_seed1_01", { tradeId: "trade_seed1_01", corporationId: "corp_seed1", seq: 1 }],
    ];
    for (const [collection, id, seed] of marketSeeds) {
      await assertSucceeds(setDoc(doc(committerFs, collection, id), seed));
      const ref = (actor: typeof ownerA) => doc(actor.firestore(), collection, id);
      await assertSucceeds(getDoc(ref(ownerA)));
      await assertSucceeds(getDoc(ref(memberC)));
      await assertSucceeds(getDoc(ref(guestG)));
      await assertFails(getDoc(ref(anon)));
      await assertFails(setDoc(doc(memberC.firestore(), collection, `${id}_forged`), seed));
      await assertFails(setDoc(doc(fabricWorker.firestore(), collection, `${id}_worker`), seed));
      await assertFails(deleteDoc(doc(memberC.firestore(), collection, id)));
    }
  }
  console.log("ok sim market collections posture (P4 Market assembly)");

  // ======================================================================
  // Sim layer (Phase 2) — P2-G9: the rules amendment surface (brief §9).
  // Fixtures here are seeded after genesis (the Phase 1 ordering lesson)
  // and use fresh doc ids, so the Phase 1 fixtures above stay untouched.
  // ======================================================================

  // ---- P2-G9a: §9.1 entry shape — v1 is genesis-only; v2 field discipline.
  {
    const committerFs = fabricCommitter.firestore();
    // v1 at seq != 1 is refused even for the committer.
    await assertFails(
      setDoc(doc(committerFs, "sim_log_entries", logEntryDocId(9)), {
        ...validEntry,
        seq: 9,
        hashVersion: "cowboy-canonical-json-v1",
      })
    );
    // v2 missing one of the four Phase 2 fields is refused.
    const { generation: _dropped, ...entryMissingGeneration } = validEntry;
    await assertFails(
      setDoc(doc(committerFs, "sim_log_entries", logEntryDocId(9)), {
        ...entryMissingGeneration,
        seq: 9,
      })
    );
    // v2 with a wrongly-typed Phase 2 field is refused.
    await assertFails(
      setDoc(doc(committerFs, "sim_log_entries", logEntryDocId(9)), {
        ...validEntry,
        seq: 9,
        executedDuringSeq: "not-an-int",
      })
    );
    // The well-formed v2 entry succeeds — and the committer can delete it
    // (the undo path), while update stays denied for every identity.
    await assertSucceeds(
      setDoc(doc(committerFs, "sim_log_entries", logEntryDocId(9)), {
        ...validEntry,
        seq: 9,
      })
    );
    await assertFails(
      updateDoc(doc(committerFs, "sim_log_entries", logEntryDocId(9)), { major: true })
    );
    await assertFails(
      updateDoc(doc(adminD.firestore(), "sim_log_entries", logEntryDocId(9)), { major: true })
    );
    await assertSucceeds(deleteDoc(doc(committerFs, "sim_log_entries", logEntryDocId(9))));
  }
  console.log("ok sim entry v2 shape + committer delete (P2-G9a)");

  // ---- P2-G9b: §9.3/§9.7 — manifest + state committer deletes.
  {
    const committerFs = fabricCommitter.firestore();
    await assertSucceeds(
      setDoc(doc(committerFs, "sim_resolutions", "test-resolution-del"), {
        resolutionId: "test-resolution-del",
      })
    );
    await assertSucceeds(deleteDoc(doc(committerFs, "sim_resolutions", "test-resolution-del")));
    // State delete (undo restore): the committer deletes the throwaway
    // city doc created in P1-G1, and a structure under an existing city.
    await assertSucceeds(deleteDoc(doc(committerFs, "sim_cities", "cityNew")));
    await assertSucceeds(
      setDoc(doc(committerFs, "sim_cities", "cityB", "structures", "del-me"), { name: "Tmp" })
    );
    await assertSucceeds(
      deleteDoc(doc(committerFs, "sim_cities", "cityB", "structures", "del-me"))
    );
    await assertFails(deleteDoc(doc(memberC.firestore(), "sim_cities", "cityB")));
  }
  console.log("ok sim manifest/state committer deletes (P2-G9b)");

  // ---- P2-G9c: §9.4 — the confirmation fix (P2-D7), positive + negatives.
  {
    const actionBase = {
      schemaVersion: 2,
      clientRequestId: "req-x",
      idempotencyKey: "req-x",
      source: "web",
      actor: {
        type: "member",
        memberId: "ownerA",
        npcId: null,
        onBehalfOfMemberId: null,
        mandateId: null,
        mandateVersion: null,
        envelopeId: null,
      },
      actionType: "fixture_adjust",
      actionText: "nudge",
      structuredAction: { cityId: "cityA", field: "stats.treasuryRubars", delta: 1 },
      targetCityIds: ["cityA"],
      threadRef: null,
      audienceUids: ["ownerA"],
      previewPlanHash: "plan-hash-1",
      claim: null,
      lastAttempt: null,
      resolutionId: null,
      firstLogSeq: null,
      lastLogSeq: null,
      failure: null,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    };
    const awaitingDoc = {
      ...actionBase,
      status: "awaiting_confirmation",
      preview: { previewHash: "hash-1", summaryText: "s" },
      confirmation: null,
    };
    await env.withSecurityRulesDisabled(async (context) => {
      const fs = context.firestore();
      await setDoc(doc(fs, "sim_actions", "actConfirmOk"), awaitingDoc);
      await setDoc(doc(fs, "sim_actions", "actConfirmWrongHash"), awaitingDoc);
      await setDoc(doc(fs, "sim_actions", "actConfirmWrongMember"), awaitingDoc);
      await setDoc(doc(fs, "sim_actions", "actConfirmExtraKey"), awaitingDoc);
      await setDoc(doc(fs, "sim_actions", "actStillReceived"), {
        ...awaitingDoc,
        status: "received",
      });
      await setDoc(doc(fs, "sim_actions", "actDelete"), {
        ...actionBase,
        status: "received",
        preview: null,
        confirmation: null,
      });
    });
    const confirmWith = (hash: string) => ({
      confirmation: {
        confirmedByUid: "ownerA",
        confirmedAt: Timestamp.now(),
        previewHash: hash,
        authorityType: "owner",
      },
      status: "confirmed",
      updatedAt: Timestamp.now(),
    });
    const ownerAFs = ownerA.firestore();
    // The positive case Phase 1 could never pass: the one lawful
    // confirmation (exact stored hash, only the fenced keys, the
    // awaiting -> confirmed transition) SUCCEEDS.
    await assertSucceeds(updateDoc(doc(ownerAFs, "sim_actions", "actConfirmOk"), confirmWith("hash-1")));
    // Wrong preview hash: refused.
    await assertFails(
      updateDoc(doc(ownerAFs, "sim_actions", "actConfirmWrongHash"), confirmWith("hash-2"))
    );
    // Another member cannot confirm ownerA's action.
    await assertFails(
      updateDoc(doc(ownerB.firestore(), "sim_actions", "actConfirmWrongMember"), confirmWith("hash-1"))
    );
    // Touching any key outside the fence is refused.
    await assertFails(
      updateDoc(doc(ownerAFs, "sim_actions", "actConfirmExtraKey"), {
        ...confirmWith("hash-1"),
        resolutionId: "forged",
      })
    );
    // Confirmation from 'received' (no preview step) is refused.
    await assertFails(
      updateDoc(doc(ownerAFs, "sim_actions", "actStillReceived"), confirmWith("hash-1"))
    );
    // Create tightening: born-received with nulls succeeds; born-awaiting
    // or carrying a self-authored preview fails.
    await assertSucceeds(
      setDoc(doc(ownerAFs, "sim_actions", "actBorn"), {
        ...actionBase,
        status: "received",
        preview: null,
        previewPlanHash: null,
        confirmation: null,
      })
    );
    await assertFails(
      setDoc(doc(ownerAFs, "sim_actions", "actBornBad"), {
        ...actionBase,
        status: "awaiting_confirmation",
        preview: null,
        confirmation: null,
      })
    );
    await assertFails(
      setDoc(doc(ownerAFs, "sim_actions", "actBornBad2"), {
        ...actionBase,
        status: "received",
        preview: { previewHash: "self-authored" },
        confirmation: null,
      })
    );
    // The committer deletes the source action inside an undo; members can't.
    await assertFails(deleteDoc(doc(ownerAFs, "sim_actions", "actDelete")));
    await assertSucceeds(
      deleteDoc(doc(fabricCommitter.firestore(), "sim_actions", "actDelete"))
    );
  }
  console.log("ok sim confirmation clause fix + create tightening (P2-G9c)");

  // ---- PR-4: the wake-pass fabric create for delegated actions.
  // The committer may mint a delegated action (NPC actor, source
  // "wake-pass", born 'confirmed', no preview/confirmation/resolution
  // fields); every neighboring shape is refused — a member minting an
  // NPC-actor action, the worker identity minting anything, the
  // committer minting a member-actor action or a differently-sourced
  // or differently-born one.
  {
    const passActionBase = {
      schemaVersion: 2,
      clientRequestId: "dlg-pass-1",
      idempotencyKey: "dlg-pass-1",
      source: "wake-pass",
      actor: {
        type: "npc",
        memberId: null,
        npcId: "npc1",
        onBehalfOfMemberId: "ownerA",
        mandateId: "mandate1",
        mandateVersion: 1,
        envelopeId: null,
      },
      actionType: "fixture_adjust",
      actionText: null,
      structuredAction: { cityId: "cityA", field: "stats.treasuryRubars", delta: 1 },
      targetCityIds: ["cityA"],
      threadRef: { kind: "situation", id: "sit-pass-1" },
      audienceUids: ["ownerA"],
      preview: null,
      previewPlanHash: null,
      confirmation: null,
      claim: null,
      lastAttempt: null,
      status: "confirmed",
      resolutionId: null,
      firstLogSeq: null,
      lastLogSeq: null,
      failure: null,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    };
    await assertSucceeds(
      setDoc(doc(fabricCommitter.firestore(), "sim_actions", "actPassOk"), passActionBase)
    );
    await assertFails(
      setDoc(doc(ownerA.firestore(), "sim_actions", "actPassByMember"), passActionBase)
    );
    await assertFails(
      setDoc(doc(fabricWorker.firestore(), "sim_actions", "actPassByWorker"), passActionBase)
    );
    await assertFails(
      setDoc(doc(fabricCommitter.firestore(), "sim_actions", "actPassMemberActor"), {
        ...passActionBase,
        actor: { ...passActionBase.actor, type: "member", memberId: "ownerA", npcId: null },
      })
    );
    await assertFails(
      setDoc(doc(fabricCommitter.firestore(), "sim_actions", "actPassWrongSource"), {
        ...passActionBase,
        source: "web",
      })
    );
    await assertFails(
      setDoc(doc(fabricCommitter.firestore(), "sim_actions", "actPassBornReceived"), {
        ...passActionBase,
        status: "received",
      })
    );
    await assertFails(
      setDoc(doc(fabricCommitter.firestore(), "sim_actions", "actPassWithPreview"), {
        ...passActionBase,
        preview: { previewHash: "self-authored" },
      })
    );
  }
  console.log("ok sim_actions wake-pass fabric create fence (PR-4)");

  // ---- P2-G9d: §9.5 pendings — audience-scoped reads, committer-only writes.
  {
    const pendingDoc = {
      pendingId: "pend_rules_1",
      kind: "delayed-stat-effect",
      status: "pending",
      audienceUids: ["ownerA"],
      payloadSpec: { mode: "determinate", secret: "seed-material" },
    };
    await env.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(context.firestore(), "sim_pending_consequences", "pend_rules_1"),
        pendingDoc
      );
    });
    const read = (actor: typeof ownerA) =>
      getDoc(doc(actor.firestore(), "sim_pending_consequences", "pend_rules_1"));
    await assertSucceeds(read(ownerA));
    await assertSucceeds(read(adminD));
    await assertSucceeds(read(fabricWorker));
    // Seed non-disclosure: a non-audience member cannot read the doc at all.
    await assertFails(read(memberC));
    await assertFails(read(ownerB));
    await assertFails(read(guestG));
    // Writes: committer only.
    await assertFails(
      setDoc(doc(ownerA.firestore(), "sim_pending_consequences", "pend_rules_2"), pendingDoc)
    );
    const committerFs = fabricCommitter.firestore();
    await assertSucceeds(
      setDoc(doc(committerFs, "sim_pending_consequences", "pend_rules_2"), {
        ...pendingDoc,
        pendingId: "pend_rules_2",
      })
    );
    await assertSucceeds(
      updateDoc(doc(committerFs, "sim_pending_consequences", "pend_rules_2"), { attempts: 1 })
    );
    await assertFails(
      updateDoc(doc(ownerA.firestore(), "sim_pending_consequences", "pend_rules_1"), { attempts: 1 })
    );
    await assertSucceeds(deleteDoc(doc(committerFs, "sim_pending_consequences", "pend_rules_2")));
  }
  console.log("ok sim pendings rules surface (P2-G9d)");

  // ---- P2-G9e: §9.6 undo operations — member asks, fabric decides.
  {
    const opDoc = {
      opId: "op_rules_1",
      requesterUid: "ownerA",
      targetResolutionId: "test-resolution",
      status: "requested",
      dependencyReport: null,
      completion: null,
      failure: null,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    };
    const ownerAFs = ownerA.firestore();
    await assertSucceeds(setDoc(doc(ownerAFs, "sim_undo_operations", "op_rules_1"), opDoc));
    // Born in the wrong status, for someone else, or with a pre-filled
    // report/completion: all refused.
    await assertFails(
      setDoc(doc(ownerAFs, "sim_undo_operations", "op_rules_2"), { ...opDoc, status: "checking" })
    );
    await assertFails(
      setDoc(doc(ownerAFs, "sim_undo_operations", "op_rules_3"), {
        ...opDoc,
        requesterUid: "ownerB",
      })
    );
    await assertFails(
      setDoc(doc(ownerAFs, "sim_undo_operations", "op_rules_4"), {
        ...opDoc,
        completion: { forged: true },
      })
    );
    // The requester reads their own op; another member cannot.
    await assertSucceeds(getDoc(doc(ownerAFs, "sim_undo_operations", "op_rules_1")));
    await assertFails(getDoc(doc(ownerB.firestore(), "sim_undo_operations", "op_rules_1")));
    await assertSucceeds(getDoc(doc(adminD.firestore(), "sim_undo_operations", "op_rules_1")));
    // Only the fabric moves an operation.
    await assertFails(
      updateDoc(doc(ownerAFs, "sim_undo_operations", "op_rules_1"), { status: "checking" })
    );
    await assertSucceeds(
      updateDoc(doc(fabricWorker.firestore(), "sim_undo_operations", "op_rules_1"), {
        status: "checking",
      })
    );
    // Deleted by nobody, committer included.
    await assertFails(
      deleteDoc(doc(fabricCommitter.firestore(), "sim_undo_operations", "op_rules_1"))
    );
  }
  console.log("ok sim undo operations rules surface (P2-G9e)");

  // ---- P4 Lore assembly: lore postures (prep §4(c)(d)) + the F-L7
  // ledger-read facts. Wiki drafts are fabric-born, owner-read and
  // owner-decided (field-limited); the adoption commit is the
  // committer's. Wiki provenance fields are fabric-only on client
  // writes; version snapshots are immutable. The drafts badge fence
  // keeps a member from hand-badging a draft `sim` into R-11.
  {
    const committerFs = fabricCommitter.firestore();

    // -- sim_wiki_entry_drafts --------------------------------------
    await assertSucceeds(
      setDoc(doc(committerFs, "sim_wiki_entry_drafts", "wdraft_seed1"), {
        targetCityId: "cityA",
        status: "pending",
        changeType: "new_entry",
        proposedTitle: "Seed Draft",
      })
    );
    const wdraft = (actor: typeof ownerA) =>
      doc(actor.firestore(), "sim_wiki_entry_drafts", "wdraft_seed1");
    // Reads: the subject city's owner, admin, and the fabric (whose
    // resolution path reads the named draft); nobody else.
    await assertSucceeds(getDoc(wdraft(ownerA)));
    await assertSucceeds(getDoc(wdraft(adminD)));
    await assertSucceeds(getDoc(wdraft(fabricWorker)));
    await assertFails(getDoc(wdraft(ownerB)));
    await assertFails(getDoc(wdraft(memberC)));
    await assertFails(getDoc(wdraft(anon)));
    // The worker never writes one; a member never writes one at all.
    await assertFails(
      setDoc(doc(fabricWorker.firestore(), "sim_wiki_entry_drafts", "wdraft_forged"), {
        targetCityId: "cityA",
        status: "pending",
      })
    );
    await assertFails(
      setDoc(doc(memberC.firestore(), "sim_wiki_entry_drafts", "wdraft_forged2"), {
        targetCityId: "cityA",
        status: "pending",
      })
    );
    // The owner's decision write: pending-only, field-limited to
    // status + decision, and only toward the two decision states —
    // 'adopted' is the committer's outcome, never a client write.
    await assertFails(updateDoc(wdraft(ownerA), { status: "adopted" }));
    await assertFails(
      updateDoc(wdraft(ownerA), { status: "rejected", resultWikiEntryId: "wiki_x" })
    );
    await assertFails(updateDoc(wdraft(memberC), { status: "rejected" }));
    await assertSucceeds(
      updateDoc(wdraft(ownerA), {
        status: "adoption_requested",
        decision: { byUid: "ownerA", note: "please adopt" },
      })
    );
    // No longer pending: the owner's decision write has closed.
    await assertFails(updateDoc(wdraft(ownerA), { status: "rejected" }));
    // The adoption commit itself is the committer's.
    await assertSucceeds(
      updateDoc(wdraft(fabricCommitter), {
        status: "adopted",
        resultWikiEntryId: "wiki_wdraft_seed1",
        resultWikiVersion: 1,
      })
    );

    // -- wiki_entries provenance fence + versions --------------------
    const entryRef = (actor: typeof ownerA) =>
      doc(actor.firestore(), "wiki_entries", "entry_client1");
    // A clean member create (the Phase 1 flow) still works.
    await assertSucceeds(
      setDoc(entryRef(ownerA), {
        cityId: "cityA",
        kind: "place",
        title: "Client Entry",
        slug: "client-entry",
        body: "body",
      })
    );
    // A create carrying a fabric-provenance field is refused.
    await assertFails(
      setDoc(doc(ownerA.firestore(), "wiki_entries", "entry_forged"), {
        cityId: "cityA",
        kind: "place",
        title: "Forged",
        slug: "forged",
        body: "body",
        currentVersion: 7,
      })
    );
    // An owner edit is fine; an owner touch of a provenance field is not.
    await assertSucceeds(updateDoc(entryRef(ownerA), { body: "edited body" }));
    await assertFails(updateDoc(entryRef(ownerA), { canonLayer: "realm" }));
    // The committer advances the pointer (the adoption commit).
    await assertSucceeds(
      updateDoc(entryRef(fabricCommitter), {
        currentVersion: 1,
        versioned: true,
        canonLayer: "current",
        canonStatus: "canon",
      })
    );
    // Versions: committer-created, member-readable (like the entry),
    // updatable by NOBODY, deletable only via the committer's
    // undo-erasure channel.
    const versionRef = (actor: typeof ownerA) =>
      doc(actor.firestore(), "wiki_entries", "entry_client1", "versions", "1");
    await assertSucceeds(
      setDoc(versionRef(fabricCommitter), { version: 1, canonStatus: "canon" })
    );
    await assertSucceeds(getDoc(versionRef(memberC)));
    await assertFails(getDoc(versionRef(anon)));
    await assertFails(setDoc(versionRef(memberC), { version: 1 }));
    await assertFails(updateDoc(versionRef(fabricCommitter), { canonStatus: "x" }));
    await assertFails(deleteDoc(versionRef(memberC)));
    await assertSucceeds(deleteDoc(versionRef(fabricCommitter)));

    // -- drafts badge fence + committer paths -------------------------
    const badgeRef = (actor: typeof ownerA) =>
      doc(actor.firestore(), "drafts", "chronicle_seed1");
    await assertSucceeds(
      setDoc(badgeRef(fabricCommitter), {
        type: "lore",
        factionId: "cityA",
        characterId: "",
        title: "Seed Telling",
        body: "body",
        authorUid: "",
        authorType: "sim",
        status: "draft",
        badge: "sim",
        canonLayer: "sim",
        source: "sim-chronicle",
        sourceResolutionId: "res_seed",
        sourceCityId: "cityA",
        sourceRuleIds: ["R-32"],
      })
    );
    // The fabric reads badged drafts (the R-11 path); a plain member
    // cannot — a badged draft is not theirs and not yet published.
    await assertSucceeds(getDoc(badgeRef(fabricWorker)));
    await assertFails(getDoc(badgeRef(memberC)));
    // A member cannot forge the badge on create...
    await assertFails(
      setDoc(doc(memberC.firestore(), "drafts", "draft_forged"), {
        authorUid: "memberC",
        status: "draft",
        title: "Forged",
        body: "body",
        badge: "sim",
      })
    );
    // ...and the worker cannot badge one either.
    await assertFails(
      setDoc(doc(fabricWorker.firestore(), "drafts", "draft_worker"), {
        authorUid: "",
        status: "draft",
        title: "W",
        body: "b",
        badge: "sim",
      })
    );
    // An ordinary member draft (no badge fields) is untouched by the fence.
    await assertSucceeds(
      setDoc(doc(memberC.firestore(), "drafts", "draft_note1"), {
        authorUid: "memberC",
        status: "draft",
        title: "Ordinary",
        body: "body",
      })
    );
    // The faction owner may edit the telling but may not touch its badge.
    await assertSucceeds(updateDoc(badgeRef(ownerA), { title: "Seed Telling (edited)" }));
    await assertFails(updateDoc(badgeRef(ownerA), { source: "hand-written" }));
    // Chronicle consumption deletes through the committer.
    await assertSucceeds(deleteDoc(badgeRef(fabricCommitter)));

    // -- posts: the committer publishes sim-authored posts only -------
    const simPostRef = (actor: typeof ownerA) =>
      doc(actor.firestore(), "posts", "post_sim1");
    await assertSucceeds(
      setDoc(simPostRef(fabricCommitter), {
        factionId: "cityA",
        authorUid: "",
        authorType: "sim",
        type: "lore",
        status: "published",
        title: "Canon Telling",
        body: "body",
        cityIds: ["cityA"],
      })
    );
    // The branch is sim-scoped: the committer cannot mint a
    // member-authored post, and a member cannot hijack a sim post.
    await assertFails(
      setDoc(doc(fabricCommitter.firestore(), "posts", "post_forged"), {
        factionId: "cityA",
        authorUid: "",
        authorType: "member",
        status: "published",
        title: "X",
        body: "b",
      })
    );
    await assertFails(updateDoc(simPostRef(memberC), { title: "hijack" }));
    await assertSucceeds(deleteDoc(simPostRef(fabricCommitter)));

    // -- lore_cross_refs ----------------------------------------------
    const xrefRef = (actor: typeof ownerA) =>
      doc(actor.firestore(), "sim_cities", "cityB", "lore_cross_refs", "wiki_entry1");
    await assertSucceeds(
      setDoc(
        doc(committerFs, "sim_cities", "cityB", "lore_cross_refs", "wiki_entry1"),
        { entryId: "wiki_entry1", sourceCityId: "cityA", removableByOwner: true }
      )
    );
    await assertSucceeds(getDoc(xrefRef(ownerB)));
    await assertSucceeds(getDoc(xrefRef(memberC)));
    await assertSucceeds(getDoc(xrefRef(guestG)));
    await assertFails(getDoc(xrefRef(anon)));
    await assertFails(
      setDoc(doc(memberC.firestore(), "sim_cities", "cityB", "lore_cross_refs", "wiki_forged"), {
        entryId: "x",
      })
    );

    // -- F-L7 doc-level facts ------------------------------------------
    // The City Ledger export runs two as-requester list queries whose
    // results inherit these per-doc postures: a public Log entry is
    // member-readable; an actor-private entry is readable ONLY by its
    // own actor (never by the city's owner or any other member — the
    // builder's client-side skip cannot rescue a query whose result
    // set contains one); another member's action is readable only by
    // its actor, its audience, or an admin. A list returns only docs
    // the requester may read — so whenever such a record names the
    // city, the ledger export fails closed (honest error, no file).
    // That is the designed posture; these pins are its doc-level proof.
    await assertSucceeds(
      setDoc(doc(committerFs, "sim_log_entries", logEntryDocId(900)), {
        ...validEntry,
        seq: 900,
        resolutionSeq: 900,
        cityId: "cityA",
        cityIds: ["cityA"],
        visibility: "actor-private",
        actor: { ...validEntry.actor, memberId: "ownerA" },
      })
    );
    await assertSucceeds(
      getDoc(doc(ownerA.firestore(), "sim_log_entries", logEntryDocId(900)))
    );
    await assertFails(
      getDoc(doc(ownerB.firestore(), "sim_log_entries", logEntryDocId(900)))
    );
    await assertSucceeds(
      setDoc(doc(committerFs, "sim_log_entries", logEntryDocId(901)), {
        ...validEntry,
        seq: 901,
        resolutionSeq: 901,
        cityId: "cityA",
        cityIds: ["cityA"],
        visibility: "public",
      })
    );
    await assertSucceeds(
      getDoc(doc(memberC.firestore(), "sim_log_entries", logEntryDocId(901)))
    );
    await env.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "sim_actions", "act_ledger1"), {
        actor: { type: "member", memberId: "ownerA" },
        targetCityIds: ["cityA"],
        audienceUids: [],
        status: "resolved",
      });
    });
    await assertSucceeds(
      getDoc(doc(ownerA.firestore(), "sim_actions", "act_ledger1"))
    );
    await assertFails(
      getDoc(doc(ownerB.firestore(), "sim_actions", "act_ledger1"))
    );
  }
  console.log("ok lore postures + badge fence + F-L7 facts (P4 Lore assembly)");

  // --- Phase 5 substrate (brief §9; gate row P5-G9) ----------------------
  // The seven Phase 5 collections under the §1.2 write split: members
  // author PENDING records; only the committer makes anything effective.
  //
  // HELD OUT (A-7 discipline): the undo-restore assertion that a restore
  // transaction DELETES an effective mandate version is NOT in this
  // suite. Brief §9.8's exemption says effective versions are deletable
  // by no identity; decisions P5-D6 (whether a restore transaction is
  // the one carve-out) is FLAGGED for Koda and unratified at this PR.
  // What IS asserted below is the ratified ground both readings share:
  // an effective version's delete fails for every identity tried here
  // (author, committer, worker), and the committer's supersededSeq-only
  // restore flip succeeds. When P5-D6 is ratified, the restore-context
  // assertion lands in the gate PR (W6) in its ratified form.
  {
    // Fixtures: a character per city + one ACTIVE NPC per owner (seeded
    // fabric-side; member authoring is exercised live below).
    await env.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "characters", "charA1"), { factionId: "cityA", name: "Ada Archivist" });
      await setDoc(doc(db, "characters", "charB1"), { factionId: "cityB", name: "Bo Broker" });
      await setDoc(doc(db, "sim_npcs", "npcA1"), {
        npcId: "npcA1", characterId: "charA1", cityId: "cityA", ownerUid: "ownerA",
        status: "active", permissionMode: "ask-first",
      });
      await setDoc(doc(db, "sim_npcs", "npcB1"), {
        npcId: "npcB1", characterId: "charB1", cityId: "cityB", ownerUid: "ownerB",
        status: "active", permissionMode: "ask-first",
      });
    });

    const npcCreateDoc = (over: Record<string, unknown> = {}) => ({
      npcId: "charA1",
      characterId: "charA1",
      cityId: "cityA",
      ownerUid: "ownerA",
      displayNameSnapshot: "Ada Archivist",
      titleFreeform: "Chief Archivist",
      roleTemplate: "steward",
      personality: { traits: ["meticulous"], voiceNotes: null, characterNotes: null },
      scopeFreeform: "Keep the city rolls.",
      permissionMode: "ask-first",
      status: "pending_activation",
      currentMandateId: null,
      currentMandateVersion: null,
      activationSeq: null,
      retiredSeq: null,
      stateVersion: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    });

    // §9.1 sim_npcs — the refusals run first, each isolating one fence
    // against the standing charA1 character fixture.
    await assertSucceeds(getDoc(doc(memberC.firestore(), "sim_npcs", "npcA1"))); // viewer read
    await assertFails(setDoc(doc(ownerA.firestore(), "sim_npcs", "charA1"), npcCreateDoc({ backdoor: true }))); // field fence
    await assertFails(setDoc(doc(ownerA.firestore(), "sim_npcs", "charA1"), npcCreateDoc({ scopeFreeform: "x".repeat(4001) }))); // freeform cap
    await assertFails(setDoc(doc(ownerA.firestore(), "sim_npcs", "charA1"), npcCreateDoc({ permissionMode: "whenever" }))); // mode fence
    await assertFails(setDoc(doc(ownerA.firestore(), "sim_npcs", "charA1"), npcCreateDoc({ status: "active" }))); // born pending only
    await assertFails(setDoc(doc(memberC.firestore(), "sim_npcs", "charA9"), npcCreateDoc({ npcId: "charA9", ownerUid: "memberC" }))); // not the city owner
    await assertFails(setDoc(doc(ownerA.firestore(), "sim_npcs", "charB1"), npcCreateDoc({ npcId: "charB1", characterId: "charB1" }))); // character serves cityB
    await assertFails(setDoc(doc(fabricWorker.firestore(), "sim_npcs", "charA1"), npcCreateDoc())); // worker never authors
    await assertSucceeds(setDoc(doc(ownerA.firestore(), "sim_npcs", "charA1"), npcCreateDoc()));
    await assertSucceeds(updateDoc(doc(ownerA.firestore(), "sim_npcs", "charA1"), { titleFreeform: "Chief Archivist & Keeper" })); // pending authoring correction
    await assertFails(updateDoc(doc(ownerA.firestore(), "sim_npcs", "charA1"), { status: "active" })); // activation is the fabric's
    await assertFails(updateDoc(doc(memberC.firestore(), "sim_npcs", "charA1"), { titleFreeform: "Nope" }));
    await assertSucceeds(updateDoc(doc(fabricCommitter.firestore(), "sim_npcs", "charA1"), { status: "active", activationSeq: 50 })); // fabric flip
    await assertFails(deleteDoc(doc(ownerA.firestore(), "sim_npcs", "charA1")));
    await assertSucceeds(deleteDoc(doc(fabricCommitter.firestore(), "sim_npcs", "charA1"))); // §9.8 undo erasure

    // §9.2 sim_teams — fabric-derived, member-read-only
    await assertSucceeds(getDoc(doc(memberC.firestore(), "sim_teams", "cityA")));
    await assertFails(setDoc(doc(memberC.firestore(), "sim_teams", "cityA"), { cityId: "cityA", npcIds: [] }));
    await assertSucceeds(setDoc(doc(fabricCommitter.firestore(), "sim_teams", "cityA"), { cityId: "cityA", npcIds: ["npcA1"] }));
    await assertFails(setDoc(doc(fabricWorker.firestore(), "sim_teams", "cityB"), { cityId: "cityB", npcIds: [] }));
    await assertSucceeds(deleteDoc(doc(fabricCommitter.firestore(), "sim_teams", "cityA")));

    // §9.3 sim_mandates + versions
    const mandateRoot = (over: Record<string, unknown> = {}) => ({
      mandateId: "mandateA1",
      npcId: "npcA1",
      cityId: "cityA",
      ownerUid: "ownerA",
      currentVersion: 0,
      status: "pending",
      currentVersionRef: null,
      createdSeq: null,
      revokedSeq: null,
      expiresAtSeq: null,
      ...over,
    });
    const mandateVersion = (over: Record<string, unknown> = {}) => ({
      mandateId: "mandateA1",
      npcId: "npcA1",
      cityId: "cityA",
      ownerUid: "ownerA",
      version: 1,
      permissionMode: "ask-first",
      scopeFreeform: "Run the archive.",
      structuredScope: { allowedActionTypes: [], allowedCityIds: ["cityA"], targetKinds: [], excludedTargets: [] },
      caps: { perActionRubars: null, perWakeRubars: null, maxResolutionsPerWake: null, allowPartialExecution: true },
      negotiationBounds: null,
      alwaysEscalate: [],
      responseStyle: "",
      expiresAtSeq: null,
      horizonActions: null,
      sourceActionId: "act_fixture",
      effectiveSeq: null,
      supersededSeq: null,
      mandateHash: "fixturehash",
      ...over,
    });
    await assertSucceeds(getDoc(doc(memberC.firestore(), "sim_mandates", "mandateA1"))); // group-readable
    await assertSucceeds(setDoc(doc(ownerA.firestore(), "sim_mandates", "mandateA1"), mandateRoot()));
    await assertFails(setDoc(doc(ownerA.firestore(), "sim_mandates", "mandateA2"), mandateRoot({ mandateId: "mandateA2", status: "active" }))); // born pending
    await assertFails(setDoc(doc(ownerB.firestore(), "sim_mandates", "mandateA3"), mandateRoot({ mandateId: "mandateA3", ownerUid: "ownerB" }))); // not B's city
    await assertSucceeds(
      setDoc(doc(ownerA.firestore(), "sim_mandates", "mandateA1", "versions", "1"), mandateVersion())
    ); // next version over a currentVersion-0 root
    await assertFails(
      setDoc(doc(ownerA.firestore(), "sim_mandates", "mandateA1", "versions", "3"), mandateVersion({ version: 3 }))
    ); // skips the sequence
    await assertSucceeds(
      updateDoc(doc(fabricCommitter.firestore(), "sim_mandates", "mandateA1"), { currentVersion: 1 })
    ); // the fabric advances the pointer when v1 takes effect in a resolution
    await assertFails(
      setDoc(doc(memberC.firestore(), "sim_mandates", "mandateA1", "versions", "2"), mandateVersion({ version: 2, ownerUid: "memberC" }))
    ); // the sequence is right; the author is not
    await assertFails(
      updateDoc(doc(ownerA.firestore(), "sim_mandates", "mandateA1", "versions", "1"), { scopeFreeform: "Edited." })
    ); // payloads are immutable — for the author too
    await assertFails(
      updateDoc(doc(fabricCommitter.firestore(), "sim_mandates", "mandateA1", "versions", "1"), { supersededSeq: 60 })
    ); // the restore flip needs an EFFECTIVE version
    await assertSucceeds(deleteDoc(doc(ownerA.firestore(), "sim_mandates", "mandateA1", "versions", "1"))); // never-effective: author may withdraw
    // The module-born shape: root authored WITH its first version.
    await assertSucceeds(
      setDoc(doc(ownerA.firestore(), "sim_mandates", "mandateBorn"), mandateRoot({ mandateId: "mandateBorn", currentVersion: 1, currentVersionRef: "sim_mandates/mandateBorn/versions/1" }))
    );
    await assertSucceeds(
      setDoc(doc(ownerA.firestore(), "sim_mandates", "mandateBorn", "versions", "1"), mandateVersion({ mandateId: "mandateBorn" }))
    );
    // An effective version: only the supersededSeq flip moves, for anyone.
    await env.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(context.firestore(), "sim_mandates", "mandateA1", "versions", "9"),
        mandateVersion({ version: 9, effectiveSeq: 42 })
      );
    });
    await assertFails(
      updateDoc(doc(fabricCommitter.firestore(), "sim_mandates", "mandateA1", "versions", "9"), { scopeFreeform: "Edited." })
    );
    await assertSucceeds(
      updateDoc(doc(fabricCommitter.firestore(), "sim_mandates", "mandateA1", "versions", "9"), { supersededSeq: 77 })
    ); // the undo-restore flip — the one update (P5-D6 governs deletion inside restore, held out above)
    await assertFails(deleteDoc(doc(fabricCommitter.firestore(), "sim_mandates", "mandateA1", "versions", "9"))); // §9.8 exemption
    await assertFails(deleteDoc(doc(ownerA.firestore(), "sim_mandates", "mandateA1", "versions", "9")));
    await assertFails(updateDoc(doc(memberC.firestore(), "sim_mandates", "mandateA1"), { status: "revoked" }));
    await assertSucceeds(updateDoc(doc(fabricCommitter.firestore(), "sim_mandates", "mandateA1"), { status: "revoked", revokedSeq: 80 }));
    await assertSucceeds(deleteDoc(doc(fabricCommitter.firestore(), "sim_mandates", "mandateA1"))); // root: §9.8

    // §9.4 sim_task_envelopes + §9.5 sim_task_outputs
    const envelopeDoc = (over: Record<string, unknown> = {}) => ({
      taskId: "env1",
      requestingMemberId: "ownerA",
      cityId: "cityA",
      npcId: "npcA1",
      mandateId: null,
      sourceSituationId: null,
      task: "Draft the weekly archive digest.",
      bounds: { mayCommit: false, maxRubars: null },
      availableAt: new Date(),
      expiresAt: null,
      claim: null,
      run: null,
      outputId: null,
      logOutcomeSeq: null,
      failure: null,
      status: "QUEUED",
      ...over,
    });
    await assertSucceeds(setDoc(doc(ownerA.firestore(), "sim_task_envelopes", "env1"), envelopeDoc()));
    await assertSucceeds(getDoc(doc(ownerA.firestore(), "sim_task_envelopes", "env1"))); // requester
    await assertSucceeds(getDoc(doc(adminD.firestore(), "sim_task_envelopes", "env1"))); // admin
    await assertFails(getDoc(doc(memberC.firestore(), "sim_task_envelopes", "env1"))); // not the audience
    await assertFails(setDoc(doc(ownerA.firestore(), "sim_task_envelopes", "env2"), envelopeDoc({ taskId: "env2", bounds: { mayCommit: true, maxRubars: null } }))); // mayCommit is false three-deep
    await assertFails(setDoc(doc(ownerA.firestore(), "sim_task_envelopes", "env3"), envelopeDoc({ taskId: "env3", status: "RUNNING" }))); // born QUEUED
    await assertFails(setDoc(doc(ownerA.firestore(), "sim_task_envelopes", "env4"), envelopeDoc({ taskId: "env4", task: "x".repeat(8001) }))); // task cap
    await assertFails(setDoc(doc(ownerA.firestore(), "sim_task_envelopes", "env5"), envelopeDoc({ taskId: "env5", npcId: "npcB1" }))); // another member's NPC
    await assertFails(setDoc(doc(ownerA.firestore(), "sim_task_envelopes", "env6"), envelopeDoc({ taskId: "env6", requestingMemberId: "memberC" }))); // requester == caller
    await assertFails(setDoc(doc(ownerA.firestore(), "sim_task_envelopes", "env7"), envelopeDoc({ taskId: "env7", claim: { workerId: "w" } }))); // born unclaimed
    await assertFails(updateDoc(doc(ownerA.firestore(), "sim_task_envelopes", "env1"), { status: "CLAIMED" }));
    await assertSucceeds(updateDoc(doc(fabricCommitter.firestore(), "sim_task_envelopes", "env1"), { status: "CLAIMED", claim: { workerId: "fabricWkr" } }));
    await assertFails(deleteDoc(doc(ownerA.firestore(), "sim_task_envelopes", "env1")));
    await assertSucceeds(deleteDoc(doc(fabricCommitter.firestore(), "sim_task_envelopes", "env1"))); // §9.8

    await env.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "sim_task_envelopes", "envOut"), envelopeDoc({ taskId: "envOut" }));
      await setDoc(doc(db, "sim_task_outputs", "envOut"), {
        outputId: "envOut", npcId: "npcA1", outcome: "COMPLETED",
        outputText: "Digest drafted.", structuredOutput: null, createdSeq: 5,
      });
    });
    await assertSucceeds(getDoc(doc(ownerA.firestore(), "sim_task_outputs", "envOut"))); // via the envelope join
    await assertFails(getDoc(doc(memberC.firestore(), "sim_task_outputs", "envOut")));
    await assertFails(getDoc(doc(guestG.firestore(), "sim_task_outputs", "envOut")));
    await assertSucceeds(setDoc(doc(fabricCommitter.firestore(), "sim_task_outputs", "envNew"), {
      outputId: "envNew", npcId: "npcA1", outcome: "FAILED",
      outputText: "", structuredOutput: null, createdSeq: 6,
    }));
    await assertFails(setDoc(doc(ownerA.firestore(), "sim_task_outputs", "envForged"), {
      outputId: "envForged", npcId: "npcA1", outcome: "COMPLETED",
      outputText: "Forged.", structuredOutput: null, createdSeq: 7,
    }));
    await assertFails(updateDoc(doc(fabricCommitter.firestore(), "sim_task_outputs", "envOut"), { outputText: "Rewritten." })); // outputs are forever
    await assertFails(deleteDoc(doc(fabricCommitter.firestore(), "sim_task_outputs", "envOut")));

    // §9.6 sim_situations
    await env.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "sim_situations", "sitCity"), {
        situationId: "sitCity", status: "open", kind: "attention",
        audienceCityId: "cityA", recipientUid: null, cityId: "cityA",
        handling: null, dedupeKey: "dk-city", detail: {}, createdSeq: 90,
      });
      await setDoc(doc(db, "sim_situations", "sitPerson"), {
        situationId: "sitPerson", status: "open", kind: "attention",
        audienceCityId: null, recipientUid: "memberC", cityId: "cityA",
        handling: null, dedupeKey: "dk-person", detail: {}, createdSeq: 91,
      });
      await setDoc(doc(db, "sim_situations", "sitClosed"), {
        situationId: "sitClosed", status: "handled", kind: "attention",
        audienceCityId: "cityA", recipientUid: null, cityId: "cityA",
        handling: { mode: "self", decidedByUid: "ownerA" }, dedupeKey: "dk-closed", detail: {}, createdSeq: 92,
      });
    });
    await assertSucceeds(getDoc(doc(ownerA.firestore(), "sim_situations", "sitCity"))); // audience city owner
    await assertFails(getDoc(doc(memberC.firestore(), "sim_situations", "sitCity")));
    await assertSucceeds(getDoc(doc(memberC.firestore(), "sim_situations", "sitPerson"))); // the recipient
    await assertSucceeds(getDoc(doc(adminD.firestore(), "sim_situations", "sitCity")));
    await assertFails(setDoc(doc(ownerA.firestore(), "sim_situations", "sitForged"), { status: "open", audienceCityId: "cityA" })); // fabric mints
    await assertSucceeds(setDoc(doc(fabricCommitter.firestore(), "sim_situations", "sitMinted"), {
      situationId: "sitMinted", status: "open", kind: "attention",
      audienceCityId: "cityA", recipientUid: null, cityId: "cityA",
      handling: null, dedupeKey: "dk-minted", detail: {}, createdSeq: 93,
    }));
    await assertSucceeds(
      updateDoc(doc(ownerA.firestore(), "sim_situations", "sitCity"), {
        handling: { mode: "self", decidedByUid: "ownerA", decidedAtSeq: null, note: null },
        updatedAt: new Date(),
      })
    ); // the handling decision — handling fields only
    await assertFails(
      updateDoc(doc(ownerA.firestore(), "sim_situations", "sitCity"), { summary: "owner edit" })
    ); // nothing outside handling/updatedAt
    await assertFails(
      updateDoc(doc(ownerA.firestore(), "sim_situations", "sitCity"), {
        handling: { mode: "silent", decidedByUid: "memberC", decidedAtSeq: null, note: null },
      })
    ); // decidedByUid is the decider's own
    await assertFails(
      updateDoc(doc(memberC.firestore(), "sim_situations", "sitCity"), {
        handling: { mode: "self", decidedByUid: "memberC", decidedAtSeq: null, note: null },
      })
    ); // not the audience
    await assertFails(
      updateDoc(doc(ownerA.firestore(), "sim_situations", "sitClosed"), {
        handling: { mode: "self", decidedByUid: "ownerA", decidedAtSeq: null, note: null },
      })
    ); // decided situations are closed to decisions
    await assertFails(deleteDoc(doc(ownerA.firestore(), "sim_situations", "sitCity")));
    await assertSucceeds(deleteDoc(doc(fabricCommitter.firestore(), "sim_situations", "sitClosed"))); // §9.8

    // §9.7 sim_delegation_rules + versions — author-private (P5-D4)
    const ruleRoot = (over: Record<string, unknown> = {}) => ({
      ownerUid: "ownerA",
      cityId: "cityA",
      status: "pending",
      version: 0,
      currentVersionRef: null,
      effectiveSeq: null,
      createdSeq: null,
      ...over,
    });
    const ruleVersion = (over: Record<string, unknown> = {}) => ({
      ownerUid: "ownerA",
      cityId: "cityA",
      version: 1,
      match: { kinds: ["situation"], minSeverity: "routine" },
      handler: { mode: "npc-first", npcId: "npcA1", characterId: null, mandateId: null },
      caps: null,
      alwaysWait: false,
      ruleHash: "fixturehash",
      effectiveSeq: null,
      supersededSeq: null,
      ...over,
    });
    await assertSucceeds(setDoc(doc(ownerA.firestore(), "sim_delegation_rules", "ruleA1"), ruleRoot()));
    await assertFails(setDoc(doc(memberC.firestore(), "sim_delegation_rules", "ruleC1"), ruleRoot({ ownerUid: "memberC" }))); // not their city
    await assertFails(setDoc(doc(ownerB.firestore(), "sim_delegation_rules", "ruleB1"), ruleRoot({ ownerUid: "ownerB" }))); // not B's city
    await assertSucceeds(getDoc(doc(ownerA.firestore(), "sim_delegation_rules", "ruleA1"))); // the author
    await assertFails(getDoc(doc(memberC.firestore(), "sim_delegation_rules", "ruleA1"))); // author-private
    await assertSucceeds(
      setDoc(doc(ownerA.firestore(), "sim_delegation_rules", "ruleA1", "versions", "1"), ruleVersion())
    );
    await assertSucceeds(
      updateDoc(doc(fabricCommitter.firestore(), "sim_delegation_rules", "ruleA1"), { version: 1 })
    ); // the fabric advances the pointer when v1 takes effect
    await assertFails(
      setDoc(doc(ownerA.firestore(), "sim_delegation_rules", "ruleA1", "versions", "2"),
        ruleVersion({ version: 2, alwaysWait: true }))
    ); // alwaysWait means the handler IS wait-for-owner
    await assertFails(
      setDoc(doc(ownerA.firestore(), "sim_delegation_rules", "ruleA1", "versions", "2"),
        ruleVersion({ version: 2, handler: { mode: "npc-first", npcId: "npcB1", characterId: null, mandateId: null } }))
    ); // the handler NPC must be the author's own
    await assertFails(
      setDoc(doc(memberC.firestore(), "sim_delegation_rules", "ruleA1", "versions", "2"), ruleVersion({ version: 2, ownerUid: "memberC" }))
    );
    await env.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(context.firestore(), "sim_delegation_rules", "ruleA1", "versions", "9"),
        ruleVersion({ version: 9, effectiveSeq: 42, handler: { mode: "wait-for-owner", npcId: null, characterId: null, mandateId: null } })
      );
    });
    await assertFails(
      updateDoc(doc(fabricCommitter.firestore(), "sim_delegation_rules", "ruleA1", "versions", "9"), { alwaysWait: true })
    );
    await assertSucceeds(
      updateDoc(doc(fabricCommitter.firestore(), "sim_delegation_rules", "ruleA1", "versions", "9"), { supersededSeq: 88 })
    ); // the restore flip, mirrored
    await assertFails(deleteDoc(doc(fabricCommitter.firestore(), "sim_delegation_rules", "ruleA1", "versions", "9"))); // effective: no identity
    await assertFails(updateDoc(doc(memberC.firestore(), "sim_delegation_rules", "ruleA1"), { status: "active" }));
    await assertSucceeds(updateDoc(doc(fabricCommitter.firestore(), "sim_delegation_rules", "ruleA1"), { status: "active", effectiveSeq: 90 }));
    await assertSucceeds(deleteDoc(doc(fabricCommitter.firestore(), "sim_delegation_rules", "ruleA1"))); // root: §9.8
  }
  console.log("ok sim phase 5 substrate postures (P5-G9 matrix, brief §9)");

  await env.cleanup();
  assert.ok(true);
  console.log("rules tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
