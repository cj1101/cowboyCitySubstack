import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { getClientStorage } from "@/lib/firebase";
import { asUploadError } from "@/lib/images";
import { compressImage, mediaContentType } from "@/lib/storage/media";
import { uploadMapImage } from "@/lib/storage/uploads";

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

export async function uploadCityGalleryPhoto(cityId: string, file: File, index: number): Promise<string> {
  return uploadMapImage(`factions/${cityId}/gallery_${Date.now()}_${index}.jpg`, file);
}

export async function uploadCharacterAvatar(
  characterId: string,
  file: File
): Promise<string> {
  const prepared = await compressImage(file);
  return uploadFile(`characters/${characterId}/avatar.jpg`, prepared, mediaContentType(prepared));
}
