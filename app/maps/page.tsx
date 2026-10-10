"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { RealmMap } from "@/components/maps/RealmMap";
import { isSheriff } from "@/lib/membership";
import { getAllFactions } from "@/lib/firestore/factions";
import {
  addRealmPin,
  deleteRealmBorder,
  deleteRealmPin,
  getRealmBorders,
  getRealmMap,
  getRealmPins,
  saveRealmBorder,
  setRealmMapImage,
  updateRealmPin,
  type CityBorder,
} from "@/lib/firestore/maps";
import { listActiveTreaties } from "@/lib/firestore/treaties";
import { getAllWikiEntries } from "@/lib/firestore/wikiEntries";
import { uploadMapImage } from "@/lib/storage/uploads";
import { actionError, withTimeout } from "@/lib/async";
import type { Faction, MapPin, WikiEntry } from "@/lib/types";
import type { StoredTreaty } from "@/lib/firestore/treaties";

const DEFAULT_REALM_MAP = "/realm-map.jpg";

export default function RealmMapPage() {
  const { profile, user } = useAuth();
  const [imageUrl, setImageUrl] = useState(DEFAULT_REALM_MAP);
  const [pins, setPins] = useState<MapPin[]>([]);
  const [cities, setCities] = useState<Faction[]>([]);
  const [wikiEntries, setWikiEntries] = useState<WikiEntry[]>([]);
  const [treaties, setTreaties] = useState<StoredTreaty[]>([]);
  const [borders, setBorders] = useState<CityBorder[]>([]);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    Promise.all([getRealmMap(), getRealmPins(), getAllFactions(), getAllWikiEntries(), listActiveTreaties(), getRealmBorders()])
      .then(([map, pinList, factionList, entries, active, borderList]) => {
        setImageUrl(map?.imageUrl || DEFAULT_REALM_MAP);
        setPins(pinList);
        setCities(factionList);
        setWikiEntries(entries);
        setTreaties(active);
        setBorders(borderList);
        setLoadError("");
      })
      .catch((error) => setLoadError(actionError(error, "Could not load the realm map.")));
  }, []);

  const ownedCityIds = user ? cities.filter((city) => city.ownerUids.includes(user.uid)).map((city) => city.id) : [];

  return (
    <div className="relative h-[calc(100dvh-var(--app-nav)-var(--app-tabs))]">
      {loadError && <p className="absolute top-2 left-2 z-40 glass-panel px-3 py-2 text-sm font-bold" role="alert">{loadError}</p>}
      <RealmMap
        imageUrl={imageUrl}
        pins={pins}
        cities={cities}
        wikiEntries={wikiEntries}
        treaties={treaties}
        borders={borders}
        myCityId={ownedCityIds[0] || null}
        ownedCityIds={ownedCityIds}
        canEdit={isSheriff(profile, user?.email)}
        onUpload={async (file) => {
          const url = await withTimeout(uploadMapImage("realm/overview.jpg", file), 20000);
          await withTimeout(setRealmMapImage(url), 8000);
          setImageUrl(url);
        }}
        onAddPin={async (pin) => {
          const id = await withTimeout(addRealmPin(pin), 8000);
          setPins((current) => [...current, { ...pin, id }]);
        }}
        onMovePin={async (pinId, nx, ny) => {
          setPins((current) => current.map((pin) => (pin.id === pinId ? { ...pin, nx, ny } : pin)));
          await withTimeout(updateRealmPin(pinId, { nx, ny }), 8000);
        }}
        onUpdatePin={async (pinId, patch) => {
          await withTimeout(updateRealmPin(pinId, patch), 8000);
          setPins((current) => current.map((pin) => (pin.id === pinId ? { ...pin, ...patch } : pin)));
        }}
        onDeletePin={async (pinId) => {
          await withTimeout(deleteRealmPin(pinId), 8000);
          setPins((current) => current.filter((pin) => pin.id !== pinId));
        }}
        onSaveBorder={async (border) => {
          let previous: CityBorder[] = [];
          setBorders((current) => {
            previous = current;
            return [...current.filter((item) => item.cityId !== border.cityId), border];
          });
          try {
            await withTimeout(saveRealmBorder(border), 8000);
          } catch (error) {
            setBorders(previous);
            throw error;
          }
        }}
        onDeleteBorder={async (cityId) => {
          let previous: CityBorder[] = [];
          setBorders((current) => {
            previous = current;
            return current.filter((item) => item.cityId !== cityId);
          });
          try {
            await withTimeout(deleteRealmBorder(cityId), 8000);
          } catch (error) {
            setBorders(previous);
            throw error;
          }
        }}
      />
    </div>
  );
}
