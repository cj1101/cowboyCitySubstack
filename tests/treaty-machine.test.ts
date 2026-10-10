import assert from "node:assert/strict";
import {
  acceptTreaty,
  canReadTreaty,
  counterTreaty,
  declineTreaty,
  proposeTreaty,
  ratifiedCityIds,
  treatyStatus,
  withdrawTreaty,
} from "../lib/treaties/machine";

const draft = {
  name: "Harbor Accord",
  type: "trade" as const,
  nature: "Open docks to member keels.",
  terms: "No tariff on timber.",
  purpose: "Keep the cedar trade moving.",
  open: false,
  inviteeCityIds: ["evan", "cowboy"],
  proposerCityId: "cascadia",
};

const proposed = proposeTreaty(draft);

assert.deepEqual(ratifiedCityIds(proposed), ["cascadia"]);
assert.equal(treatyStatus(proposed), "pending");
assert.equal(
  canReadTreaty(proposed, { ownedCityIds: ["evan"] }),
  true
);
assert.equal(
  canReadTreaty(proposed, { ownedCityIds: ["outsider"] }),
  false
);
assert.equal(canReadTreaty(proposed, { isAdmin: true, ownedCityIds: [] }), true);
assert.equal(canReadTreaty(proposed, { ownedCityIds: [] }), false);

assert.throws(() => acceptTreaty(proposed, "outsider"), /cannot ratify/);

const bilateral = acceptTreaty(proposed, "evan");
assert.equal(treatyStatus(bilateral), "active");
assert.deepEqual(ratifiedCityIds(bilateral).sort(), ["cascadia", "evan"]);
assert.equal(canReadTreaty(bilateral, { ownedCityIds: [] }), true);

const declined = declineTreaty(proposed, "cowboy");
assert.equal(treatyStatus(declined), "pending");
assert.deepEqual(ratifiedCityIds(declined), ["cascadia"]);

const countered = counterTreaty(bilateral, "evan", {
  note: "Add a grain clause.",
  terms: "No tariff on timber or grain.",
});
assert.equal(treatyStatus(countered), "pending");
assert.deepEqual(ratifiedCityIds(countered), ["evan"]);
assert.equal(countered.revisions.length, 2);
assert.equal(countered.revisions[0].terms, "No tariff on timber.");
assert.equal(canReadTreaty(countered, { ownedCityIds: ["cascadia"] }), true);
assert.equal(canReadTreaty(countered, { ownedCityIds: ["outsider"] }), false);

const reratified = acceptTreaty(countered, "cascadia");
assert.equal(treatyStatus(reratified), "active");
assert.deepEqual(ratifiedCityIds(reratified).sort(), ["cascadia", "evan"]);

const oneLeft = withdrawTreaty(reratified, "cascadia");
assert.equal(treatyStatus(oneLeft), "pending");
assert.deepEqual(ratifiedCityIds(oneLeft), ["evan"]);
assert.equal(canReadTreaty(oneLeft, { ownedCityIds: [] }), false);
assert.throws(() => withdrawTreaty(oneLeft, "cascadia"), /ratified this revision/);

const three = acceptTreaty(acceptTreaty(proposed, "evan"), "cowboy");
assert.equal(treatyStatus(three), "active");
const stillActive = withdrawTreaty(three, "cowboy");
assert.equal(treatyStatus(stillActive), "active");
assert.deepEqual(ratifiedCityIds(stillActive).sort(), ["cascadia", "evan"]);

const open = proposeTreaty({
  ...draft,
  name: "Open League",
  open: true,
  inviteeCityIds: [],
});
assert.equal(treatyStatus(open), "pending");
assert.equal(canReadTreaty(open, { ownedCityIds: ["anywhere"] }), true);
assert.equal(canReadTreaty(open, { ownedCityIds: [] }), false);
const joined = acceptTreaty(open, "anywhere");
assert.equal(treatyStatus(joined), "active");
assert.equal(canReadTreaty(open, { ownedCityIds: [] }), false);

assert.throws(() => proposeTreaty({ ...draft, inviteeCityIds: [], open: false }), /Invite at least/);
assert.throws(() => counterTreaty(proposed, "evan", { note: "   " }), /requested changes/);
assert.throws(() => declineTreaty(proposed, "cascadia"), /Withdraw instead/);

console.log("treaty machine tests passed");
