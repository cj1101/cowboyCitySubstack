import assert from "node:assert/strict";
import { asUploadError, isDisplayableImageUrl, UPLOAD_FAILED_MESSAGE } from "../lib/images";

assert.equal(isDisplayableImageUrl("/realm-map.jpg"), true);
assert.equal(
  isDisplayableImageUrl("https://firebasestorage.googleapis.com/v0/b/cowboycityrealm.firebasestorage.app/o/realm%2Foverview.jpg?alt=media"),
  true
);
assert.equal(
  isDisplayableImageUrl("https://cowboycityrealm.firebasestorage.app/o/posts%2Fa.jpg?alt=media&token=abc"),
  true
);
assert.equal(isDisplayableImageUrl("https://storage.googleapis.com/cowboycityrealm.firebasestorage.app/posts/a.jpg"), true);
assert.equal(isDisplayableImageUrl("https://evil.example/cowboycityrealm.firebasestorage.app/a.jpg"), false);
assert.equal(isDisplayableImageUrl("http://cowboycityrealm.firebasestorage.app/a.jpg"), false);
assert.equal(isDisplayableImageUrl(""), false);

assert.equal(asUploadError(new Error("Firebase Storage: permission denied")).message, UPLOAD_FAILED_MESSAGE);
assert.equal(asUploadError(new Error("Images must be under 12 MB before upload.")).message, "Images must be under 12 MB before upload.");
assert.equal(isDisplayableImageUrl("http://127.0.0.1:9199/v0/b/cowboycityrealm.firebasestorage.app/o/factions%2Fa%2Fmap.jpg?alt=media&token=abc"), true);

console.log("image url tests passed");
