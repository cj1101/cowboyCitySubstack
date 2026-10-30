/**
 * P3-FIX — the Phase 3 fixture world, as ONE shared definition.
 *
 * Provenance: the Phase 3 gate (qa-phase3-executable-gate.md §3) defines
 * fixture world P3-FIX and planned its seeding inside a dashboard-core
 * suite that was never landed under that name. The pieces that exist in
 * code grew up inline in `tests/sim-core.test.ts`'s setup (the ownerB /
 * memberC user docs, the cityB faction + membership docs, cityB's stat
 * overrides — Phase 1/2 seeding, reused here exactly as the gate's
 * ordering prescribes: genesis → lazy creation → fixture state). This
 * module is now the single source of truth for those shared pieces:
 * sim-core imports them from here, and `scripts/seed-p3fix.ts` seeds the
 * full C4 world from here. Nothing may fork these literals.
 *
 * The world this module defines is the subset of P3-FIX that the
 * P3-G1-C4 capture sitting exercises (workstreams/
 * a9-p3g1c4-preview-evidence-pack.md §3): identities ownerB + memberC;
 * cityB (ownerB, sim state present) and citySparse (memberC-claimed, one
 * wiki entry, template sim state); in cityB, one structure in each state
 * — in-function, damaged, planned — one pin by ownerB, and the planned
 * structure's plan-kind gallery image (gate §3 content substrate,
 * carried onto cityB because C4 names cityB/citySparse, not cityA).
 * The rest of gate §3 (cityA's resolutions, publications, the undo
 * target) is dispatcher-tier scenario state for CI checks, not capture
 * substrate, and is deliberately NOT seeded here.
 *
 * Two fixture-posture notes, recorded so nobody has to re-derive them:
 *  - The damaged structure's condition is 0. `PUBLISHED_DAMAGE_THRESHOLD`
 *    is null as landed (lib/entity/functionState.ts), so condition 0 is
 *    the only record that derives out-of-function-damaged under the
 *    shipped posture — the record speaking, not a threshold. (Gate §3's
 *    "damaging Log entry" is a resolution-tier artifact; the C4 captures
 *    never open the damaged page, so no Log entry is fabricated for it.)
 *  - The plan gallery image points at the shipped public asset
 *    `/realm-map.jpg` — the only displayable raster in the repo — with a
 *    caption that says it is a fixture stand-in. The capture checks the
 *    plan-kind framing (P3-G11 posture), not the drawing.
 */

import type { Auth as AdminAuth } from "firebase-admin/auth";
import {
  Timestamp,
  type Firestore as AdminFirestore,
} from "firebase-admin/firestore";
import { ensureSimCity } from "../ensureSimCity";
import { projectFirestoreValue, runGenesis } from "../genesis";
import {
  fetchSnapshotInputs,
  projectSnapshot,
  type SnapshotSource,
} from "../snapshot";
import { logEntryDocId } from "../template";

// ---------------------------------------------------------------------------
// Identities (user docs byte-identical to the sim-core suite's seeds)
// ---------------------------------------------------------------------------

export interface P3FixUser {
  uid: string;
  email: string;
  /** Emulator-Auth-only fixture password. Never a real credential. */
  password: string;
  userDoc: { email: string; status: string; isAdmin: boolean };
}

export const P3FIX_OWNER_B: P3FixUser = {
  uid: "ownerB",
  email: "b@realm.test",
  password: "fixture-ownerB",
  userDoc: { email: "b@realm.test", status: "approved", isAdmin: false },
};

export const P3FIX_MEMBER_C: P3FixUser = {
  uid: "memberC",
  email: "c@realm.test",
  password: "fixture-memberC",
  userDoc: { email: "c@realm.test", status: "approved", isAdmin: false },
};

export const P3FIX_USERS: readonly P3FixUser[] = [P3FIX_OWNER_B, P3FIX_MEMBER_C];

// ---------------------------------------------------------------------------
// Factions + membership (cityB docs byte-identical to the sim-core seeds)
// ---------------------------------------------------------------------------

export interface P3FixCity {
  factionId: string;
  factionDoc: { name: string; slug: string; ownerUids: string[] };
  membershipDocId: string;
  membershipDoc: { uid: string; factionId: string; role: string };
}

export const P3FIX_CITY_B: P3FixCity = {
  factionId: "cityB",
  factionDoc: { name: "Fixture City B", slug: "fixture-b", ownerUids: ["ownerB"] },
  membershipDocId: "ownerB_cityB",
  membershipDoc: { uid: "ownerB", factionId: "cityB", role: "owner" },
};

