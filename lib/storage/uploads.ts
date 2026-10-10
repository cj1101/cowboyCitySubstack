import { getDownloadURL, ref, uploadBytes } from "firebase/storage";
import { getClientStorage } from "@/lib/firebase";
import { asUploadError } from "@/lib/images";
import type { PostMedia } from "@/lib/types";
import { assertMediaFile, captureVideoThumbnail, compressImage, mediaContentType, mediaKind } from "@/lib/storage/media";

async function uploadBlob(path: string, data: Blob, contentType: string): Promise<string> {
  try {
    const storageRef = ref(getClientStorage(), path);
    await uploadBytes(storageRef, data, { contentType });
    const url = await getDownloadURL(storageRef);
    if (!url) throw new Error("empty download url");
    return url;
  } catch (error) {
    throw asUploadError(error);
  }
}

export async function uploadPostImage(postId: string, file: File, index: number): Promise<string> {
  const prepared = await compressImage(file);
  const path = `posts/${postId}/${Date.now()}_${index}.jpg`;
  return uploadBlob(path, prepared, prepared.type || "image/jpeg");
}

export async function uploadPostImages(postId: string, files: File[]): Promise<string[]> {
  const urls: string[] = [];
  for (let index = 0; index < files.length; index += 1) {
    urls.push(await uploadPostImage(postId, files[index], index));
  }
  return urls;
}

export async function uploadPostGallery(postId: string, files: File[]): Promise<PostMedia[]> {
  const media: PostMedia[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    assertMediaFile(file);
    if (mediaKind(file) === "video") {
      const videoUrl = await uploadBlob(
        `posts/${postId}/${Date.now()}_${index}.mp4`,
        file,
        mediaContentType(file)
      );
      let thumbUrl: string | undefined;
      try {
        const thumb = await captureVideoThumbnail(file);
        thumbUrl = await uploadBlob(
          `posts/${postId}/${Date.now()}_${index}_thumb.jpg`,
          thumb,
          "image/jpeg"
        );
      } catch {
        thumbUrl = undefined;
      }
      media.push({ url: videoUrl, type: "video", thumbUrl });
    } else {
      const prepared = await compressImage(file);
      const url = await uploadBlob(
        `posts/${postId}/${Date.now()}_${index}.jpg`,
        prepared,
        prepared.type || "image/jpeg"
      );
      media.push({ url, type: "image" });
    }
  }
  return media;
}

export async function uploadUserAvatar(uid: string, file: File): Promise<string> {
  assertMediaFile(file);
  const prepared = await compressImage(file);
  return uploadBlob(`users/${uid}/avatar.jpg`, prepared, "image/jpeg");
}

export async function uploadThreadImage(threadId: string, file: File, index: number): Promise<string> {
  const prepared = await compressImage(file);
  const path = `threads/${threadId}/${Date.now()}_${index}.jpg`;
  return uploadBlob(path, prepared, prepared.type || "image/jpeg");
}

export async function uploadMapImage(path: string, file: File): Promise<string> {
  assertMediaFile(file);
  const prepared = await compressImage(file);
  return uploadBlob(path, prepared, "image/jpeg");
}
