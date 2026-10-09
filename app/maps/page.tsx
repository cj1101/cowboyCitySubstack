"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { MapBoard } from "@/components/maps/MapBoard";
import { addRealmPin, deleteRealmPin, getRealmMap, getRealmPins, setRealmMapImage } from "@/lib/firestore/maps";
import { uploadMapImage } from "@/lib/storage/uploads";
import type { MapPin } from "@/lib/types";

export default function RealmMapPage() {
  const { profile } = useAuth();
  const [imageUrl, setImageUrl] = useState("");
  const [pins, setPins] = useState<MapPin[]>([]);

  const load = () => {
    Promise.all([getRealmMap(), getRealmPins()])
      .then(([map, pinList]) => {
        setImageUrl(map?.imageUrl || "");
        setPins(pinList);
      })
      .catch(() => undefined);
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] p-6">
      <div className="max-w-4xl mx-auto space-y-4">
        <h1 className="text-3xl font-bold text-accent-gold">Realm map</h1>
        <p className="text-text-muted">Optional overview of every city-state. Sheriffs place the image and the pins.</p>
        <div className="glass-panel p-4">
          <MapBoard
            imageUrl={imageUrl}
            pins={pins}
            canEdit={profile?.isAdmin === true}
            onUpload={async (file) => {
              const url = await uploadMapImage(`realm/overview.jpg`, file);
              await setRealmMapImage(url);
              setImageUrl(url);
            }}
            onAddPin={async (pin) => {
              await addRealmPin(pin);
              load();
            }}
            onDeletePin={async (pinId) => {
              await deleteRealmPin(pinId);
              load();
            }}
          />
        </div>
      </div>
    </div>
  );
}