export const P3FIX_CITY_SPARSE: P3FixCity = {
  factionId: "citySparse",
  factionDoc: {
    name: "Fixture City Sparse",
    slug: "fixture-sparse",
    ownerUids: ["memberC"],
  },
  membershipDocId: "memberC_citySparse",
  membershipDoc: { uid: "memberC", factionId: "citySparse", role: "owner" },
};

export const P3FIX_CITIES: readonly P3FixCity[] = [P3FIX_CITY_B, P3FIX_CITY_SPARSE];

/**
 * cityB's initial-condition stat overrides, applied over the even-start
 * template exactly as the sim-core suite applies them (treasury,
 * infrastructure band, population). citySparse deliberately gets NO
 * overrides: template state with its null stocks is the sparse posture
 * (pre-allocation figures render with no why-link — P3-G6-C2).
 */
export const P3FIX_CITY_B_STAT_OVERRIDES: Readonly<Record<string, number>> = {
  treasuryRubars: 500_000,
  infrastructure: 80,
  population: 800,
};

// ---------------------------------------------------------------------------
// Content substrate — cityB structures, pin, gallery; citySparse wiki
// ---------------------------------------------------------------------------

/** The engine's own record base (tests/cat1-harness.ts `seedStructure`). */
function structureDoc(over: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 2,
    cityId: "cityB",
    workUnitsDone: 0,
    paidRubars: 0,
    residentHouseholdIds: [],
    staffFigureIds: [],
    staffCorporationIds: [],
    stateVersion: 1,
    lastChangedSeq: null,
    lastResolutionId: null,
    ...over,
  };
}

export const P3FIX_CITY_B_STRUCTURES: readonly {
  id: string;
  doc: Record<string, unknown>;
}[] = [
  {
    id: "exchange-hall",
    doc: structureDoc({
      name: "Exchange Hall",
      slug: "exchange-hall",
      kind: "commercial",
      status: "complete",
      sizeClass: "standard",
      condition: 90,
      units: null,
      totalBudgetRubars: 25_000,
      workUnitsRequired: 10,
      workUnitsDone: 10,
      paidRubars: 25_000,
      linkedPinId: "pin-exchange-hall",
      linkedWikiEntryId: null,
      profile: {
        function: { statement: "Market hall and exchange floor", tags: ["trade"] },
        supports: ["influence"],
        prestige: 4,
      },
    }),
  },
  {
    id: "old-granary",
    doc: structureDoc({
      name: "Old Granary",
      slug: "old-granary",
      kind: "industrial",
      status: "complete",
      sizeClass: "standard",
      // Condition 0 — see the header note on the damaged posture.
      condition: 0,
      units: null,
      totalBudgetRubars: 12_000,
      workUnitsRequired: 8,
      workUnitsDone: 8,
      paidRubars: 12_000,
      linkedPinId: null,
      linkedWikiEntryId: null,
      profile: {
        function: { statement: "Grain store for the fixture harvest", tags: ["storage"] },
        supports: ["infrastructure"],
        prestige: 1,
      },
    }),
  },
  {
    id: "north-library",
    doc: structureDoc({
      name: "North Library",
      slug: "north-library",
      kind: "civic",
      status: "planned",
      sizeClass: "standard",
      condition: null,
      units: null,
      totalBudgetRubars: 10_000,
      linkedPinId: null,
      linkedWikiEntryId: null,
      profile: {
        function: { statement: "City library and archive", tags: ["archive"] },
        supports: ["culture"],
        prestige: 5,
      },
    }),
  },
];

/** ownerB's pin in cityB (factions/{id}/pins — the city-map surface). */
export const P3FIX_CITY_B_PIN: { id: string; doc: Record<string, unknown> } = {
  id: "pin-exchange-hall",
  doc: {
    title: "Exchange Hall",
    nx: 0.42,
    ny: 0.58,
    category: "landmark",
    cityId: "cityB",
    note: "P3-FIX fixture pin, placed by ownerB.",
  },
};

/** The planned structure's plan-kind gallery image (factions/{id}/entity_gallery). */
export const P3FIX_NORTH_LIBRARY_PLAN_IMAGE: {
  id: string;
  doc: Record<string, unknown>;
} = {
  id: "gallery-north-library-plan",
  doc: {
    entityKind: "building",
    entityKey: "north-library",
    url: "/realm-map.jpg",
    storagePath: "factions/cityB/structures/north-library/plan.jpg",
    uploaderUid: "ownerB",
    uploaderDisplay: null,
    caption: "Fixture plan drawing for the North Library (stand-in asset — fixture world only).",
    kind: "plan",
    acceptance: "accepted",
    showcase: false,
    // ISO string in the definition; seedP3Fix stores an admin Timestamp.
    createdAt: "2026-10-19T00:00:00.000Z",
  },
};

