import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { getClientStorage } from "@/lib/firebase";

export async function uploadFactionImage(
  factionId: string,
  file: File,
  type: "banner" | "sigil"
): Promise<string> {
  const storage = getClientStorage();
  const ext = file.name.split(".").pop() ?? "jpg";
  const path = `factions/${factionId}/${type}.${ext}`;
  const storageRef = ref(storage, path);
  await uploadBytes(storageRef, file);
  return getDownloadURL(storageRef);
}

export async function uploadCharacterAvatar(
  characterId: string,
  file: File
): Promise<string> {
  const storage = getClientStorage();
  const ext = file.name.split(".").pop() ?? "jpg";
  const path = `characters/${characterId}/avatar.${ext}`;
  const storageRef = ref(storage, path);
  await uploadBytes(storageRef, file);
  return getDownloadURL(storageRef);
}
