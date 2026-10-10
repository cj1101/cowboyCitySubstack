import { clamp01 } from "@/lib/maps/territory";
import { PIN_CATEGORIES, type MapPin, type PinCategory } from "@/lib/types";

export function pinCategoryOf(value: unknown): PinCategory {
  return PIN_CATEGORIES.includes(value as PinCategory) ? (value as PinCategory) : "other";
}

function unitCoord(value: number): number {
  if (!Number.isFinite(value)) throw new Error("That pin is off the map.");
  return clamp01(value);
}

/** Fields that the realm and city pin rules accept. Undefined keys are omitted. */
export function realmPinFields(pin: Partial<Omit<MapPin, "id">>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (pin.title !== undefined) {
    const title = pin.title.trim();
    if (!title) throw new Error("Give the pin a title.");
    if (title.length > 200) throw new Error("Keep the pin title under 200 characters.");
    data.title = title;
  }
  if (pin.nx !== undefined) data.nx = unitCoord(pin.nx);
  if (pin.ny !== undefined) data.ny = unitCoord(pin.ny);
  if (pin.category !== undefined) {
    if (!PIN_CATEGORIES.includes(pin.category)) throw new Error("Choose a pin category.");
    data.category = pin.category;
  }
  if (pin.cityId !== undefined) data.cityId = pin.cityId;
  if (pin.note !== undefined) data.note = pin.note;
  if (pin.postId !== undefined) data.postId = pin.postId;
  if (pin.wikiEntryId !== undefined) data.wikiEntryId = pin.wikiEntryId;
  if (pin.wikiEntryIds !== undefined) data.wikiEntryIds = pin.wikiEntryIds;
  if (pin.x !== undefined) data.x = pin.x;
  if (pin.z !== undefined) data.z = pin.z;
  return data;
}
