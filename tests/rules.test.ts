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
    // Publications fixture for the read-surface checks (P1-G5).
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

  const genesisResult = await runGenesis(adminDb, {});
  assert.equal(genesisResult.status, "created");
  assert.equal((await ensureSimCity(adminDb, "cityA")).status, "created");
  assert.equal((await ensureSimCity(adminDb, "cityB")).status, "created");
  assert.equal((await ensureSimCity(adminDb, "cityU")).status, "unclaimed");

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

  const validEntry = {
    seq: 2,
    resolutionSeq: 2,
    resolutionId: "test-resolution",
    entryIndexWithinResolution: 0,
    kind: "action-summary",
    resolvedAt: "2026-10-17T00:00:00.000Z",
    rulesVersion: "sim-rules-0.1.0-phase1",
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
    prevHash: "a".repeat(64),
    entryHash: "b".repeat(64),
    hashVersion: "cowboy-canonical-json-v1",
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
    // Create-only records: update/delete denied for EVERY identity,
    // committer and admin included; delete denied on any sim doc.
    await assertFails(
      updateDoc(doc(committerFs, "sim_log_entries", logEntryDocId(2)), { major: true })
    );
    await assertFails(deleteDoc(doc(committerFs, "sim_log_entries", logEntryDocId(2))));
    await assertFails(deleteDoc(doc(adminD.firestore(), "sim_log_entries", logEntryDocId(2))));
    await assertFails(
      updateDoc(doc(committerFs, "sim_resolutions", "test-resolution"), { x: 1 })
    );
    await assertFails(deleteDoc(doc(committerFs, "sim_resolutions", "test-resolution")));
    await assertFails(
      updateDoc(doc(ownerA.firestore(), "sim_publications", "pubMembers"), { status: "retracted" })
    );
    await assertFails(deleteDoc(doc(committerFs, "sim_publications", "pubMembers")));
    await assertFails(
      updateDoc(doc(committerFs, "sim_intel_records", "intel1"), { coverage: {} })
    );
    await assertFails(deleteDoc(doc(committerFs, "sim_cities", "cityA")));
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
    await assertSucceeds(getDoc(doc(memberC.firestore(), "sim_resolutions", "test-resolution")));
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

  await env.cleanup();
  assert.ok(true);
  console.log("rules tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
