import assert from "node:assert/strict";
import { imageNorm } from "../lib/maps/gestures";
import { fitMapToWidth } from "../lib/maps/territory";
import { isPermissionError, retryOnceOnPermission } from "../lib/async";

const centered = imageNorm({ clientX: 520, clientY: 260, left: 120, top: 40, width: 800, height: 800 });
assert.ok(centered);
assert.equal(centered.nx, 0.5);
assert.equal(centered.ny, 220 / 800);

const gutter = imageNorm({ clientX: 40, clientY: 260, left: 120, top: 40, width: 800, height: 800 });
assert.equal(gutter, null);

const edge = imageNorm({ clientX: 120, clientY: 40, left: 120, top: 40, width: 800, height: 800 });
assert.ok(edge);
assert.equal(edge.nx, 0);
assert.equal(edge.ny, 0);

const wide = fitMapToWidth(1440, 1254, 1254);
assert.ok(wide);
assert.equal(wide.w, 1440);
assert.ok(Math.abs(wide.h - 1440) < 0.001);
assert.ok(wide.w / 1440 > 0.95);

assert.equal(fitMapToWidth(0, 100, 100), null);

assert.equal(isPermissionError(Object.assign(new Error("Missing or insufficient permissions."), { code: "permission-denied" })), true);
assert.equal(isPermissionError(new Error("That treaty is not available.")), false);

async function main() {
  let attempts = 0;
  const recovered = await retryOnceOnPermission(async () => {
    attempts += 1;
    if (attempts === 1) {
      throw Object.assign(new Error("Missing or insufficient permissions."), { code: "permission-denied" });
    }
    return "treaty";
  }, 0);
  assert.equal(recovered, "treaty");
  assert.equal(attempts, 2);

  await assert.rejects(
    retryOnceOnPermission(async () => {
      throw new Error("That treaty is not available.");
    }, 0),
    /not available/
  );

  console.log("ui quirk tests passed");
}

main();
