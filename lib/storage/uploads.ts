import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { getClientStorage } from "@/lib/firebase";

export async function uploadPostImage(
  postId: string,
  file: File,
  index: number
): Promise<string> {
  const storage = getClientStorage();
  const ext = file.name.split(".").pop() ?? "jpg";
  const path = `posts/${postId}/${Date.now()}_${index}.${ext}`;
  const storageRef = ref(storage, path);
  await uploadBytes(storageRef, file);
  return getDownloadURL(storageRef);
}

export async function uploadPostImages(
  postId: string,
  files: File[]
): Promise<string[]> {
  const urls = await Promise.all(
    files.map((file, index) => uploadPostImage(postId, file, index))
  );
  return urls;
}
