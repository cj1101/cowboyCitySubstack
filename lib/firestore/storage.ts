import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { getClientStorage } from "@/lib/firebase";
import { asUploadError } from "@/lib/images";

async function uploadFile(path: string, file: File): Promise<string> {
  try {
    const storageRef = ref(getClientStorage(), path);
    await uploadBytes(storageRef, file);
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
  const ext = file.name.split(".").pop() ?? "jpg";
  return uploadFile(`factions/${factionId}/${type}.${ext}`, file);
}

export async function uploadCharacterAvatar(
  characterId: string,
  file: File
): Promise<string> {
  const ext = file.name.split(".").pop() ?? "jpg";
  return uploadFile(`characters/${characterId}/avatar.${ext}`, file);
}
