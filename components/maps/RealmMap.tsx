"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { Faction, MapPin, WikiEntry } from "@/lib/types";
import type { StoredTreaty } from "@/lib/firestore/treaties";
import { UPLOAD_FAILED_MESSAGE } from "@/lib/images";

type DraftPin = { nx: number; ny: number };

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function ring(points: { nx: number; ny: number }[]) {
  if (points.length < 3) return points;
  const cx = points.reduce((sum, point) => sum + point.nx, 0) / points.length;
  const cy = points.reduce((sum, point) => sum + point.ny, 0) / points.length;
  return [...points].sort(
    (a, b) => Math.atan2(a.ny - cy, a.nx - cx) - Math.atan2(b.ny - cy, b.nx - cx)
  );
}

export function RealmMap({
  imageUrl,
  pins,
  cities,
  wikiEntries,
  treaties,
  canEdit,
  onUpload,
  onAddPin,
  onMovePin,
  onUpdatePin,
  onDeletePin,
}: {
  imageUrl: string;
  pins: MapPin[];
  cities: Faction[];
  wikiEntries: WikiEntry[];
  treaties: StoredTreaty[];
  canEdit: boolean;
  onUpload: (file: File) => Promise<void>;
  onAddPin: (pin: Omit<MapPin, "id">) => Promise<void>;
  onMovePin: (pinId: string, nx: number, ny: number) => Promise<void>;
  onUpdatePin: (pinId: string, patch: Partial<MapPin>) => Promise<void>;
  onDeletePin: (pinId: string) => Promise<void>;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [showTreaties, setShowTreaties] = useState(false);
  const [hiddenTreaties, setHiddenTreaties] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<DraftPin | null>(null);
  const [selectedPin, setSelectedPin] = useState<string | null>(null);
  const [selectedTreaty, setSelectedTreaty] = useState<string | null>(null);
  const [popupAt, setPopupAt] = useState<{ x: number; y: number } | null>(null);
  const [uploadError, setUploadError] = useState("");
  const [cityId, setCityId] = useState("");
  const [wikiIds, setWikiIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const drag = useRef<{ x: number; y: number; panX: number; panY: number; moved: boolean } | null>(null);
  const pinDrag = useRef<{ id: string; moved: boolean } | null>(null);
  const [livePins, setLivePins] = useState(pins);

  useEffect(() => {
    setLivePins(pins);
  }, [pins]);

  const cityById = useMemo(() => new Map(cities.map((city) => [city.id, city])), [cities]);
  const visibleTreaties = treaties.filter((treaty) => !hiddenTreaties.includes(treaty.id));
  const pinForCity = (id: string) => livePins.find((pin) => pin.cityId === id);

  const placeNorm = (event: { clientX: number; clientY: number }) => {
    const image = viewportRef.current?.querySelector("img");
    if (!image) return null;
    const rect = image.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return {
      nx: clamp((event.clientX - rect.left) / rect.width, 0, 1),
      ny: clamp((event.clientY - rect.top) / rect.height, 0, 1),
    };
  };

  const zoomAt = (clientX: number, clientY: number, nextScale: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const ox = clientX - rect.left;
    const oy = clientY - rect.top;
    const worldX = (ox - pan.x) / scale;
    const worldY = (oy - pan.y) / scale;
    const clamped = clamp(nextScale, 1, 6);
    setScale(clamped);
    setPan({ x: ox - worldX * clamped, y: oy - worldY * clamped });
  };

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomAt(event.clientX, event.clientY, scale * (event.deltaY < 0 ? 1.12 : 0.9));
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  });

  const openPin = (pinId: string, event: { clientX: number; clientY: number }) => {
    const viewport = viewportRef.current?.getBoundingClientRect();
    setSelectedTreaty(null);
    setSelectedPin(pinId);
    if (viewport) setPopupAt({ x: event.clientX - viewport.left + 8, y: event.clientY - viewport.top + 8 });
    const pin = livePins.find((item) => item.id === pinId);
    setCityId(pin?.cityId || "");
    setWikiIds(pin?.wikiEntryIds || []);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-secondary text-sm px-3 py-1.5" onClick={() => zoomAt(
          (viewportRef.current?.getBoundingClientRect().left || 0) + 200,
          (viewportRef.current?.getBoundingClientRect().top || 0) + 200,
          scale * 1.2
        )}>Zoom in</button>
        <button type="button" className="btn btn-secondary text-sm px-3 py-1.5" onClick={() => zoomAt(
          (viewportRef.current?.getBoundingClientRect().left || 0) + 200,
          (viewportRef.current?.getBoundingClientRect().top || 0) + 200,
          scale / 1.2
        )}>Zoom out</button>
        <button type="button" className="btn btn-secondary text-sm px-3 py-1.5" onClick={() => { setScale(1); setPan({ x: 0, y: 0 }); }}>Reset</button>
        <label className="flex items-center gap-2 text-sm font-bold">
          <input type="checkbox" checked={showTreaties} onChange={(event) => setShowTreaties(event.target.checked)} />
          Show treaties
        </label>
        {canEdit && (
          <button type="button" className={`text-sm px-3 py-1.5 ${adding ? "btn" : "btn btn-secondary"}`} onClick={() => { setAdding((value) => !value); setDraft(null); }}>
            {adding ? "Click the map to place a pin" : "Add pin"}
          </button>
        )}
        {canEdit && (
          <label className="text-sm">
            <span className="sr-only">Replace realm map</span>
            <input
              type="file"
              accept="image/*"
              className="text-sm"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                setUploadError("");
                onUpload(file).catch(() => setUploadError(UPLOAD_FAILED_MESSAGE));
              }}
            />
          </label>
        )}
      </div>
      {uploadError && <p className="text-sm font-bold" role="alert">{uploadError}</p>}

      <div
        ref={viewportRef}
        className="relative h-[75vh] min-h-[520px] overflow-hidden rounded-lg border border-primary-brown bg-white touch-none"
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest("[data-pin],[data-popup]")) return;
          drag.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y, moved: false };
          (event.currentTarget as HTMLDivElement).setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (pinDrag.current) {
            const next = placeNorm(event);
            if (!next) return;
            pinDrag.current.moved = true;
            const id = pinDrag.current.id;
            setLivePins((current) => current.map((pin) => (pin.id === id ? { ...pin, nx: next.nx, ny: next.ny } : pin)));
            return;
          }
          if (!drag.current) return;
          const dx = event.clientX - drag.current.x;
          const dy = event.clientY - drag.current.y;
          if (Math.hypot(dx, dy) > 4) drag.current.moved = true;
          if (drag.current.moved) setPan({ x: drag.current.panX + dx, y: drag.current.panY + dy });
        }}
        onPointerUp={(event) => {
          if (pinDrag.current) {
            const dragging = pinDrag.current;
            pinDrag.current = null;
            const next = placeNorm(event);
            if (dragging.moved && next) onMovePin(dragging.id, next.nx, next.ny).catch(() => undefined);
            else if (!dragging.moved) openPin(dragging.id, event);
            return;
          }
          const background = drag.current;
          drag.current = null;
          if (!background || background.moved) return;
          if (!adding) return;
          const next = placeNorm(event);
          if (!next) return;
          setDraft(next);
          setSelectedPin(null);
          setCityId(cities[0]?.id || "");
          setWikiIds([]);
        }}
      >
        <div style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`, transformOrigin: "0 0" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageUrl} alt="Realm map" className="block w-full h-auto select-none" draggable={false} />
          {showTreaties && (
            <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
              {visibleTreaties.map((treaty) => {
                const points = treaty.partyCityIds
                  .map((id) => pinForCity(id))
                  .filter((pin): pin is MapPin => Boolean(pin))
                  .map((pin) => ({ nx: pin.nx * 100, ny: pin.ny * 100 }));
                if (points.length < 2) return null;
                const ordered = points.length >= 3 ? ring(points) : points;
                const path = ordered.map((point) => `${point.nx},${point.ny}`).join(" ");
                return (
                  <polyline
                    key={treaty.id}
                    points={path}
                    fill={points.length >= 3 ? treaty.color : "none"}
                    fillOpacity={points.length >= 3 ? 0.12 : 0}
                    stroke={treaty.color}
                    strokeWidth={1.4}
                    vectorEffect="non-scaling-stroke"
                    className="cursor-pointer"
                    onClick={(event) => {
                      event.stopPropagation();
                      const viewport = viewportRef.current?.getBoundingClientRect();
                      setSelectedPin(null);
                      setSelectedTreaty(treaty.id);
                      if (viewport) setPopupAt({ x: event.clientX - viewport.left, y: event.clientY - viewport.top });
                    }}
                  />
                );
              })}
            </svg>
          )}
          {livePins.map((pin) => (
            <button
              key={pin.id}
              type="button"
              data-pin
              title={pin.title}
              className="absolute w-4 h-4 -ml-2 -mt-2 rounded-full bg-accent-yellow border border-on-yellow shadow"
              style={{ left: `${pin.nx * 100}%`, top: `${pin.ny * 100}%` }}
              onPointerDown={(event) => {
                event.stopPropagation();
                if (!canEdit) {
                  openPin(pin.id, event);
                  return;
                }
                pinDrag.current = { id: pin.id, moved: false };
                (event.currentTarget as HTMLButtonElement).setPointerCapture(event.pointerId);
              }}
            />
          ))}
          {draft && (
            <span className="absolute w-4 h-4 -ml-2 -mt-2 rounded-full bg-accent-cyan border border-on-yellow" style={{ left: `${draft.nx * 100}%`, top: `${draft.ny * 100}%` }} />
          )}
        </div>

        {popupAt && selectedPin && (
          <PinPopup
            pin={livePins.find((pin) => pin.id === selectedPin) || null}
            city={cityById.get(livePins.find((pin) => pin.id === selectedPin)?.cityId || "")}
            wikiEntries={wikiEntries.filter((entry) => (livePins.find((pin) => pin.id === selectedPin)?.wikiEntryIds || []).includes(entry.id))}
            at={popupAt}
            canEdit={canEdit}
            cities={cities}
            allWiki={wikiEntries}
            cityId={cityId}
            wikiIds={wikiIds}
            busy={busy}
            onClose={() => setSelectedPin(null)}
            onCityId={setCityId}
            onWikiIds={setWikiIds}
            onSave={async () => {
              if (!selectedPin) return;
              setBusy(true);
              try {
                const city = cityById.get(cityId);
                await onUpdatePin(selectedPin, {
                  cityId,
                  title: city?.name || "Pin",
                  wikiEntryIds: wikiIds,
                  wikiEntryId: wikiIds[0] || null,
                });
              } finally {
                setBusy(false);
              }
            }}
            onDelete={async () => {
              if (!selectedPin) return;
              await onDeletePin(selectedPin);
              setSelectedPin(null);
            }}
          />
        )}
        {popupAt && selectedTreaty && (
          <TreatyPopup
            treaty={treaties.find((treaty) => treaty.id === selectedTreaty) || null}
            cities={cities}
            at={popupAt}
            onClose={() => setSelectedTreaty(null)}
          />
        )}
      </div>

      {showTreaties && (
        <div className="glass-panel p-4">
          <h2 className="font-bold mb-2">Treaty legend</h2>
          {treaties.length === 0 ? (
            <p className="text-sm text-text-muted">No active treaties to draw.</p>
          ) : (
            <ul className="flex flex-wrap gap-3">
              {treaties.map((treaty) => (
                <li key={treaty.id}>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={!hiddenTreaties.includes(treaty.id)}
                      onChange={(event) => {
                        setHiddenTreaties((current) =>
                          event.target.checked ? current.filter((id) => id !== treaty.id) : [...current, treaty.id]
                        );
                      }}
                    />
                    <span className="inline-block w-4 h-1.5 rounded" style={{ background: treaty.color }} />
                    {treaty.name}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {canEdit && draft && (
        <form
          className="glass-panel p-4 space-y-3"
          onSubmit={async (event) => {
            event.preventDefault();
            const city = cityById.get(cityId);
            if (!city) return;
            setBusy(true);
            try {
              await onAddPin({
                title: city.name,
                nx: draft.nx,
                ny: draft.ny,
                cityId: city.id,
                wikiEntryIds: wikiIds,
                wikiEntryId: wikiIds[0] || null,
                postId: null,
                x: null,
                z: null,
              });
              setDraft(null);
              setAdding(false);
              setWikiIds([]);
            } finally {
              setBusy(false);
            }
          }}
        >
          <p className="text-sm text-text-muted">Link this pin to a city. Wiki entries are optional.</p>
          <label className="form-label" htmlFor="pin-city">City</label>
          <select id="pin-city" className="form-input" value={cityId} onChange={(event) => setCityId(event.target.value)} required>
            {cities.map((city) => <option key={city.id} value={city.id}>{city.name}</option>)}
          </select>
          <WikiPicker entries={wikiEntries} selected={wikiIds} onChange={setWikiIds} />
          <button className="btn text-sm px-4 py-2" disabled={busy} type="submit">Save pin</button>
        </form>
      )}
    </div>
  );
}

function WikiPicker({
  entries,
  selected,
  onChange,
}: {
  entries: WikiEntry[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  if (entries.length === 0) return <p className="text-sm text-text-muted">No wiki entries yet.</p>;
  return (
    <fieldset className="space-y-1 max-h-40 overflow-y-auto">
      <legend className="form-label">Wiki entries</legend>
      {entries.map((entry) => (
        <label key={entry.id} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={selected.includes(entry.id)}
            onChange={(event) => {
              onChange(event.target.checked ? [...selected, entry.id] : selected.filter((id) => id !== entry.id));
            }}
          />
          {entry.title}
        </label>
      ))}
    </fieldset>
  );
}

function PinPopup({
  pin,
  city,
  wikiEntries,
  at,
  canEdit,
  cities,
  allWiki,
  cityId,
  wikiIds,
  busy,
  onClose,
  onCityId,
  onWikiIds,
  onSave,
  onDelete,
}: {
  pin: MapPin | null;
  city?: Faction;
  wikiEntries: WikiEntry[];
  at: { x: number; y: number };
  canEdit: boolean;
  cities: Faction[];
  allWiki: WikiEntry[];
  cityId: string;
  wikiIds: string[];
  busy: boolean;
  onClose: () => void;
  onCityId: (id: string) => void;
  onWikiIds: (ids: string[]) => void;
  onSave: () => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  if (!pin) return null;
  const shown = city || cities.find((item) => item.id === pin.cityId);
  return (
    <div data-popup className="absolute z-20 w-72 glass-panel p-4 shadow-lg" style={{ left: at.x, top: at.y }}>
      <div className="flex justify-between gap-2">
        <h3 className="font-bold">{shown?.name || pin.title}</h3>
        <button type="button" className="text-text-muted" onClick={onClose} aria-label="Close">×</button>
      </div>
      {shown?.sigilUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={shown.sigilUrl} alt="" className="w-12 h-12 rounded-full border border-primary-brown object-cover my-2" />
      ) : (
        <div className="w-12 h-12 rounded-full my-2 flex items-center justify-center font-bold" style={{ background: shown?.colors?.primary || "#169C9C", color: "#1c1917" }}>
          {(shown?.name || pin.title).charAt(0)}
        </div>
      )}
      <p className="text-sm text-text-muted line-clamp-3">{shown?.bio || shown?.description || "No description yet."}</p>
      {shown && <Link className="text-accent-gold text-sm font-bold" href={`/cities/${shown.slug}`}>City home</Link>}
      {wikiEntries.length > 0 && (
        <ul className="mt-2 space-y-1">
          {wikiEntries.map((entry) => (
            <li key={entry.id}>
              <Link className="text-accent-gold text-sm" href={`/cities/${entry.citySlug}/wiki`}>
                {entry.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <div className="mt-3 space-y-2 border-t border-primary-brown pt-3">
          <select className="form-input" value={cityId} onChange={(event) => onCityId(event.target.value)}>
            {cities.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <WikiPicker entries={allWiki} selected={wikiIds} onChange={onWikiIds} />
          <div className="flex gap-2">
            <button type="button" className="btn text-sm px-3 py-1.5" disabled={busy} onClick={() => onSave()}>Save</button>
            <button type="button" className="btn btn-danger text-sm px-3 py-1.5" onClick={() => onDelete()}>Delete</button>
          </div>
        </div>
      )}
    </div>
  );
}

function TreatyPopup({
  treaty,
  cities,
  at,
  onClose,
}: {
  treaty: StoredTreaty | null;
  cities: Faction[];
  at: { x: number; y: number };
  onClose: () => void;
}) {
  if (!treaty) return null;
  const parties = treaty.partyCityIds.map((id) => cities.find((city) => city.id === id)?.name || "City");
  return (
    <div data-popup className="absolute z-20 w-72 glass-panel p-4 shadow-lg" style={{ left: at.x, top: at.y }}>
      <div className="flex justify-between gap-2">
        <h3 className="font-bold">{treaty.name}</h3>
        <button type="button" className="text-text-muted" onClick={onClose} aria-label="Close">×</button>
      </div>
      <p className="text-sm mt-1">{parties.join(", ")}</p>
      <p className="text-sm text-text-muted mt-2">{treaty.purpose}</p>
      <Link className="text-accent-gold text-sm font-bold" href={`/treaties/${treaty.id}`}>Treaty page</Link>
    </div>
  );
}
