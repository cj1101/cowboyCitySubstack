"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import type { CityBorder, Faction, MapPin, MapPoint, PinCategory, WikiEntry } from "@/lib/types";
import { PIN_CATEGORIES, PIN_CATEGORY_LABELS } from "@/lib/types";
import type { StoredTreaty } from "@/lib/firestore/treaties";
import { actionError } from "@/lib/async";
import { UPLOAD_FAILED_MESSAGE } from "@/lib/images";
import { clamp, pinchView, popupPosition } from "@/lib/maps/gestures";
import { pinCategoryOf } from "@/lib/maps/pins";
import { centroid, cleanPoints, frameView } from "@/lib/maps/territory";
import { PinMark } from "@/components/maps/PinMark";
import { SubmitButton } from "@/components/ui/SubmitButton";

type DraftPin = { nx: number; ny: number };
type PinFilter = "all" | PinCategory;
type DrawState = { cityId: string; points: MapPoint[]; past: MapPoint[][] };

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

function polygonPoints(points: MapPoint[]) {
  return points.map((point) => `${point.nx * 100},${point.ny * 100}`).join(" ");
}

function cityColor(city: Faction | undefined) {
  return city?.colors?.primary || "#169C9C";
}

export function RealmMap({
  imageUrl,
  pins,
  cities,
  wikiEntries,
  treaties,
  borders,
  canEdit,
  ownedCityIds,
  myCityIds,
  onUpload,
  onAddPin,
  onMovePin,
  onUpdatePin,
  onDeletePin,
  onSaveBorder,
  onDeleteBorder,
}: {
  imageUrl: string;
  pins: MapPin[];
  cities: Faction[];
  wikiEntries: WikiEntry[];
  treaties: StoredTreaty[];
  borders: CityBorder[];
  canEdit: boolean;
  ownedCityIds: string[];
  myCityIds: string[];
  onUpload: (file: File) => Promise<void>;
  onAddPin: (pin: Omit<MapPin, "id">) => Promise<void>;
  onMovePin: (pinId: string, nx: number, ny: number) => Promise<void>;
  onUpdatePin: (pinId: string, patch: Partial<MapPin>) => Promise<void>;
  onDeletePin: (pinId: string) => Promise<void>;
  onSaveBorder: (cityId: string, points: MapPoint[]) => Promise<void>;
  onDeleteBorder: (cityId: string) => Promise<void>;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [frame, setFrame] = useState({ w: 0, h: 0 });
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [showTreaties, setShowTreaties] = useState(false);
  const [showBorders, setShowBorders] = useState(true);
  const [pinFilter, setPinFilter] = useState<PinFilter>("all");
  const [hiddenTreaties, setHiddenTreaties] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<DraftPin | null>(null);
  const [drawing, setDrawing] = useState<DrawState | null>(null);
  const [selectedPin, setSelectedPin] = useState<string | null>(null);
  const [selectedTreaty, setSelectedTreaty] = useState<string | null>(null);
  const [selectedCity, setSelectedCity] = useState<string | null>(null);
  const [popupAt, setPopupAt] = useState<{ x: number; y: number } | null>(null);
  const [uploadError, setUploadError] = useState("");
  const [notice, setNotice] = useState("");
  const [formError, setFormError] = useState("");
  const [cityId, setCityId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<PinCategory>("capital");
  const [wikiIds, setWikiIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [borderBusy, setBorderBusy] = useState<"save" | "delete" | null>(null);
  const drag = useRef<{ x: number; y: number; panX: number; panY: number; moved: boolean } | null>(null);
  const pinDrag = useRef<{ id: string; moved: boolean } | null>(null);
  const vertexDrag = useRef<{ index: number; moved: boolean; before: MapPoint[] } | null>(null);
  const pressTarget = useRef<{ territory: string; treaty: string } | null>(null);
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
  const editableCities = useMemo(
    () => cities.filter((city) => canEdit || ownedCityIds.includes(city.id)),
    [cities, canEdit, ownedCityIds]
  );
  const visibleTreaties = treaties.filter((treaty) => !hiddenTreaties.includes(treaty.id));
  const shownPins = livePins.filter((pin) => pinFilter === "all" || pinCategoryOf(pin.category) === pinFilter);
  const shownBorders = borders.filter((border) => showBorders && border.cityId !== drawing?.cityId);
  const pinForCity = (id: string) => livePins.find((pin) => pin.cityId === id);
  const savedBorder = drawing ? borders.find((border) => border.cityId === drawing.cityId) : undefined;

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

  const centerOf = () => {
    const rect = viewportRef.current?.getBoundingClientRect();
    return {
      x: (rect?.left || 0) + frame.w / 2,
      y: (rect?.top || 0) + frame.h / 2,
    };
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

  const placePopup = (event: { clientX: number; clientY: number }) => {
    const viewport = viewportRef.current?.getBoundingClientRect();
    if (!viewport) return;
    setPopupAt({ x: event.clientX - viewport.left + 8, y: event.clientY - viewport.top + 8 });
  };

  const openPin = (pinId: string, event: { clientX: number; clientY: number }) => {
    setSelectedTreaty(null);
    setSelectedCity(null);
    setDraft(null);
    setSelectedPin(pinId);
    placePopup(event);
    const pin = livePins.find((item) => item.id === pinId);
    setCityId(pin?.cityId || "");
    setWikiIds(pin?.wikiEntryIds || []);
    setCategory(pinCategoryOf(pin?.category));
  };

  const openCity = (nextCityId: string, event?: { clientX: number; clientY: number }) => {
    setSelectedPin(null);
    setSelectedTreaty(null);
    setDraft(null);
    setSelectedCity(nextCityId);
    if (event) placePopup(event);
    else if (fitted) {
      const border = borders.find((item) => item.cityId === nextCityId);
      const point = border ? centroid(border.points) : { nx: 0.5, ny: 0.5 };
      setPopupAt({
        x: pan.x + point.nx * fitted.w * scale,
        y: pan.y + point.ny * fitted.h * scale,
      });
    } else {
      setPopupAt({ x: 24, y: 24 });
    }
  };

  const openTreaty = (treatyId: string, event: { clientX: number; clientY: number }) => {
    setSelectedPin(null);
    setSelectedCity(null);
    setSelectedTreaty(treatyId);
    placePopup(event);
  };

  const startDraw = (nextCityId: string) => {
    const existing = borders.find((border) => border.cityId === nextCityId);
    setDrawing({
      cityId: nextCityId,
      points: existing ? existing.points.map((point) => ({ ...point })) : [],
      past: [],
    });
    setAdding(false);
    setDraft(null);
    setSelectedPin(null);
    setSelectedCity(null);
    setSelectedTreaty(null);
    setFormError("");
    setNotice("");
  };

  const beginDraw = () => {
    const preferred = myCityIds.find((id) => editableCities.some((city) => city.id === id)) || editableCities[0]?.id;
    if (!preferred) {
      setNotice("");
      setFormError("You can only draw a border for a city you own.");
      return;
    }
    startDraw(preferred);
  };

  const jumpToCity = () => {
    if (!fitted) {
      setNotice("");
      setFormError("The map is still loading.");
      return;
    }
    const located = myCityIds.find((id) =>
      borders.some((border) => border.cityId === id) || livePins.some((pin) => pin.cityId === id)
    );
    if (!located) {
      setNotice("");
      setFormError(myCityIds.length ? "Your city is not on the map yet." : "You don't have a city to jump to.");
      return;
    }
    const cityPins = livePins.filter((pin) => pin.cityId === located);
    const capital = cityPins.find((pin) => pin.category === "capital");
    const border = borders.find((item) => item.cityId === located);
    const points = capital
      ? [{ nx: capital.nx, ny: capital.ny }]
      : cityPins[0]
        ? [{ nx: cityPins[0].nx, ny: cityPins[0].ny }]
        : border?.points || [];
    if (points.length === 0) {
      setNotice("");
      setFormError("Your city is not on the map yet.");
      return;
    }
    const view = frameView({
      points,
      frameW: frame.w,
      frameH: frame.h,
      imageW: fitted.w,
      imageH: fitted.h,
    });
    setScale(view.scale);
    setPan({ x: view.panX, y: view.panY });
    setFormError("");
    setNotice(`Showing ${cityById.get(located)?.name || "your city"}.`);
  };

  const addCorner = (point: MapPoint) => {
    setDrawing((current) => {
      if (!current) return current;
      if (current.points.length >= 64) return current;
      return { ...current, past: [...current.past, current.points], points: [...current.points, point] };
    });
    setFormError("");
  };

  const undoCorner = () => {
    if (!drawing || drawing.past.length === 0) {
      setNotice("");
      setFormError("Nothing to undo.");
      return;
    }
    setDrawing((current) => {
      if (!current || current.past.length === 0) return current;
      const past = current.past.slice(0, -1);
      const points = current.past[current.past.length - 1];
      return { ...current, past, points };
    });
    setFormError("");
    setNotice("Undid the last border change.");
  };

  const saveBorder = async () => {
    if (!drawing) return;
    const points = cleanPoints(drawing.points);
    if (points.length < 3) {
      setNotice("");
      setFormError("Add at least three corners.");
      return;
    }
    setBorderBusy("save");
    setFormError("");
    try {
      await onSaveBorder(drawing.cityId, points);
      setDrawing((current) => (current ? { ...current, points, past: [] } : current));
      setNotice("Border saved.");
    } catch (error) {
      setNotice("");
      setFormError(actionError(error, "Could not save that border."));
    } finally {
      setBorderBusy(null);
    }
  };

  const removeBorder = async () => {
    if (!drawing) return;
    setBorderBusy("delete");
    setFormError("");
    try {
      await onDeleteBorder(drawing.cityId);
      setDrawing((current) => (current ? { ...current, points: [], past: [] } : current));
      setNotice("Border deleted.");
    } catch (error) {
      setNotice("");
      setFormError(actionError(error, "Could not delete that border."));
    } finally {
      setBorderBusy(null);
    }
  };

  const banner = uploadError || (draft || drawing ? "" : formError) || notice;
  const drawCity = drawing ? cityById.get(drawing.cityId) : undefined;

  return (
    <div className="relative h-full min-h-0">
      <div className="pointer-events-none absolute top-2 left-2 right-2 z-30 flex flex-col items-start gap-2">
        <div className="pointer-events-auto glass-panel px-2 py-2 flex flex-wrap items-center gap-2 max-w-full">
          <h1 className="text-accent-gold mr-1">Realm map</h1>
          <button type="button" className="btn btn-secondary text-base min-h-11 min-w-11 px-3 py-2" onClick={() => {
            const center = centerOf();
            zoomAt(center.x, center.y, scale * 1.2);
          }}>+</button>
          <button type="button" className="btn btn-secondary text-base min-h-11 min-w-11 px-3 py-2" onClick={() => {
            const center = centerOf();
            zoomAt(center.x, center.y, scale / 1.2);
          }}>−</button>
          <button type="button" className="btn btn-secondary text-sm min-h-11 px-3 py-2" onClick={resetView}>Fit</button>
          <label className="flex items-center gap-2 text-sm font-bold min-h-11">
            <input type="checkbox" className="w-5 h-5" checked={showBorders} onChange={(event) => setShowBorders(event.target.checked)} />
            Borders
          </label>
          <label className="flex items-center gap-2 text-sm font-bold min-h-11">
            <input type="checkbox" className="w-5 h-5" checked={showTreaties} onChange={(event) => setShowTreaties(event.target.checked)} />
            Show treaties
          </label>
          <button type="button" className="btn btn-secondary text-sm min-h-11 px-3 py-2" onClick={jumpToCity}>Jump to my city</button>
          {canEdit && (
            <button type="button" className={`text-sm min-h-11 px-3 py-2 ${adding ? "btn" : "btn btn-secondary"}`} onClick={() => {
              setAdding((value) => !value);
              setDraft(null);
              setDrawing(null);
            }}>
              {adding ? "Tap the map" : "Add pin"}
            </button>
          )}
          {editableCities.length > 0 && (
            <button type="button" className={`text-sm min-h-11 px-3 py-2 ${drawing ? "btn" : "btn btn-secondary"}`} onClick={() => {
              if (drawing) {
                if (drawing.past.length) setNotice("Closed without saving.");
                setDrawing(null);
                setFormError("");
                return;
              }
              beginDraw();
            }}>
              {drawing ? "Close border" : "Draw border"}
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
                  setUploadError("");
                  setBusy(true);
                  onUpload(file)
                    .then(() => setNotice("Map image saved."))
                    .catch(() => setUploadError(UPLOAD_FAILED_MESSAGE))
                    .finally(() => setBusy(false));
                }}
              />
            </label>
          )}
        </div>
        <div className="pointer-events-auto glass-panel px-2 py-2 flex flex-wrap items-center gap-2 max-w-full" role="group" aria-label="Pin categories">
          <span className="text-sm font-bold">Pins</span>
          <FilterButton pressed={pinFilter === "all"} label="All" onClick={() => setPinFilter("all")} />
          {PIN_CATEGORIES.map((item) => (
            <FilterButton
              key={item}
              pressed={pinFilter === item}
              label={PIN_CATEGORY_LABELS[item]}
              onClick={() => setPinFilter(item)}
            >
              <PinMark category={item} size={18} />
            </FilterButton>
          ))}
        </div>
        {banner && (
          <p className={`pointer-events-auto glass-panel px-3 py-2 text-sm font-bold max-w-full ${uploadError || formError ? "" : "text-ink"}`} role={uploadError || formError ? "alert" : "status"}>
            {banner}
          </p>
        )}
      </div>

      <div
        ref={viewportRef}
        className={`realm-map-stage relative h-full overflow-hidden bg-[#f7f6f3] touch-none ${drawing ? "cursor-crosshair" : ""}`}
        onPointerDown={(event) => {
          const target = event.target as HTMLElement;
          if (target.closest("[data-popup]")) return;
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
          if (pointers.current.size >= 2) {
            const [a, b] = [...pointers.current.values()];
            pinched.current = true;
            drag.current = null;
            pinDrag.current = null;
            vertexDrag.current = null;
            pressTarget.current = null;
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
          const vertexEl = target.closest("[data-vertex]") as HTMLElement | null;
          if (vertexEl && drawing) {
            const index = Number(vertexEl.dataset.vertex);
            if (Number.isInteger(index)) {
              vertexDrag.current = { index, moved: false, before: drawing.points.map((point) => ({ ...point })) };
            }
            return;
          }
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
          pressTarget.current = {
            territory: (target.closest("[data-territory]") as HTMLElement | null)?.dataset.territory || "",
            treaty: (target.closest("[data-treaty]") as HTMLElement | null)?.dataset.treaty || "",
          };
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
          if (vertexDrag.current && drawing) {
            const next = placeNorm(event);
            if (!next) return;
            const index = vertexDrag.current.index;
            vertexDrag.current.moved = true;
            setDrawing((current) => {
              if (!current) return current;
              return {
                ...current,
                points: current.points.map((point, pointIndex) => (pointIndex === index ? next : point)),
              };
            });
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
          const slop = drawing ? 10 : 4;
          if (Math.hypot(dx, dy) > slop) drag.current.moved = true;
          if (drag.current.moved) setPan({ x: drag.current.panX + dx, y: drag.current.panY + dy });
        }}
        onPointerUp={(event) => {
          pointers.current.delete(event.pointerId);
          if (pointers.current.size < 2) pinchRef.current = null;
          if (pinched.current) {
            drag.current = null;
            pinDrag.current = null;
            vertexDrag.current = null;
            pressTarget.current = null;
            if (pointers.current.size === 0) pinched.current = false;
            return;
          }
          if (vertexDrag.current) {
            const draggingVertex = vertexDrag.current;
            vertexDrag.current = null;
            if (draggingVertex.moved) {
              setDrawing((current) => (
                current ? { ...current, past: [...current.past, draggingVertex.before] } : current
              ));
              setNotice("");
              setFormError("");
            }
            return;
          }
          if (pinDrag.current) {
            const dragging = pinDrag.current;
            pinDrag.current = null;
            const next = placeNorm(event);
            if (dragging.moved && next) {
              onMovePin(dragging.id, next.nx, next.ny)
                .then(() => {
                  setFormError("");
                  setNotice("Pin moved.");
                })
                .catch((error) => {
                  setNotice("");
                  setFormError(actionError(error, "Could not save that pin."));
                });
            } else if (!dragging.moved) openPin(dragging.id, event);
            return;
          }
          const background = drag.current;
          const pressed = pressTarget.current;
          drag.current = null;
          pressTarget.current = null;
          if (!background || background.moved) return;
          if (drawing) {
            if (drawing.points.length >= 64) {
              setNotice("");
              setFormError("A border can have at most 64 corners.");
              return;
            }
            const next = placeNorm(event);
            if (next) addCorner(next);
            return;
          }
          if (adding) {
            const next = placeNorm(event);
            if (!next) return;
            const firstCity = cities[0];
            setDraft(next);
            setSelectedPin(null);
            setSelectedCity(null);
            setCityId(firstCity?.id || "");
            setTitle(firstCity?.name || "");
            setDescription("");
            setCategory("capital");
            setWikiIds([]);
            setFormError("");
            setNotice("");
            return;
          }
          if (pressed?.treaty) {
            openTreaty(pressed.treaty, event);
            return;
          }
          if (pressed?.territory) openCity(pressed.territory, event);
        }}
        onPointerCancel={(event) => {
          pointers.current.delete(event.pointerId);
          pinchRef.current = null;
          drag.current = null;
          pinDrag.current = null;
          pressTarget.current = null;
          if (vertexDrag.current) {
            const before = vertexDrag.current.before;
            vertexDrag.current = null;
            setDrawing((current) => (current ? { ...current, points: before } : current));
          }
          if (pointers.current.size === 0) pinched.current = false;
        }}
      >
        <div className="realm-map-canvas" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`, transformOrigin: "0 0" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageUrl}
            alt="Realm map"
            draggable={false}
            onLoad={(event) => setNatural({ w: event.currentTarget.naturalWidth, h: event.currentTarget.naturalHeight })}
            style={fitted ? { width: fitted.w, height: fitted.h } : { width: "100%", height: "auto" }}
            className="block select-none max-w-none pixel-image"
          />
          {(showBorders || drawing) && (
            <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" style={{ pointerEvents: "none" }}>
              {shownBorders.map((border) => {
                const city = cityById.get(border.cityId);
                const color = cityColor(city);
                const points = polygonPoints(border.points);
                return (
                  <g key={border.cityId}>
                    <polygon
                      data-territory={border.cityId}
                      points={points}
                      fill={color}
                      fillOpacity={0.34}
                      stroke="#1c1917"
                      strokeWidth={3.5}
                      vectorEffect="non-scaling-stroke"
                      style={{ pointerEvents: drawing ? "none" : "auto" }}
                      role="button"
                      tabIndex={drawing ? -1 : 0}
                      aria-label={`${city?.name || "City"} territory`}
                      className="cursor-pointer"
                      onKeyDown={(event) => {
                        if (drawing) return;
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          openCity(border.cityId);
                        }
                      }}
                    >
                      <title>{city?.name || "City"}</title>
                    </polygon>
                    <polygon points={points} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" style={{ pointerEvents: "none" }} />
                  </g>
                );
              })}
              {drawing && drawing.points.length >= 2 && (
                drawing.points.length >= 3 ? (
                  <polygon
                    points={polygonPoints(drawing.points)}
                    fill={cityColor(drawCity)}
                    fillOpacity={0.34}
                    stroke="#1c1917"
                    strokeWidth={3.5}
                    vectorEffect="non-scaling-stroke"
                  />
                ) : (
                  <polyline
                    points={polygonPoints(drawing.points)}
                    fill="none"
                    stroke="#1c1917"
                    strokeWidth={3.5}
                    vectorEffect="non-scaling-stroke"
                  />
                )
              )}
              {drawing && drawing.points.length >= 3 && (
                <polygon
                  points={polygonPoints(drawing.points)}
                  fill="none"
                  stroke={cityColor(drawCity)}
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </svg>
          )}
          {showTreaties && (
            <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none" style={{ pointerEvents: "none" }}>
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
                    data-treaty={treaty.id}
                    points={path}
                    fill={points.length >= 3 ? treaty.color : "none"}
                    fillOpacity={points.length >= 3 ? 0.12 : 0}
                    stroke={treaty.color}
                    strokeWidth={1.4}
                    vectorEffect="non-scaling-stroke"
                    style={{ pointerEvents: drawing ? "none" : "auto" }}
                    className="cursor-pointer"
                  >
                    <title>{treaty.name}</title>
                  </polyline>
                );
              })}
            </svg>
          )}
          {shownPins.map((pin) => (
            <button
              key={pin.id}
              type="button"
              data-pin={pin.id}
              title={`${pin.title} (${PIN_CATEGORY_LABELS[pinCategoryOf(pin.category)]})`}
              aria-label={`${pin.title}, ${PIN_CATEGORY_LABELS[pinCategoryOf(pin.category)]}`}
              className="absolute w-11 h-11 -translate-x-1/2 -translate-y-1/2 flex items-center justify-center"
              style={{ left: `${pin.nx * 100}%`, top: `${pin.ny * 100}%` }}
            >
              <PinMark category={pinCategoryOf(pin.category)} />
            </button>
          ))}
          {draft && (
            <span className="absolute w-4 h-4 -ml-2 -mt-2 bg-accent-cyan border-2 border-on-yellow" style={{ left: `${draft.nx * 100}%`, top: `${draft.ny * 100}%` }} />
          )}
          {drawing?.points.map((point, index) => (
            <button
              key={`${drawing.cityId}-${index}`}
              type="button"
              data-vertex={index}
              aria-label={`Corner ${index + 1}. Drag to move it.`}
              className="absolute w-11 h-11 -translate-x-1/2 -translate-y-1/2 flex items-center justify-center"
              style={{ left: `${point.nx * 100}%`, top: `${point.ny * 100}%` }}
            >
              <span className="w-3 h-3 border-2 border-on-yellow" style={{ background: cityColor(drawCity) }} />
            </button>
          ))}
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
            category={category}
            wikiIds={wikiIds}
            busy={busy}
            onClose={() => setSelectedPin(null)}
            onCityId={setCityId}
            onCategory={setCategory}
            onWikiIds={setWikiIds}
            onSave={async () => {
              if (!selectedPin) return;
              setBusy(true);
              setFormError("");
              try {
                const city = cityById.get(cityId);
                await onUpdatePin(selectedPin, {
                  cityId,
                  title: city?.name || "Pin",
                  category,
                  wikiEntryIds: wikiIds,
                  wikiEntryId: wikiIds[0] || null,
                });
                setNotice("Pin saved.");
              } catch (error) {
                setNotice("");
                setFormError(actionError(error, "Could not save that pin."));
              } finally {
                setBusy(false);
              }
            }}
            onDelete={async () => {
              if (!selectedPin) return;
              setBusy(true);
              setFormError("");
              try {
                await onDeletePin(selectedPin);
                setSelectedPin(null);
                setNotice("Pin deleted.");
              } catch (error) {
                setNotice("");
                setFormError(actionError(error, "Could not delete that pin."));
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
        {popupAt && selectedCity && (
          <CityPopup
            city={cityById.get(selectedCity)}
            at={popupAt}
            frame={frame}
            sheet={narrow}
            canDraw={editableCities.some((city) => city.id === selectedCity)}
            onClose={() => setSelectedCity(null)}
            onDraw={() => startDraw(selectedCity)}
          />
        )}
      </div>

      {showTreaties && !selectedPin && !selectedTreaty && !selectedCity && !draft && !drawing && (
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

      {drawing && (
        <div
          data-popup
          className={narrow
            ? "absolute left-2 right-2 bottom-2 z-30 glass-panel p-3 space-y-2 max-h-[46%] overflow-y-auto"
            : "absolute bottom-3 left-3 z-30 w-[min(24rem,calc(100%-1.5rem))] glass-panel p-3 space-y-2"}
        >
          <div className="flex justify-between gap-2 items-start">
            <h2>Draw {drawCity?.name || "city"} border</h2>
            <button type="button" className="menu-button shrink-0" aria-label="Close border drawing" onClick={() => {
              if (drawing.past.length) setNotice("Closed without saving.");
              setDrawing(null);
              setFormError("");
            }}>×</button>
          </div>
          <p className="text-sm text-text-muted">Tap the map to add a corner. Drag a corner to move it.</p>
          {editableCities.length > 1 && (
            <label className="block text-sm font-bold">
              City
              <select
                className="form-input mt-1"
                value={drawing.cityId}
                onChange={(event) => {
                  if (drawing.past.length > 0) {
                    setNotice("");
                    setFormError("Save or close this border before switching cities.");
                    return;
                  }
                  startDraw(event.target.value);
                }}
              >
                {editableCities.map((city) => <option key={city.id} value={city.id}>{city.name}</option>)}
              </select>
            </label>
          )}
          <p className="text-sm">{drawing.points.length} {drawing.points.length === 1 ? "corner" : "corners"}</p>
          {formError && <p className="text-sm font-bold" role="alert">{formError}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-secondary text-sm min-h-11 px-3 py-2" onClick={undoCorner} disabled={borderBusy !== null}>Undo</button>
            <SubmitButton type="button" busy={borderBusy === "save"} busyLabel="Saving…" className="btn text-sm min-h-11 px-3 py-2" disabled={borderBusy !== null} onClick={() => saveBorder()}>Save border</SubmitButton>
            {savedBorder && (
              <button type="button" className="btn btn-danger text-sm min-h-11 px-3 py-2" disabled={borderBusy !== null} aria-busy={borderBusy === "delete"} onClick={() => removeBorder()}>
                {borderBusy === "delete" ? "Deleting…" : "Delete border"}
              </button>
            )}
          </div>
        </div>
      )}

      {canEdit && draft && (
        <form
          data-popup
          className={narrow
            ? "absolute left-2 right-2 bottom-2 z-30 glass-panel p-4 space-y-3 max-h-[70%] overflow-y-auto"
            : "absolute top-44 right-3 z-30 w-[min(22rem,calc(100%-1.5rem))] glass-panel p-4 space-y-3 max-h-[calc(100%-12rem)] overflow-y-auto"}
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
                category,
                wikiEntryIds: wikiIds,
                wikiEntryId: wikiIds[0] || null,
                postId: null,
                x: null,
                z: null,
              });
              setDraft(null);
              setAdding(false);
              setWikiIds([]);
              setNotice("Pin saved.");
            } catch (error) {
              setNotice("");
              setFormError(actionError(error, "Could not save that pin."));
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
          <CategoryField id="pin-category" value={category} onChange={setCategory} />
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

function FilterButton({
  pressed,
  label,
  onClick,
  children,
}: {
  pressed: boolean;
  label: string;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      className={`${pressed ? "btn" : "btn btn-secondary"} text-sm min-h-11 px-2 py-1 inline-flex items-center gap-1`}
      onClick={onClick}
    >
      {children}
      {label}
    </button>
  );
}

function CategoryField({ id, value, onChange }: { id: string; value: PinCategory; onChange: (category: PinCategory) => void }) {
  return (
    <>
      <label className="form-label" htmlFor={id}>Category</label>
      <select id={id} className="form-input" value={value} onChange={(event) => onChange(pinCategoryOf(event.target.value))}>
        {PIN_CATEGORIES.map((item) => (
          <option key={item} value={item}>{PIN_CATEGORY_LABELS[item]}</option>
        ))}
      </select>
    </>
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
  category,
  wikiIds,
  busy,
  onClose,
  onCityId,
  onCategory,
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
  category: PinCategory;
  wikiIds: string[];
  busy: boolean;
  onClose: () => void;
  onCityId: (id: string) => void;
  onCategory: (category: PinCategory) => void;
  onWikiIds: (ids: string[]) => void;
  onSave: () => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  if (!pin) return null;
  const shown = city || cities.find((item) => item.id === pin.cityId);
  const kind = pinCategoryOf(pin.category);
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
      <p className="text-sm font-bold inline-flex items-center gap-2 mt-1">
        <PinMark category={kind} size={18} />
        {PIN_CATEGORY_LABELS[kind]}
      </p>
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
          <CategoryField id="pin-edit-category" value={category} onChange={onCategory} />
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

function CityPopup({
  city,
  at,
  frame,
  sheet,
  canDraw,
  onClose,
  onDraw,
}: {
  city?: Faction;
  at: { x: number; y: number };
  frame: { w: number; h: number };
  sheet: boolean;
  canDraw: boolean;
  onClose: () => void;
  onDraw: () => void;
}) {
  if (!city) return null;
  return (
    <div
      data-popup
      className={sheet ? "absolute z-20 left-2 right-2 bottom-2 max-h-[60%] overflow-y-auto glass-panel p-4" : "absolute z-20 glass-panel p-4 max-h-[70%] overflow-y-auto"}
      style={sheetStyle(sheet, at, frame)}
    >
      <div className="flex justify-between gap-2 items-start">
        <h3 className="min-w-0">{city.name}</h3>
        <button type="button" className="menu-button shrink-0" onClick={onClose} aria-label="Close">×</button>
      </div>
      {city.sigilUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={city.sigilUrl} alt="" className="w-12 h-12 border-2 border-ink object-cover my-2" />
      ) : (
        <div className="w-12 h-12 my-2 flex items-center justify-center font-bold" style={{ background: cityColor(city), color: "#1c1917" }}>
          {city.name.charAt(0)}
        </div>
      )}
      <p className="text-sm text-text-muted line-clamp-4">{city.bio || city.description || "No description yet."}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Link className="btn btn-secondary text-sm min-h-11 px-3 py-2" href={`/cities/${city.slug}`}>City home</Link>
        {canDraw && (
          <button type="button" className="btn text-sm min-h-11 px-3 py-2" onClick={onDraw}>Edit border</button>
        )}
      </div>
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
