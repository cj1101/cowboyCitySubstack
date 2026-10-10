import assert from "node:assert/strict";
import {
  acceptTreaty,
  breakTreaty,
  canReadTreaty,
  counterTreaty,
  declineTreaty,
  expiryBadge,
  proposeTreaty,
  ratifiedCityIds,
  renewTreaty,
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

const storedCounter = {
  ...countered,
  responses: countered.responses.map((response) =>
    response.cityId === "evan" && response.revision === 2
      ? { ...response, decision: "counter" as const }
      : response
  ),
};
assert.deepEqual(ratifiedCityIds(storedCounter), ["evan"]);

const day = new Date(Date.UTC(2026, 9, 10));
assert.equal(expiryBadge("2026-10-10", day), "expiring");
assert.equal(expiryBadge("2026-10-24", day), "expiring");
assert.equal(expiryBadge("2026-10-25", day), null);
assert.equal(expiryBadge("2026-10-09", day), "expired");
assert.equal(expiryBadge("", day), null);
assert.equal(expiryBadge("2026-02-31", day), null);

const renewed = renewTreaty(bilateral, "evan", {
  note: "Another season on the docks.",
  expiresOn: "2027-04-01",
  renewOn: "2027-03-01",
});
assert.equal(treatyStatus(renewed), "pending");
assert.deepEqual(ratifiedCityIds(renewed), ["evan"]);
assert.equal(renewed.revisions.at(-1)?.kind, "renewal");
assert.equal(renewed.revisions.at(-1)?.expiresOn, "2027-04-01");
assert.equal(canReadTreaty(renewed, { ownedCityIds: [] }), false);
const renewedAgain = acceptTreaty(renewed, "cascadia");
assert.equal(treatyStatus(renewedAgain), "active");
assert.throws(() => renewTreaty(proposed, "cascadia", { note: "Too soon", expiresOn: "2027-01-01" }), /active treaty/);
assert.throws(() => renewTreaty(bilateral, "evan", { note: "Dates", expiresOn: "March" }), /YYYY-MM-DD/);

const broken = breakTreaty(bilateral, "evan", "The tariff came back.");
assert.equal(treatyStatus(broken), "broken");
assert.deepEqual(ratifiedCityIds(broken), ["cascadia"]);
assert.equal(canReadTreaty(broken, { ownedCityIds: [] }), true);
assert.throws(() => acceptTreaty(broken, "cowboy"), /broken/);
assert.throws(() => breakTreaty(broken, "cascadia", "Again"), /active treaty/);
assert.throws(() => breakTreaty(bilateral, "outsider", "No"), /member/);

const threeWay = acceptTreaty(acceptTreaty(proposed, "evan"), "cowboy");
const partialBreak = breakTreaty(threeWay, "cowboy", "Leaving the league.");
assert.equal(treatyStatus(partialBreak), "active");
assert.deepEqual(ratifiedCityIds(partialBreak).sort(), ["cascadia", "evan"]);
assert.equal(canReadTreaty(partialBreak, { ownedCityIds: [] }), true);

console.log("treaty machine tests passed");
