import Link from "next/link";
import { StoredImage } from "@/components/media/StoredImage";
import type { Faction } from "@/lib/types";

export function CityMapCard({ city }: { city: Faction }) {
  return (
    <section className="glass-panel p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xl font-bold text-accent-gold">City map</h2>
        <Link href={`/cities/${city.slug}/map`} className="text-accent-gold text-sm font-bold">
          Open map
        </Link>
      </div>
      {city.mapImageUrl ? (
        <StoredImage src={city.mapImageUrl} alt={`${city.name} map`} className="w-full h-auto block border border-ink" />
      ) : (
        <p className="text-sm text-text-muted">No map image yet. City owners can upload one on the map page.</p>
      )}
    </section>
  );
}
