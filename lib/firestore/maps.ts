import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";
import { pinCategoryOf, realmPinFields } from "@/lib/maps/pins";
import { cleanPoints } from "@/lib/maps/territory";
import type { CityBorder, MapPin, MapPoint } from "@/lib/types";

function toPin(id: string, data: Record<string, unknown>): MapPin {
  return {
    id,
    title: (data.title as string) || "Pin",
    nx: Number(data.nx ?? 0),
    ny: Number(data.ny ?? 0),
    x: (data.x as number | null) ?? null,
    z: (data.z as number | null) ?? null,
    postId: (data.postId as string | null) ?? null,
    wikiEntryId: (data.wikiEntryId as string | null) ?? null,
    wikiEntryIds: Array.isArray(data.wikiEntryIds)
      ? (data.wikiEntryIds as string[])
      : data.wikiEntryId
        ? [data.wikiEntryId as string]
        : [],
    cityId: (data.cityId as string | null) ?? null,
    note: (data.note as string) || "",
    category: data.category ? pinCategoryOf(data.category) : undefined,
  };
}

function toBorder(cityId: string, data: Record<string, unknown>): CityBorder | null {
  const raw = Array.isArray(data.points) ? data.points : [];
  const points = cleanPoints(
    raw.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const point = item as { nx?: unknown; ny?: unknown };
      return [{ nx: Number(point.nx), ny: Number(point.ny) }];
    })
  );
  if (points.length < 3) return null;
  return { cityId, points };
}

export async function getCityPins(cityId: string): Promise<MapPin[]> {
  const snap = await getDocs(collection(getClientDb(), "factions", cityId, "pins"));
  return snap.docs.map((d) => toPin(d.id, d.data()));
}

export async function addCityPin(
  cityId: string,
  pin: Omit<MapPin, "id">
): Promise<string> {
  const ref = await addDoc(collection(getClientDb(), "factions", cityId, "pins"), {
    ...realmPinFields(pin),
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export async function deleteCityPin(cityId: string, pinId: string): Promise<void> {
  await deleteDoc(doc(getClientDb(), "factions", cityId, "pins", pinId));
}

export async function getRealmMap(): Promise<{ imageUrl: string } | null> {
  const snap = await getDoc(doc(getClientDb(), "realm_map", "overview"));
  if (!snap.exists()) return null;
  return { imageUrl: (snap.data().imageUrl as string) || "" };
}

export async function setRealmMapImage(imageUrl: string): Promise<void> {
  await setDoc(doc(getClientDb(), "realm_map", "overview"), { imageUrl, updatedAt: serverTimestamp() }, { merge: true });
}

export async function getRealmPins(): Promise<MapPin[]> {
  const snap = await getDocs(collection(getClientDb(), "realm_map", "overview", "pins"));
  return snap.docs.map((d) => toPin(d.id, d.data()));
}

export async function addRealmPin(pin: Omit<MapPin, "id">): Promise<string> {
  const data = realmPinFields(pin);
  if (typeof data.title !== "string" || typeof data.nx !== "number" || typeof data.ny !== "number") {
    throw new Error("Give the pin a title and a place on the map.");
  }
  const ref = await addDoc(collection(getClientDb(), "realm_map", "overview", "pins"), data);
  return ref.id;
}

export async function updateRealmPin(
  pinId: string,
  patch: Partial<Omit<MapPin, "id">>
): Promise<void> {
  const data = realmPinFields(patch);
  if (Object.keys(data).length === 0) throw new Error("Nothing to save on that pin.");
  await updateDoc(doc(getClientDb(), "realm_map", "overview", "pins", pinId), data);
}

export async function deleteRealmPin(pinId: string): Promise<void> {
  await deleteDoc(doc(getClientDb(), "realm_map", "overview", "pins", pinId));
}

export async function getRealmBorders(): Promise<CityBorder[]> {
  const snap = await getDocs(collection(getClientDb(), "realm_map", "overview", "borders"));
  return snap.docs.flatMap((item) => {
    const border = toBorder(item.id, item.data());
    return border ? [border] : [];
  });
}

export async function saveCityBorder(cityId: string, points: MapPoint[]): Promise<void> {
  const clean = cleanPoints(points);
  if (clean.length < 3) throw new Error("Add at least three corners.");
  if (clean.length > 64) throw new Error("A border can have at most 64 corners.");
  await setDoc(doc(getClientDb(), "realm_map", "overview", "borders", cityId), {
    cityId,
    points: clean,
    updatedAt: serverTimestamp(),
  });
}

export async function deleteCityBorder(cityId: string): Promise<void> {
  await deleteDoc(doc(getClientDb(), "realm_map", "overview", "borders", cityId));
}

export async function setCityMapImage(cityId: string, mapImageUrl: string): Promise<void> {
  await updateDoc(doc(getClientDb(), "factions", cityId), { mapImageUrl });
}
