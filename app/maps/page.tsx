"use client";

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { useFactionContext } from "@/components/factions/FactionContext";
import { RealmMap } from "@/components/maps/RealmMap";
import { isSheriff } from "@/lib/membership";
import { getAllFactions } from "@/lib/firestore/factions";
import {
  addRealmPin,
  deleteCityBorder,
  deleteRealmPin,
  getRealmBorders,
  getRealmMap,
  getRealmPins,
  saveCityBorder,
  setRealmMapImage,
  updateRealmPin,
} from "@/lib/firestore/maps";
import { listActiveTreaties } from "@/lib/firestore/treaties";
import { getAllWikiEntries } from "@/lib/firestore/wikiEntries";
import { uploadMapImage } from "@/lib/storage/uploads";
import { actionError, withTimeout } from "@/lib/async";
import type { CityBorder, Faction, MapPin, MapPoint, WikiEntry } from "@/lib/types";
import type { StoredTreaty } from "@/lib/firestore/treaties";

const DEFAULT_REALM_MAP = "/realm-map.jpg";

export default function RealmMapPage() {
  const { profile, user } = useAuth();
  const { selectedFaction, userFactions } = useFactionContext();
  const [imageUrl, setImageUrl] = useState(DEFAULT_REALM_MAP);
  const [pins, setPins] = useState<MapPin[]>([]);
  const [cities, setCities] = useState<Faction[]>([]);
  const [wikiEntries, setWikiEntries] = useState<WikiEntry[]>([]);
  const [treaties, setTreaties] = useState<StoredTreaty[]>([]);
  const [borders, setBorders] = useState<CityBorder[]>([]);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    Promise.all([getRealmMap(), getRealmPins(), getAllFactions(), getAllWikiEntries(), listActiveTreaties()])
      .then(([map, pinList, factionList, entries, active]) => {
        setImageUrl(map?.imageUrl || DEFAULT_REALM_MAP);
        setPins(pinList);
        setCities(factionList);
        setWikiEntries(entries);
        setTreaties(active);
        setLoadError("");
      })
      .catch((error) => setLoadError(actionError(error, "Could not load the realm map.")));
    getRealmBorders()
      .then(setBorders)
      .catch((error) => {
        const message = actionError(error, "Could not load city borders.");
        setLoadError(
          message === "You don't have permission to do that."
            ? "City borders are not available until the map rules are deployed."
            : message
        );
      });
  }, []);

  const ownedCityIds = useMemo(
    () => (user ? cities.filter((city) => city.ownerUids.includes(user.uid)).map((city) => city.id) : []),
    [cities, user]
  );
  const myCityIds = useMemo(() => {
    const memberIds = userFactions.map((city) => city.id);
    return [...new Set([selectedFaction?.id, ...ownedCityIds, ...memberIds].filter((id): id is string => Boolean(id)))];
  }, [selectedFaction, ownedCityIds, userFactions]);

  return (
    <div className="h-[calc(100dvh-var(--app-nav)-var(--app-tabs))] flex flex-col">
      {loadError && (
        <p className="px-3 py-2 text-sm font-bold" role="alert">{loadError}</p>
      )}
      <div className="flex-1 min-h-0">
        <RealmMap
          imageUrl={imageUrl}
          pins={pins}
          cities={cities}
          wikiEntries={wikiEntries}
          treaties={treaties}
          borders={borders}
          canEdit={isSheriff(profile, user?.email)}
          ownedCityIds={ownedCityIds}
          myCityIds={myCityIds}
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
            let previous: MapPin | null = null;
            setPins((current) => {
              previous = current.find((pin) => pin.id === pinId) ?? null;
              return current.map((pin) => (pin.id === pinId ? { ...pin, nx, ny } : pin));
            });
            try {
              await withTimeout(updateRealmPin(pinId, { nx, ny }), 8000);
            } catch (error) {
              if (previous) {
                const snapshot = previous;
                setPins((current) => current.map((pin) => (pin.id === pinId ? snapshot : pin)));
              }
              throw error;
            }
          }}
          onUpdatePin={async (pinId, patch) => {
            await withTimeout(updateRealmPin(pinId, patch), 8000);
            setPins((current) => current.map((pin) => (pin.id === pinId ? { ...pin, ...patch } : pin)));
          }}
          onDeletePin={async (pinId) => {
            await withTimeout(deleteRealmPin(pinId), 8000);
            setPins((current) => current.filter((pin) => pin.id !== pinId));
          }}
          onSaveBorder={async (cityId, points: MapPoint[]) => {
            await withTimeout(saveCityBorder(cityId, points), 8000);
            setBorders((current) => [...current.filter((border) => border.cityId !== cityId), { cityId, points }]);
          }}
          onDeleteBorder={async (cityId) => {
            await withTimeout(deleteCityBorder(cityId), 8000);
            setBorders((current) => current.filter((border) => border.cityId !== cityId));
          }}
        />
      </div>
    </div>
  );
}
