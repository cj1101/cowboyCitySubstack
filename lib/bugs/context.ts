import type { BugReportSurface } from "@/lib/bugs/types";

/**
 * Automatic context for a bug report (design §2.3). Captured client-side at
 * dialog open, shown to the reporter in the consent block before submit, and
 * attached ONLY if they leave technical details on (RPT-f).
 *
 * Privacy invariants (design §2.4), enforced here by construction:
 * - References only: route, surface, an entity slug/id, the Log position.
 *   Never the data behind them — no sim figures, no post/DM text, nothing
 *   from storage, no credentials (none are read at all).
 * - Browser basics are parsed family strings, never the raw user agent.
 */

export interface CapturedBugContext {
  route: string;
  surface: BugReportSurface;
  entityRef?: string;
  asOfSeq?: number;
  browserFamily: string;
  osFamily: string;
  viewport: { w: number; h: number };
  online: boolean;
  timezone: string;
  clientAt: Date;
}

/**
 * Sim surfaces (Phase 3 dashboard / Log page / entity pages) register the
 * Log sequence they rendered at, so a "this number is wrong" report pins the
 * exact world state the reporter saw. Registration is route-scoped: the
 * value is used only while the dialog opens on the same route that set it.
 * Nothing here ticks or polls — a surface sets its seq when it renders.
 */
let registeredSeq: { route: string; seq: number } | null = null;

export function setBugAsOfSeq(route: string, seq: number | null): void {
  registeredSeq = seq === null ? null : { route, seq };
}

const SIM_SURFACES: BugReportSurface[] = ["dashboard", "city", "log", "market"];

export function surfaceForRoute(pathname: string): BugReportSurface {
  if (pathname === "/") return "dashboard";
  if (pathname.startsWith("/factions/") && pathname.includes("/wiki")) return "wiki";
  if (pathname.startsWith("/factions/")) return "city";
  if (pathname.startsWith("/forum")) return "forum";
  if (pathname.startsWith("/maps")) return "maps";
  return "other";
}

/** Slug/id from route params when on an entity surface — a reference, never content. */
export function entityRefForRoute(pathname: string): string | undefined {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 2) return undefined;
  const [head, ref] = parts;
  if (head === "factions" || head === "posts" || head === "forum" || head === "treaties") {
    return ref.slice(0, 120);
  }
  return undefined;
}

function browserFamily(ua: string): string {
  if (/Edg\//.test(ua)) return "Edge";
  if (/OPR\/|Opera/.test(ua)) return "Opera";
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/Chrome\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua)) return "Safari";
  return "Other";
}

function osFamily(ua: string): string {
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
  if (/Android/.test(ua)) return "Android";
  if (/Windows/.test(ua)) return "Windows";
  if (/Mac OS X|Macintosh/.test(ua)) return "macOS";
  if (/Linux/.test(ua)) return "Linux";
  return "Other";
}

/** Snapshot the context for the page as the reporter sees it right now. */
export function captureBugContext(pathname: string): CapturedBugContext {
  const surface = surfaceForRoute(pathname);
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const context: CapturedBugContext = {
    route: pathname.slice(0, 300),
    surface,
    browserFamily: browserFamily(ua),
    osFamily: osFamily(ua),
    viewport: {
      w: typeof window !== "undefined" ? window.innerWidth : 0,
      h: typeof window !== "undefined" ? window.innerHeight : 0,
    },
    online: typeof navigator !== "undefined" ? navigator.onLine : true,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    clientAt: new Date(),
  };
  const entityRef = entityRefForRoute(pathname);
  if (entityRef) context.entityRef = entityRef;
  // asOfSeq exists only on sim surfaces and only when that surface
  // registered the position it rendered at (RPT-e: absent elsewhere —
  // never 0, never the current head seq).
  if (SIM_SURFACES.includes(surface) && registeredSeq && registeredSeq.route === pathname) {
    context.asOfSeq = registeredSeq.seq;
  }
  return context;
}
