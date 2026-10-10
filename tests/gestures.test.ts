import assert from "node:assert/strict";
import { pinchView, popupPosition } from "../lib/maps/gestures";

const zoomed = pinchView({
  startScale: 1,
  startPanX: 10,
  startPanY: 20,
  originX: 100,
  originY: 80,
  ratio: 2,
});
assert.equal(zoomed.scale, 2);
assert.equal(zoomed.panX, 100 - (100 - 10) * 2);
assert.equal(zoomed.panY, 80 - (80 - 20) * 2);

const capped = pinchView({
  startScale: 4,
  startPanX: 0,
  startPanY: 0,
  originX: 0,
  originY: 0,
  ratio: 3,
  maxScale: 6,
});
assert.equal(capped.scale, 6);

const fitted = popupPosition({
  x: 300,
  y: 500,
  frameW: 390,
  frameH: 700,
  popupW: 288,
  popupH: 240,
});
assert.ok(fitted.x + fitted.width <= 390);
assert.ok(fitted.y + fitted.height <= 700);
assert.ok(fitted.x >= 8);

console.log("gesture tests passed");
