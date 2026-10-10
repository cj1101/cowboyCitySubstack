"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useAuth } from "@/components/auth/AuthProvider";
import { MapBoard } from "@/components/maps/MapBoard";
import { getFactionBySlug, isFactionOwner } from "@/lib/firestore/factions";
import { addCityPin, deleteCityPin, getCityPins, setCityMapImage } from "@/lib/firestore/maps";
import { uploadMapImage } from "@/lib/storage/uploads";
import { withTimeout } from "@/lib/async";
import type { Faction, MapPin } from "@/lib/types";

export default function CityMapPage() {
  const params = useParams<{ slug: string }>();
  const { user } = useAuth();
  const [city, setCity] = useState<Faction | null>(null);
  const [pins, setPins] = useState<MapPin[]>([]);
  const [owner, setOwner] = useState(false);

  const load = async () => {
    const faction = await getFactionBySlug(params.slug);
    setCity(faction);
    if (!faction) return;
    setPins(await getCityPins(faction.id));
    if (user) setOwner(await isFactionOwner(faction.id, user.uid));
  };

  useEffect(() => {
    load().catch(() => undefined);
  }, [params.slug, user]);

  if (!city) return <div className="p-8 text-text-muted">Loading map…</div>;

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] p-6">
      <div className="max-w-4xl mx-auto space-y-4">
        <Link href={`/cities/${city.slug}`} className="text-accent-gold text-sm">← {city.name}</Link>
        <h1 className="text-3xl font-bold text-accent-gold">{city.name} map</h1>
        <div className="glass-panel p-4">
          <MapBoard
            imageUrl={city.mapImageUrl}
            pins={pins}
            canEdit={owner}
            onUpload={async (file) => {
              const url = await withTimeout(uploadMapImage(`factions/${city.id}/map.jpg`, file), 20000);
              await withTimeout(setCityMapImage(city.id, url), 8000);
              setCity({ ...city, mapImageUrl: url });
            }}
            onAddPin={async (pin) => {
              await withTimeout(addCityPin(city.id, pin));
              setPins(await getCityPins(city.id));
            }}
            onDeletePin={async (pinId) => {
              await withTimeout(deleteCityPin(city.id, pinId));
              setPins(await getCityPins(city.id));
            }}
          />
        </div>
      </div>
    </div>
  );
}
