import assert from "node:assert/strict";
import { asUploadError, firebaseStorageCode, isDisplayableImageUrl, UPLOAD_FAILED_MESSAGE } from "../lib/images";

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

const denied = Object.assign(new Error("Firebase Storage: User does not have permission to access 'posts/p/a.jpg'. (storage/unauthorized)"), {
  code: "storage/unauthorized",
});
assert.equal(firebaseStorageCode(denied), "storage/unauthorized");
assert.equal(asUploadError(denied).message, "Upload failed (storage/unauthorized). The image was not stored.");
assert.equal(asUploadError(new Error("Images must be under 12 MB before upload.")).message, "Images must be under 12 MB before upload.");
assert.equal(asUploadError(new Error("Could not read that video.")).message, "Could not read that video.");
assert.equal(asUploadError(new Error("boom")).message, "boom");
assert.equal(UPLOAD_FAILED_MESSAGE.includes("Upload failed"), true);
assert.equal(isDisplayableImageUrl("http://127.0.0.1:9199/v0/b/cowboycityrealm.firebasestorage.app/o/factions%2Fa%2Fmap.jpg?alt=media&token=abc"), true);

console.log("image url tests passed");
