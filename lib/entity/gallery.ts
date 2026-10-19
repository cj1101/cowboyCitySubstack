/**
 * Entity gallery — the member-uploaded screenshot path (Phase 3 brief
 * §8.4; spec §6.4).
 *
 * Posture, per the brief:
 *  - Binaries live in Firebase Storage at the §11.5 per-structure path
 *    (`factions/{factionId}/structures/{structureId}/{fileName}`, with
 *    the corporations twin for businesses). The matching storage.rules
 *    path lands with the Phase 3 rules step (§11.5); until it does, an
 *    upload fails honestly in the UI rather than pretending.
 *  - Metadata (uploader, date, caption, kind, acceptance, showcase)
 *    lives in `factions/{factionId}/entity_gallery/{itemId}` — site
 *    content under the faction, never sim state, never a Log entry.
 *  - Who may upload as accepted: the building's owner/controller and
 *    the host city's owner. Any other member's upload lands **pending**
 *    until the building owner or host-city owner accepts it (sovereign
 *    canon — your city, your pages). Pending images are visible only
 *    to their uploader and to members who could accept them.
 *  - Images are client-resized/compressed before upload (the repo's
 *    `compressImage`, §13 budgets: ≤1600px longest edge target, image
 *    only). The showcase image is set explicitly by a manager; the
 *    newest upload is never auto-promoted.
 *  - The team never sources screenshots (CJ): an empty gallery is the
 *    honest state, rendered as a prompt, never a placeholder image.
 */

import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  query,
  serverTimestamp,
  updateDoc,
  where,
  type Timestamp,
} from "firebase/firestore";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";
import { getClientDb, getClientStorage } from "@/lib/firebase";
import { asUploadError } from "@/lib/images";
import { compressImage } from "@/lib/storage/media";
import type { EntityKind, GalleryAcceptance, GalleryImageKind, GalleryItem } from "./types";

function galleryCol(factionId: string) {
  return collection(getClientDb(), "factions", factionId, "entity_gallery");
}

export function galleryStoragePath(
  factionId: string,
  kind: EntityKind,
  entityKey: string,
  fileName: string
): string {
  const segment = kind === "building" ? "structures" : "corporations";
  return `factions/${factionId}/${segment}/${entityKey}/${fileName}`;
}

function docToGalleryItem(id: string, data: Record<string, unknown>): GalleryItem {
  const created = data.createdAt as Timestamp | undefined;
  return {
    id,
    entityKind: (data.entityKind as EntityKind) === "business" ? "business" : "building",
    entityKey: (data.entityKey as string) ?? "",
    url: (data.url as string) ?? "",
    storagePath: (data.storagePath as string) ?? "",
    uploaderUid: (data.uploaderUid as string) ?? "",
    uploaderDisplay: (data.uploaderDisplay as string | null) ?? null,
    caption: (data.caption as string | null) ?? null,
    kind: (["screenshot", "plan", "map"].includes(data.kind as string)
      ? data.kind
      : "screenshot") as GalleryImageKind,
    acceptance: (data.acceptance as GalleryAcceptance) === "pending" ? "pending" : "accepted",
    showcase: data.showcase === true,
    createdAtMillis: created && typeof created.toMillis === "function" ? created.toMillis() : null,
  };
}

export async function listEntityGallery(
  factionId: string,
  kind: EntityKind,
  entityKey: string
): Promise<GalleryItem[]> {
  try {
    const snap = await getDocs(
      query(galleryCol(factionId), where("entityKey", "==", entityKey))
    );
    return snap.docs
      .map((d) => docToGalleryItem(d.id, d.data()))
      .filter((item) => item.entityKind === kind)
      .sort((a, b) => (a.createdAtMillis ?? 0) - (b.createdAtMillis ?? 0));
  } catch {
    return [];
  }
}

/** What a viewer may see: accepted images, plus pending ones they
 * uploaded or could accept (brief §8.4 proposal flow). */
export function visibleGallery(
  items: GalleryItem[],
  viewerUid: string | null,
  viewerCanManage: boolean
): GalleryItem[] {
  return items.filter(
    (item) =>
      item.acceptance === "accepted" ||
      (viewerUid !== null && (item.uploaderUid === viewerUid || viewerCanManage))
  );
}

export async function uploadEntityImage(input: {
  factionId: string;
  kind: EntityKind;
  entityKey: string;
  file: File;
  uploaderUid: string;
  uploaderDisplay: string | null;
  caption: string | null;
  imageKind: GalleryImageKind;
  /** Uploaders with management rights land accepted; others pending. */
  asAccepted: boolean;
}): Promise<GalleryItem> {
  if (!input.file.type.startsWith("image/")) {
    throw new Error("That file isn't an image.");
  }
  const prepared = await compressImage(input.file);
  const safeName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`;
  const path = galleryStoragePath(input.factionId, input.kind, input.entityKey, safeName);
  let url: string;
  try {
    const storageRef = ref(getClientStorage(), path);
    await uploadBytes(storageRef, prepared, { contentType: prepared.type || "image/jpeg" });
    url = await getDownloadURL(storageRef);
  } catch (error) {
    throw asUploadError(error);
  }
  const refDoc = await addDoc(galleryCol(input.factionId), {
    entityKind: input.kind,
    entityKey: input.entityKey,
    url,
    storagePath: path,
    uploaderUid: input.uploaderUid,
    uploaderDisplay: input.uploaderDisplay,
    caption: input.caption,
    kind: input.imageKind,
    acceptance: input.asAccepted ? "accepted" : "pending",
    showcase: false,
    createdAt: serverTimestamp(),
  });
  return {
    id: refDoc.id,
    entityKind: input.kind,
    entityKey: input.entityKey,
    url,
    storagePath: path,
    uploaderUid: input.uploaderUid,
    uploaderDisplay: input.uploaderDisplay,
    caption: input.caption,
    kind: input.imageKind,
    acceptance: input.asAccepted ? "accepted" : "pending",
    showcase: false,
    createdAtMillis: Date.now(),
  };
}

export async function setGalleryAcceptance(
  factionId: string,
  itemId: string,
  acceptance: GalleryAcceptance
): Promise<void> {
  await updateDoc(doc(getClientDb(), "factions", factionId, "entity_gallery", itemId), {
    acceptance,
  });
}

export async function setGalleryShowcase(
  factionId: string,
  items: GalleryItem[],
  itemId: string
): Promise<void> {
  await Promise.all(
    items
      .filter((item) => item.showcase !== (item.id === itemId))
      .map((item) =>
        updateDoc(doc(getClientDb(), "factions", factionId, "entity_gallery", item.id), {
          showcase: item.id === itemId,
        })
      )
  );
}

export async function removeGalleryItem(factionId: string, itemId: string): Promise<void> {
  await deleteDoc(doc(getClientDb(), "factions", factionId, "entity_gallery", itemId));
}