/** citySparse's single wiki entry (wiki/{id}/wiki_sections — the sheet's wiki tab). */
export const P3FIX_CITY_SPARSE_WIKI_SECTION: {
  id: string;
  doc: Record<string, unknown>;
} = {
  id: "overview",
  doc: {
    title: "Overview",
    body: "Fixture City Sparse keeps a single wiki entry: a corpus-sparse fixture city with minimal lore, seeded for the P3-G1 parity evidence (fixture world P3-FIX).",
    order: 0,
    factionId: "citySparse",
    // ISO string in the definition; seedP3Fix stores an admin Timestamp.
    updatedAt: "2026-10-19T00:00:00.000Z",
  },
};

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

export interface P3FixSeedReport {
  genesis: string;
  simCities: Record<string, string>;
  structures: string[];
  pinId: string;
  wikiSectionId: string;
  snapshotAsOfSeq: number;
}

function plain(data: Record<string, unknown>): Record<string, unknown> {
  return projectFirestoreValue(data) as Record<string, unknown>;
}

/** The admin SnapshotSource — the same adapter scripts/sim-rebuild-snapshot.ts builds. */
function adminSnapshotSource(db: AdminFirestore): SnapshotSource {
  return {
    async getWorld() {
      const snap = await db.collection("sim_world").doc("current").get();
      return snap.exists ? plain(snap.data() ?? {}) : null;
    },
    async getCounters() {
      const snap = await db.collection("sim_counters").doc("log").get();
      return snap.exists ? plain(snap.data() ?? {}) : null;
    },
    async listFactions() {
      const snap = await db.collection("factions").get();
      return snap.docs.map((d) => ({ id: d.id, data: plain(d.data()) }));
    },
    async listSimCities() {
      const snap = await db.collection("sim_cities").get();
      return snap.docs.map((d) => ({ id: d.id, data: plain(d.data()) }));
    },
    async getLogEntry(seq: number) {
      const snap = await db.collection("sim_log_entries").doc(logEntryDocId(seq)).get();
      return snap.exists ? plain(snap.data() ?? {}) : null;
    },
    async listRecentEntries(limit: number) {
      const snap = await db
        .collection("sim_log_entries")
        .orderBy("seq", "desc")
        .limit(limit)
        .get();
      return snap.docs.map((d) => plain(d.data()));
    },
    async getCityHeadlineEntry(factionId: string) {
      const snap = await db
        .collection("sim_log_entries")
        .where("cityIds", "array-contains", factionId)
        .where("visibility", "==", "public")
        .orderBy("seq", "desc")
        .limit(1)
        .get();
      return snap.empty ? null : plain(snap.docs[0].data());
    },
  };
}

async function convergeAuthUser(auth: AdminAuth, user: P3FixUser): Promise<void> {
  try {
    await auth.getUser(user.uid);
    await auth.updateUser(user.uid, {
      email: user.email,
      password: user.password,
      emailVerified: true,
    });
  } catch {
    await auth.createUser({
      uid: user.uid,
      email: user.email,
      password: user.password,
      emailVerified: true,
    });
  }
}

/**
 * Seed the P3-FIX capture world into an emulator-backed project, in the
 * gate's order: identities + factions → genesis → lazy sim creation →
 * fixture state → content substrate → dashboard snapshot rebuild.
 *
 * Idempotency posture: convergent re-seed. Every write is a deterministic
 * setDoc (or the engine's own no-op-on-repeat lazy creation / genesis),
 * and Auth users are updated to the fixture credentials — re-running
 * lands the identical world and deletes nothing. The posture is safe
 * because the tool is emulator-only and genesis itself refuses a
 * non-pristine sim world; the final verification below additionally
 * fails loud if the emulator carries sim cities beyond the fixture two,
 * rather than blessing a mixed world.
 */
