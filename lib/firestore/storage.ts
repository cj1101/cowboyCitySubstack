import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { getClientStorage } from "@/lib/firebase";
import { asUploadError } from "@/lib/images";
import { compressImage, mediaContentType } from "@/lib/storage/media";

async function uploadFile(path: string, file: Blob, contentType: string): Promise<string> {
  try {
    const storageRef = ref(getClientStorage(), path);
    await uploadBytes(storageRef, file, { contentType });
    const url = await getDownloadURL(storageRef);
    if (!url) throw new Error("empty download url");
    return url;
  } catch (error) {
    throw asUploadError(error);
  }
}

export async function uploadFactionImage(
  factionId: string,
  file: File,
  type: "banner" | "sigil"
): Promise<string> {
  const prepared = await compressImage(file);
  return uploadFile(`factions/${factionId}/${type}.jpg`, prepared, prepared.type || "image/jpeg");
}

export async function uploadCharacterAvatar(
  characterId: string,
  file: File
): Promise<string> {
  const prepared = await compressImage(file);
  return uploadFile(`characters/${characterId}/avatar.jpg`, prepared, mediaContentType(prepared));
}
