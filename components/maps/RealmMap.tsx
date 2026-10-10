"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { Faction, MapPin, WikiEntry } from "@/lib/types";
import type { StoredTreaty } from "@/lib/firestore/treaties";
import { actionError } from "@/lib/async";
import { UPLOAD_FAILED_MESSAGE } from "@/lib/images";
import { clamp, pinchView, popupPosition } from "@/lib/maps/gestures";
import { SubmitButton } from "@/components/ui/SubmitButton";

type DraftPin = { nx: number; ny: number };

function useNarrow() {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const apply = () => setNarrow(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);
  return narrow;
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
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [frame, setFrame] = useState({ w: 0, h: 0 });
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [showTreaties, setShowTreaties] = useState(false);
  const [hiddenTreaties, setHiddenTreaties] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<DraftPin | null>(null);
  const [selectedPin, setSelectedPin] = useState<string | null>(null);
  const [selectedTreaty, setSelectedTreaty] = useState<string | null>(null);
  const [popupAt, setPopupAt] = useState<{ x: number; y: number } | null>(null);
  const [banner, setBanner] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [formError, setFormError] = useState("");
  const [toolbarH, setToolbarH] = useState(56);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [cityId, setCityId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [wikiIds, setWikiIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const drag = useRef<{ x: number; y: number; panX: number; panY: number; moved: boolean } | null>(null);
  const pinDrag = useRef<{ id: string; moved: boolean } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ distance: number; scale: number; panX: number; panY: number } | null>(null);
  const pinched = useRef(false);
  const centeredFor = useRef("");
  const narrow = useNarrow();
  const [livePins, setLivePins] = useState(pins);

  useEffect(() => {
    setLivePins(pins);
  }, [pins]);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const measure = () => setFrame({ w: node.clientWidth, h: node.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const node = toolbarRef.current;
    if (!node) return;
    const measure = () => setToolbarH(node.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const fitted = useMemo(() => {
    if (!frame.w || !frame.h || !natural.w || !natural.h) return null;
    const contain = Math.min(frame.w / natural.w, frame.h / natural.h);
    return { w: natural.w * contain, h: natural.h * contain };
  }, [frame, natural]);

  useEffect(() => {
    if (!fitted || !frame.w || centeredFor.current === imageUrl) return;
    centeredFor.current = imageUrl;
    setScale(1);
    setPan({ x: (frame.w - fitted.w) / 2, y: (frame.h - fitted.h) / 2 });
  }, [fitted, frame.w, frame.h, imageUrl]);

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

  const resetView = () => {
    setScale(1);
    if (fitted) setPan({ x: (frame.w - fitted.w) / 2, y: (frame.h - fitted.h) / 2 });
    else setPan({ x: 0, y: 0 });
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
    setDraft(null);
    setSelectedPin(pinId);
    if (viewport) setPopupAt({ x: event.clientX - viewport.left + 8, y: event.clientY - viewport.top + 8 });
    const pin = livePins.find((item) => item.id === pinId);
    setCityId(pin?.cityId || "");
    setWikiIds(pin?.wikiEntryIds || []);
  };

  return (
    <div className="relative h-full min-h-0">
      <div ref={toolbarRef} className="pointer-events-none absolute top-2 left-2 right-2 z-30">
        <div className="pointer-events-auto glass-panel px-2 py-2 flex flex-wrap items-center gap-2 w-fit max-w-full">
          <button
            type="button"
            className="btn btn-secondary text-sm min-h-11 px-3 py-2 md:hidden"
            aria-expanded={toolsOpen}
            onClick={() => setToolsOpen((value) => !value)}
          >
            {toolsOpen ? "Hide tools" : "Map tools"}
          </button>
          <div className={`${toolsOpen ? "flex" : "hidden"} md:flex flex-wrap items-center gap-2`}>
          <h1 className="text-accent-gold mr-1">Realm map</h1>
          <button type="button" className="btn btn-secondary text-base min-h-11 min-w-11 px-3 py-2" onClick={() => zoomAt(
            (viewportRef.current?.getBoundingClientRect().left || 0) + frame.w / 2,
            (viewportRef.current?.getBoundingClientRect().top || 0) + frame.h / 2,
            scale * 1.2
          )}>+</button>
          <button type="button" className="btn btn-secondary text-base min-h-11 min-w-11 px-3 py-2" onClick={() => zoomAt(
            (viewportRef.current?.getBoundingClientRect().left || 0) + frame.w / 2,
            (viewportRef.current?.getBoundingClientRect().top || 0) + frame.h / 2,
            scale / 1.2
          )}>−</button>
          <button type="button" className="btn btn-secondary text-sm min-h-11 px-3 py-2" onClick={resetView}>Fit</button>
          <label className="flex items-center gap-2 text-sm font-bold min-h-11">
            <input type="checkbox" className="w-5 h-5" checked={showTreaties} onChange={(event) => setShowTreaties(event.target.checked)} />
            Show treaties
          </label>
          {canEdit && (
            <button type="button" className={`text-sm min-h-11 px-3 py-2 ${adding ? "btn" : "btn btn-secondary"}`} onClick={() => { setAdding((value) => !value); setDraft(null); }}>
              {adding ? "Tap the map" : "Add pin"}
            </button>
          )}
          {canEdit && (
            <label className="btn btn-secondary relative text-sm min-h-11 px-3 py-2">
              Replace map
              <input
                type="file"
                accept="image/*"
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;
                  setBanner(null);
                  setBusy(true);
                  onUpload(file)
                    .then(() => setBanner({ tone: "ok", text: "Map image saved." }))
                    .catch((error) => setBanner({ tone: "error", text: actionError(error, UPLOAD_FAILED_MESSAGE) }))
                    .finally(() => setBusy(false));
                }}
              />
            </label>
          )}
          </div>
        </div>
      </div>
      {banner && (
        <p
          className={`absolute left-3 right-3 z-40 glass-panel px-3 py-2 text-sm font-bold sm:right-auto sm:max-w-md ${banner.tone === "error" ? "text-ink" : "text-ink"}`}
          style={{ top: toolbarH + 12 }}
          role={banner.tone === "error" ? "alert" : "status"}
        >
          {banner.text}
        </p>
      )}

      <div
        ref={viewportRef}
        className="realm-map-stage relative h-full overflow-hidden bg-[#f7f6f3] touch-none"
        onPointerDown={(event) => {
          const target = event.target as HTMLElement;
          if (target.closest("[data-popup]")) return;
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
          if (pointers.current.size >= 2) {
            const [a, b] = [...pointers.current.values()];
            pinched.current = true;
            drag.current = null;
            pinDrag.current = null;
            pinchRef.current = {
              distance: Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1),
              scale,
              panX: pan.x,
              panY: pan.y,
            };
          }
          try {
            (event.currentTarget as HTMLDivElement).setPointerCapture(event.pointerId);
          } catch {
            // Pointer capture is unavailable for a synthetic event. The gesture still tracks the points.
          }
          if (pointers.current.size >= 2) return;
          const pinEl = target.closest("[data-pin]") as HTMLElement | null;
          const pinId = pinEl?.dataset.pin;
          if (pinId) {
            if (!canEdit) {
              openPin(pinId, event);
              return;
            }
            pinDrag.current = { id: pinId, moved: false };
            return;
          }
          drag.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y, moved: false };
        }}
        onPointerMove={(event) => {
          if (!pointers.current.has(event.pointerId)) return;
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
          if (pointers.current.size >= 2 && pinchRef.current) {
            const [a, b] = [...pointers.current.values()];
            const rect = viewportRef.current?.getBoundingClientRect();
            if (!rect) return;
            const distance = Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1);
            const next = pinchView({
              startScale: pinchRef.current.scale,
              startPanX: pinchRef.current.panX,
              startPanY: pinchRef.current.panY,
              originX: (a.x + b.x) / 2 - rect.left,
              originY: (a.y + b.y) / 2 - rect.top,
              ratio: distance / pinchRef.current.distance,
            });
            setScale(next.scale);
            setPan({ x: next.panX, y: next.panY });
            return;
          }
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
          pointers.current.delete(event.pointerId);
          if (pointers.current.size < 2) pinchRef.current = null;
          if (pinched.current) {
            drag.current = null;
            pinDrag.current = null;
            if (pointers.current.size === 0) pinched.current = false;
            return;
          }
          if (pinDrag.current) {
            const dragging = pinDrag.current;
            pinDrag.current = null;
            const next = placeNorm(event);
            if (dragging.moved && next) {
              onMovePin(dragging.id, next.nx, next.ny).catch((error) => {
                setBanner({ tone: "error", text: actionError(error, "Could not move that pin.") });
              });
            }
            else if (!dragging.moved) openPin(dragging.id, event);
            return;
          }
          const background = drag.current;
          drag.current = null;
          if (!background || background.moved) return;
          if (!adding) return;
          const next = placeNorm(event);
          if (!next) return;
          const firstCity = cities[0];
          setDraft(next);
          setSelectedPin(null);
          setCityId(firstCity?.id || "");
          setTitle(firstCity?.name || "");
          setDescription("");
          setWikiIds([]);
          setFormError("");
          setBanner(null);
        }}
        onPointerCancel={(event) => {
          pointers.current.delete(event.pointerId);
          pinchRef.current = null;
          drag.current = null;
          pinDrag.current = null;
          if (pointers.current.size === 0) pinched.current = false;
        }}
      >
        <div
          className="realm-map-canvas relative"
          style={{
            width: fitted ? fitted.w : "100%",
            height: fitted ? fitted.h : undefined,
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
            transformOrigin: "0 0",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageUrl}
            alt="Realm map"
            draggable={false}
            onLoad={(event) => setNatural({ w: event.currentTarget.naturalWidth, h: event.currentTarget.naturalHeight })}
            style={fitted ? { width: "100%", height: "100%" } : { width: "100%", height: "auto" }}
            className="block select-none max-w-none pixel-image"
          />
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
              data-pin={pin.id}
              title={pin.title}
              aria-label={pin.title}
              className="absolute z-10 w-11 h-11 -translate-x-1/2 -translate-y-1/2"
              style={{ left: `${pin.nx * 100}%`, top: `${pin.ny * 100}%` }}
            >
              <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-4 h-4 bg-accent-yellow border-2 border-on-yellow pointer-events-none" />
              <span className="absolute left-1/2 top-full -translate-x-1/2 mt-0.5 max-w-[7.5rem] truncate border-2 border-ink bg-white px-1 text-[10px] font-bold leading-tight text-ink pointer-events-none">
                {pin.title}
              </span>
            </button>
          ))}
          {draft && (
            <span
              data-draft-pin=""
              className="absolute z-20 pointer-events-none"
              style={{ left: `${draft.nx * 100}%`, top: `${draft.ny * 100}%`, transform: "translate(-50%, -50%)" }}
            >
              <span className="block h-6 w-6 border-[3px] border-ink bg-accent-cyan shadow-[3px_3px_0_#fed83d]" />
              <span className="absolute left-1/2 top-full mt-1 -translate-x-1/2 whitespace-nowrap border-2 border-ink bg-accent-yellow px-1 text-[10px] font-bold leading-tight text-on-yellow">
                New pin
              </span>
            </span>
          )}
        </div>

        {popupAt && selectedPin && (
          <PinPopup
            pin={livePins.find((pin) => pin.id === selectedPin) || null}
            city={cityById.get(livePins.find((pin) => pin.id === selectedPin)?.cityId || "")}
            wikiEntries={wikiEntries.filter((entry) => (livePins.find((pin) => pin.id === selectedPin)?.wikiEntryIds || []).includes(entry.id))}
            at={popupAt}
            frame={frame}
            sheet={narrow}
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
                setBanner({ tone: "ok", text: "Pin saved." });
              } catch (error) {
                const message = actionError(error, "Could not save that pin.");
                setFormError(message);
                setBanner({ tone: "error", text: message });
              } finally {
                setBusy(false);
              }
            }}
            onDelete={async () => {
              if (!selectedPin) return;
              setBusy(true);
              try {
                await onDeletePin(selectedPin);
                setSelectedPin(null);
                setBanner({ tone: "ok", text: "Pin deleted." });
              } catch (error) {
                setBanner({ tone: "error", text: actionError(error, "Could not delete that pin.") });
              } finally {
                setBusy(false);
              }
            }}
          />
        )}
        {popupAt && selectedTreaty && (
          <TreatyPopup
            treaty={treaties.find((treaty) => treaty.id === selectedTreaty) || null}
            cities={cities}
            at={popupAt}
            frame={frame}
            sheet={narrow}
            onClose={() => setSelectedTreaty(null)}
          />
        )}
      </div>

      {showTreaties && !selectedPin && !selectedTreaty && !draft && (
        <div className={`absolute z-30 glass-panel p-3 overflow-y-auto ${narrow ? "bottom-2 left-2 right-2 max-h-36" : "bottom-3 left-3 max-w-lg"}`}>
          <h2 className="mb-2">Treaty legend</h2>
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
                    <span className="inline-block w-4 h-2" style={{ background: treaty.color }} />
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
          data-popup
          className={narrow
            ? "absolute left-2 right-2 bottom-2 z-30 glass-panel p-4 space-y-3 max-h-[70%] overflow-y-auto"
            : "absolute top-16 right-3 z-30 w-[min(22rem,calc(100%-1.5rem))] glass-panel p-4 space-y-3 max-h-[calc(100%-5rem)] overflow-y-auto"}
          onSubmit={async (event) => {
            event.preventDefault();
            const city = cityById.get(cityId);
            if (!city) {
              setFormError("Choose a city for this pin.");
              return;
            }
            if (!title.trim()) {
              setFormError("Give the pin a title.");
              return;
            }
            setBusy(true);
            setFormError("");
            try {
              await onAddPin({
                title: title.trim(),
                note: description.trim(),
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
              setBanner({ tone: "ok", text: "Pin saved." });
            } catch (error) {
              const message = actionError(error, "Could not save that pin.");
              setFormError(message);
              setBanner({ tone: "error", text: message });
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="flex justify-between gap-2">
            <h2>Define this pin</h2>
            <button type="button" className="menu-button shrink-0" onClick={() => setDraft(null)} aria-label="Close">×</button>
          </div>
          <p className="text-sm text-text-muted">Nothing is stored until you save.</p>
          <label className="form-label" htmlFor="pin-city">City</label>
          <select id="pin-city" className="form-input" value={cityId} onChange={(event) => {
            const next = event.target.value;
            setCityId(next);
            const city = cityById.get(next);
            if (!title.trim() && city) setTitle(city.name);
          }} required>
            {cities.map((city) => <option key={city.id} value={city.id}>{city.name}</option>)}
          </select>
          <label className="form-label" htmlFor="pin-title">Title</label>
          <input id="pin-title" className="form-input" value={title} onChange={(event) => setTitle(event.target.value)} required />
          <label className="form-label" htmlFor="pin-description">Description</label>
          <textarea id="pin-description" className="form-input" rows={3} value={description} onChange={(event) => setDescription(event.target.value)} />
          <WikiPicker entries={wikiEntries} selected={wikiIds} onChange={setWikiIds} />
          {formError && <p className="text-sm font-bold" role="alert">{formError}</p>}
          <SubmitButton busy={busy} busyLabel="Saving…" className="btn text-sm px-4 py-2">Save pin</SubmitButton>
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
      <legend className="form-label">Linked wiki</legend>
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

function sheetStyle(sheet: boolean, at: { x: number; y: number }, frame: { w: number; h: number }) {
  if (sheet || !frame.w || !frame.h) return undefined;
  const placed = popupPosition({ x: at.x, y: at.y, frameW: frame.w, frameH: frame.h, popupW: 288, popupH: 280 });
  return { left: placed.x, top: placed.y, width: placed.width };
}

function PinPopup({
  pin,
  city,
  wikiEntries,
  at,
  frame,
  sheet,
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
  frame: { w: number; h: number };
  sheet: boolean;
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
    <div
      data-popup
      className={sheet ? "absolute z-20 left-2 right-2 bottom-2 max-h-[70%] overflow-y-auto glass-panel p-4" : "absolute z-20 glass-panel p-4 max-h-[70%] overflow-y-auto"}
      style={sheetStyle(sheet, at, frame)}
    >
      <div className="flex justify-between gap-2 items-start">
        <h3 className="min-w-0">{shown?.name || pin.title}</h3>
        <button type="button" className="menu-button shrink-0" onClick={onClose} aria-label="Close">×</button>
      </div>
      {shown?.sigilUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={shown.sigilUrl} alt="" className="w-12 h-12 border-2 border-ink object-cover my-2" />
      ) : (
        <div className="w-12 h-12 my-2 flex items-center justify-center font-bold" style={{ background: shown?.colors?.primary || "#169C9C", color: "#1c1917" }}>
          {(shown?.name || pin.title).charAt(0)}
        </div>
      )}
      <p className="text-sm text-text-muted line-clamp-3">{pin.note || shown?.bio || shown?.description || "No description yet."}</p>
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
        <div className="mt-3 space-y-2 border-t border-ink pt-3">
          <select className="form-input" value={cityId} onChange={(event) => onCityId(event.target.value)}>
            {cities.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <WikiPicker entries={allWiki} selected={wikiIds} onChange={onWikiIds} />
          <div className="flex gap-2">
            <SubmitButton type="button" busy={busy} busyLabel="Saving…" className="btn text-sm px-3 py-1.5" onClick={() => onSave()}>Save</SubmitButton>
            <button type="button" className="btn btn-danger text-sm px-3 py-1.5" disabled={busy} onClick={() => onDelete()}>Delete</button>
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
  frame,
  sheet,
  onClose,
}: {
  treaty: StoredTreaty | null;
  cities: Faction[];
  at: { x: number; y: number };
  frame: { w: number; h: number };
  sheet: boolean;
  onClose: () => void;
}) {
  if (!treaty) return null;
  const parties = treaty.partyCityIds.map((id) => cities.find((city) => city.id === id)?.name || "City");
  return (
    <div
      data-popup
      className={sheet ? "absolute z-20 left-2 right-2 bottom-2 max-h-[60%] overflow-y-auto glass-panel p-4" : "absolute z-20 glass-panel p-4 max-h-[70%] overflow-y-auto"}
      style={sheetStyle(sheet, at, frame)}
    >
      <div className="flex justify-between gap-2 items-start">
        <h3 className="min-w-0">{treaty.name}</h3>
        <button type="button" className="menu-button shrink-0" onClick={onClose} aria-label="Close">×</button>
      </div>
      <p className="text-sm mt-1">{parties.join(", ")}</p>
      <p className="text-sm text-text-muted mt-2">{treaty.purpose}</p>
      <Link className="text-accent-gold text-sm font-bold" href={`/treaties/${treaty.id}`}>Treaty page</Link>
    </div>
  );
}