export async function seedP3Fix(
  db: AdminFirestore,
  auth: AdminAuth
): Promise<P3FixSeedReport> {
  // Identities: Auth users (for sign-in) + users/{uid} profile docs.
  for (const user of P3FIX_USERS) {
    await convergeAuthUser(auth, user);
    await db.collection("users").doc(user.uid).set(user.userDoc);
  }

  // Factions + ownership rows (lazy creation's ownership evidence).
  for (const city of P3FIX_CITIES) {
    await db.collection("factions").doc(city.factionId).set(city.factionDoc);
    await db
      .collection("faction_members")
      .doc(city.membershipDocId)
      .set(city.membershipDoc);
  }

  // Genesis (idempotent: an existing genesis is reported, not remade),
  // then lazy sim creation per claimed city (also idempotent).
  const genesis = await runGenesis(db, {});
  const simCities: Record<string, string> = {};
  for (const city of P3FIX_CITIES) {
    const result = await ensureSimCity(db, city.factionId);
    if (result.status !== "created" && result.status !== "already-exists") {
      throw new Error(
        `P3-FIX seed: ensureSimCity(${city.factionId}) returned ${result.status} — expected a claimed faction.`
      );
    }
    simCities[city.factionId] = result.status;
  }

  // cityB's initial conditions, read-merge-set over the template doc,
  // exactly as the sim-core suite applies them.
  const cityBRef = db.collection("sim_cities").doc(P3FIX_CITY_B.factionId);
  const cityBSnap = await cityBRef.get();
  const cityB = cityBSnap.data() as Record<string, unknown>;
  await cityBRef.set({
    ...cityB,
    stats: {
      ...(cityB.stats as Record<string, unknown>),
      ...P3FIX_CITY_B_STAT_OVERRIDES,
    },
  });

  // Content substrate.
  for (const structure of P3FIX_CITY_B_STRUCTURES) {
    await cityBRef.collection("structures").doc(structure.id).set(structure.doc);
  }
  await db
    .collection("factions")
    .doc(P3FIX_CITY_B.factionId)
    .collection("pins")
    .doc(P3FIX_CITY_B_PIN.id)
    .set(P3FIX_CITY_B_PIN.doc);
  await db
    .collection("factions")
    .doc(P3FIX_CITY_B.factionId)
    .collection("entity_gallery")
    .doc(P3FIX_NORTH_LIBRARY_PLAN_IMAGE.id)
    .set({
      ...P3FIX_NORTH_LIBRARY_PLAN_IMAGE.doc,
      createdAt: Timestamp.fromDate(
        new Date(P3FIX_NORTH_LIBRARY_PLAN_IMAGE.doc.createdAt as string)
      ),
    });
  await db
    .collection("wiki")
    .doc(P3FIX_CITY_SPARSE.factionId)
    .collection("wiki_sections")
    .doc(P3FIX_CITY_SPARSE_WIKI_SECTION.id)
    .set({
      ...P3FIX_CITY_SPARSE_WIKI_SECTION.doc,
      updatedAt: Timestamp.fromDate(
        new Date(P3FIX_CITY_SPARSE_WIKI_SECTION.doc.updatedAt as string)
      ),
    });

  // Dashboard snapshot: the ops rebuild path (a cache repair — writes no
  // Log entry), so the dashboard's first render carries the fixture world.
  const inputs = await fetchSnapshotInputs(adminSnapshotSource(db));
  const snapshot = projectSnapshot({ ...inputs, now: new Date() });
  await db.collection("sim_dashboard_snapshots").doc("current").set(snapshot);

  // Verification: the world is exactly the fixture world.
  const simCityIds = (await db.collection("sim_cities").get()).docs
    .map((d) => d.id)
    .sort();
  const expectedIds = P3FIX_CITIES.map((c) => c.factionId).sort();
  if (JSON.stringify(simCityIds) !== JSON.stringify(expectedIds)) {
    throw new Error(
      `P3-FIX seed: sim_cities holds [${simCityIds.join(", ")}], expected exactly [${expectedIds.join(", ")}]. ` +
        "This tool converges only its own fixture world — run it against a fresh emulator."
    );
  }
  const structureIds = (await cityBRef.collection("structures").get()).docs
    .map((d) => d.id)
    .sort();
  const expectedStructures = P3FIX_CITY_B_STRUCTURES.map((s) => s.id).sort();
  if (JSON.stringify(structureIds) !== JSON.stringify(expectedStructures)) {
    throw new Error(
      `P3-FIX seed: cityB structures hold [${structureIds.join(", ")}], expected exactly [${expectedStructures.join(", ")}].`
    );
  }

  return {
    genesis: genesis.status,
    simCities,
    structures: structureIds,
    pinId: P3FIX_CITY_B_PIN.id,
    wikiSectionId: P3FIX_CITY_SPARSE_WIKI_SECTION.id,
    snapshotAsOfSeq: snapshot.asOfSeq as number,
  };
}
