/** Firebase Storage download hosts the site is allowed to render. */
const REMOTE_IMAGE_HOST =
  /^https:\/\/(?:firebasestorage\.googleapis\.com|storage\.googleapis\.com|[a-z0-9-]+\.firebasestorage\.app|[a-z0-9-]+\.appspot\.com)\//i;

export const UPLOAD_FAILED_MESSAGE =
  "Upload failed. The image was not stored.";

export function isDisplayableImageUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  if (url.startsWith("/") && !url.startsWith("//")) return true;
  return REMOTE_IMAGE_HOST.test(url);
}

/** Keep validation errors. Turn storage/network failures into one clear sentence. */
export function asUploadError(error: unknown): Error {
  if (error instanceof Error) {
    if (
      /must be under|Only photos|Only images|Could not read|Could not capture|already taken|must be signed/i.test(
        error.message
      )
    ) {
      return error;
    }
    if (error.message === UPLOAD_FAILED_MESSAGE) return error;
  }
  return new Error(UPLOAD_FAILED_MESSAGE);
}
