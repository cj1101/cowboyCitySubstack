import assert from "node:assert/strict";
import {
  minecraftAvatarUrl,
  normalizeMinecraftUsername,
  rolesForMember,
} from "../lib/profile/identity";
import { formatFoundingDate, parsePopulation, readCityRecord } from "../lib/cities/record";

assert.equal(minecraftAvatarUrl("Notch"), "https://mc-heads.net/avatar/Notch");
assert.equal(minecraftAvatarUrl("  Steve_1 "), "https://mc-heads.net/avatar/Steve_1");
assert.equal(minecraftAvatarUrl("no"), null);
assert.equal(minecraftAvatarUrl("bad name"), null);
assert.equal(normalizeMinecraftUsername(""), "");
assert.throws(() => normalizeMinecraftUsername("ab"), /3–16/);

assert.deepEqual(rolesForMember({ isAdmin: true, email: "friend@realm.test" }), ["sheriff"]);
assert.deepEqual(rolesForMember({ ownsCity: true, email: "friend@realm.test" }), ["founder"]);
assert.deepEqual(
  rolesForMember({ isAdmin: true, ownsCity: true, email: "charlie@suarezhouse.net" }),
  ["sheriff", "founder", "admin"]
);
assert.deepEqual(rolesForMember({ email: "visitor@realm.test" }), []);

const record = readCityRecord({
  motto: " Cedar ",
  population: 900.8,
  foundedOn: "2019-06-01",
  gallery: ["https://example.com/a.jpg", 4, ""],
});
assert.equal(record.motto, "Cedar");
assert.equal(record.population, 900);
assert.equal(record.foundedOn, "2019-06-01");
assert.deepEqual(record.gallery, ["https://example.com/a.jpg"]);
assert.equal(parsePopulation(""), null);
assert.equal(parsePopulation("1200"), 1200);
assert.throws(() => parsePopulation("-1"), /whole number/);
assert.match(formatFoundingDate("2019-06-01"), /2019/);

console.log("profile tests passed");
