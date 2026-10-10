import assert from "node:assert/strict";
import { realmPinFields, pinCategoryOf } from "../lib/maps/pins";
import { cleanPoints, frameView } from "../lib/maps/territory";

assert.equal(pinCategoryOf(undefined), "other");
assert.equal(pinCategoryOf("capital"), "capital");
assert.equal(pinCategoryOf("castle"), "other");

const cleaned = cleanPoints([
  { nx: -0.2, ny: 0.4 },
  { nx: Number.NaN, ny: 0.2 },
  { nx: 1.4, ny: 0.8 },
]);
assert.deepEqual(cleaned, [
  { nx: 0, ny: 0.4 },
  { nx: 1, ny: 0.8 },
]);

const framed = frameView({
  points: [{ nx: 0.5, ny: 0.5 }],
  frameW: 400,
  frameH: 300,
  imageW: 200,
  imageH: 100,
  maxScale: 4,
  padding: 48,
  minSpan: 0.12,
});
assert.equal(framed.scale, 4);
assert.equal(framed.panX, 200 - 0.5 * 200 * 4);
assert.equal(framed.panY, 150 - 0.5 * 100 * 4);

const wide = frameView({
  points: [
    { nx: 0.1, ny: 0.2 },
    { nx: 0.7, ny: 0.2 },
    { nx: 0.4, ny: 0.8 },
  ],
  frameW: 800,
  frameH: 600,
  imageW: 400,
  imageH: 300,
  maxScale: 6,
  padding: 40,
  minSpan: 0.12,
});
assert.ok(wide.scale >= 1 && wide.scale <= 6);
assert.ok(Number.isFinite(wide.panX) && Number.isFinite(wide.panY));

const fields = realmPinFields({
  title: "  Keep  ",
  nx: 0.2,
  ny: 1.4,
  category: "capital",
  note: "Harbor",
  cityId: "city1",
  wikiEntryIds: [],
  wikiEntryId: null,
  postId: null,
  x: null,
  z: null,
});
assert.equal(fields.title, "Keep");
assert.equal(fields.ny, 1);
assert.equal(fields.category, "capital");
assert.equal("createdAt" in fields, false);

const moved = realmPinFields({ nx: 0.33, ny: 0.44 });
assert.deepEqual(moved, { nx: 0.33, ny: 0.44 });

assert.throws(() => realmPinFields({ title: "   " }), /title/i);
assert.throws(() => realmPinFields({ nx: Number.NaN }), /off the map/i);
assert.throws(() => realmPinFields({ category: "castle" as "capital" }), /category/i);

console.log("territory tests passed");
