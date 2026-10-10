/** Firebase Storage download hosts the site is allowed to render, plus the local emulator. */
const REMOTE_IMAGE_HOST =
  /^(?:https:\/\/(?:firebasestorage\.googleapis\.com|storage\.googleapis\.com|[a-z0-9-]+\.firebasestorage\.app|[a-z0-9-]+\.appspot\.com)|https?:\/\/(?:127\.0\.0\.1|localhost):9199)\//i;

export const UPLOAD_FAILED_MESSAGE =
  "Upload failed. The image was not stored.";

/** Firebase Storage errors carry a code such as storage/unauthorized. */
export function firebaseStorageCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code?: unknown }).code || "");
    if (code.startsWith("storage/")) return code;
  }
  if (error instanceof Error) {
    const match = error.message.match(/\(storage\/[a-z0-9-]+\)/);
    if (match) return match[0].slice(1, -1);
  }
  return null;
}

export function isDisplayableImageUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  if (url.startsWith("blob:")) return true;
  if (url.startsWith("/") && !url.startsWith("//")) return true;
  return REMOTE_IMAGE_HOST.test(url);
}

/** Keep validation errors. Storage failures keep the Firebase code, such as storage/unauthorized. */
export function asUploadError(error: unknown): Error {
  const code = firebaseStorageCode(error);
  if (code) {
    return new Error(`Upload failed (${code}). The image was not stored.`);
  }
  if (error instanceof Error) {
    if (error.message === UPLOAD_FAILED_MESSAGE || error.message.startsWith("Upload failed (")) return error;
    if (!/Firebase Storage:/i.test(error.message)) return error;
  }
  return new Error(UPLOAD_FAILED_MESSAGE);
}
