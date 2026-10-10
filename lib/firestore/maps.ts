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
import type { MapPin } from "@/lib/types";

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
    category: data.category === "capital" || data.category === "outpost" || data.category === "landmark"
      ? data.category
      : null,
  };
}

export interface CityBorder {
  cityId: string;
  points: { nx: number; ny: number }[];
  color: string;
}

function toBorder(cityId: string, data: Record<string, unknown>): CityBorder | null {
  const points = Array.isArray(data.points)
    ? data.points
        .map((point) => {
          const row = point as { nx?: unknown; ny?: unknown };
          return { nx: Number(row.nx), ny: Number(row.ny) };
        })
        .filter((point) => Number.isFinite(point.nx) && Number.isFinite(point.ny))
    : [];
  if (points.length < 3) return null;
  return {
    cityId,
    points,
    color: typeof data.color === "string" && data.color ? data.color : "#169C9C",
  };
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
    ...pin,
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
  const ref = await addDoc(collection(getClientDb(), "realm_map", "overview", "pins"), pin);
  return ref.id;
}

export async function updateRealmPin(
  pinId: string,
  patch: Partial<Omit<MapPin, "id">>
): Promise<void> {
  await updateDoc(doc(getClientDb(), "realm_map", "overview", "pins", pinId), patch);
}

export async function deleteRealmPin(pinId: string): Promise<void> {
  await deleteDoc(doc(getClientDb(), "realm_map", "overview", "pins", pinId));
}

export async function getRealmBorders(): Promise<CityBorder[]> {
  const snap = await getDocs(collection(getClientDb(), "realm_map", "overview", "borders"));
  return snap.docs
    .map((item) => toBorder(item.id, item.data()))
    .filter((border): border is CityBorder => border !== null);
}

export async function saveRealmBorder(border: CityBorder): Promise<void> {
  await setDoc(doc(getClientDb(), "realm_map", "overview", "borders", border.cityId), {
    cityId: border.cityId,
    points: border.points,
    color: border.color,
    updatedAt: serverTimestamp(),
  });
}

export async function deleteRealmBorder(cityId: string): Promise<void> {
  await deleteDoc(doc(getClientDb(), "realm_map", "overview", "borders", cityId));
}

export async function setCityMapImage(cityId: string, mapImageUrl: string): Promise<void> {
  await updateDoc(doc(getClientDb(), "factions", cityId), { mapImageUrl });
}
