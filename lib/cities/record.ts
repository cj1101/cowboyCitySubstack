export interface CityRecordFields {
  motto?: string;
  population?: number;
  foundedOn?: string;
  gallery: string[];
}

export function readCityRecord(data: Record<string, unknown>): CityRecordFields {
  const population = data.population;
  const motto = typeof data.motto === "string" ? data.motto.trim() : "";
  const foundedOn = typeof data.foundedOn === "string" ? data.foundedOn.trim() : "";
  const gallery = Array.isArray(data.gallery)
    ? data.gallery.filter((item): item is string => typeof item === "string" && item.length > 0).slice(0, 24)
    : [];
  return {
    motto: motto || undefined,
    population:
      typeof population === "number" && Number.isFinite(population) && population >= 0
        ? Math.floor(population)
        : undefined,
    foundedOn: foundedOn || undefined,
    gallery,
  };
}

export function formatFoundingDate(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

export function formatPopulation(value: number | undefined): string {
  if (value === undefined) return "";
  return value.toLocaleString();
}

export function parsePopulation(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d+$/.test(trimmed)) {
    throw new Error("Population has to be a whole number.");
  }
  const population = Number(trimmed);
  if (population > 1_000_000_000) {
    throw new Error("Population is too large.");
  }
  return population;
}
