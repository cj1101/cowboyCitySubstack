"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { RealmMap } from "@/components/maps/RealmMap";
import { isSheriff } from "@/lib/membership";
import { getAllFactions } from "@/lib/firestore/factions";
import {
  addRealmPin,
  deleteRealmPin,
  getRealmMap,
  getRealmPins,
  setRealmMapImage,
  updateRealmPin,
} from "@/lib/firestore/maps";
import { listActiveTreaties } from "@/lib/firestore/treaties";
import { getAllWikiEntries } from "@/lib/firestore/wikiEntries";
import { uploadMapImage } from "@/lib/storage/uploads";
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

  const load = () => {
    Promise.all([getRealmMap(), getRealmPins(), getAllFactions(), getAllWikiEntries(), listActiveTreaties()])
      .then(([map, pinList, factionList, entries, active]) => {
        setImageUrl(map?.imageUrl || DEFAULT_REALM_MAP);
        setPins(pinList);
        setCities(factionList);
        setWikiEntries(entries);
        setTreaties(active);
      })
      .catch(() => undefined);
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] p-4 md:p-6">
      <div className="max-w-6xl mx-auto space-y-4">
        <div>
          <h1 className="text-3xl font-bold text-accent-gold">Realm map</h1>
          <p className="text-text-muted">Drag to pan and scroll to zoom. Treaty lines stay hidden until you ask for them.</p>
        </div>
        <RealmMap
          imageUrl={imageUrl}
          pins={pins}
          cities={cities}
          wikiEntries={wikiEntries}
          treaties={treaties}
          canEdit={isSheriff(profile, user?.email)}
          onUpload={async (file) => {
            const url = await uploadMapImage("realm/overview.jpg", file);
            await setRealmMapImage(url);
            setImageUrl(url);
          }}
          onAddPin={async (pin) => {
            await addRealmPin(pin);
            load();
          }}
          onMovePin={async (pinId, nx, ny) => {
            setPins((current) => current.map((pin) => (pin.id === pinId ? { ...pin, nx, ny } : pin)));
            await updateRealmPin(pinId, { nx, ny });
          }}
          onUpdatePin={async (pinId, patch) => {
            await updateRealmPin(pinId, patch);
            load();
          }}
          onDeletePin={async (pinId) => {
            await deleteRealmPin(pinId);
            load();
          }}
        />
      </div>
    </div>
  );
}
