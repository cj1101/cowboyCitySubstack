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
  where,
  Timestamp,
  updateDoc,
} from "firebase/firestore";
import { getBytes, listAll, ref, uploadString } from "firebase/storage";

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

  await env.cleanup();
  assert.ok(true);
  console.log("rules tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
