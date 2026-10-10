import assert from "node:assert/strict";
import { matchesQuery, queryProbe, searchTokensFrom } from "../lib/search/tokens";

const tokens = searchTokensFrom({
  title: "Harbor Accord",
  body: "No tariff on cedar.",
});

assert.ok(tokens.includes("harbor"));
assert.ok(tokens.includes("har"));
assert.ok(tokens.includes("accord"));
assert.ok(tokens.includes("cedar"));
assert.equal(tokens.includes("ha"), false);
assert.equal(queryProbe("har"), "har");
assert.equal(queryProbe("harbor lights"), "harbor");
assert.equal(queryProbe("a"), null);
assert.equal(matchesQuery("harbor cedar", "Harbor Accord. No tariff on cedar.", tokens), true);
assert.equal(matchesQuery("harbor grain", "Harbor Accord. No tariff on cedar.", tokens), false);
assert.equal(matchesQuery("har", "Harbor Accord", tokens), true);
assert.deepEqual(searchTokensFrom({ title: "A", body: "I" }), ["z"]);

console.log("search token tests passed");