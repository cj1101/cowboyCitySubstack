"use client";

/**
 * Situations peek (brief §4.2 #4, P3-D4; spec §5.2.5) — a deliberately
 * small window into the member's own queue. In Phase 3 the data source
 * is the member's existing site `notifications` substrate, mapped by
 * the read path into the shape below; the Phase 5 Situations queue
 * replaces that source with NO registry or component change (the props
 * are the swap contract).
 *
 * Member-only (registry audience), owner-private data. Plain text
 * count, up to 3 top items, link to the full queue. No badge counter,
 * no red dot, no urgency styling (TC-F01). NO export affordance on
 * this panel, ever (plan Phase 3; brief §10.2) — the component accepts
 * no footer slot on purpose.
 */

import type { PanelLoadState } from "@/lib/dashboard/registry";
import { PanelShell } from "../PanelShell";
import Link from "next/link";

export interface SituationsPeekItem {
  id: string;
  title: string;
  cityName: string | null;
  kindLabel: string | null;
  href: string;
}

export interface SituationsPeekData {
  openCount: number;
  topItems: SituationsPeekItem[];
  queueHref: string;
}

export function SituationsPeekPanel({
  state,
  variant,
}: {
  state: PanelLoadState<SituationsPeekData>;
  variant: string;
}) {
  const data = state.status === "ready" ? state.data : null;
  return (
    <PanelShell title="Situations" state={state}>
      {data ? (
        <div className="flex flex-col gap-2 text-sm">
          <p>
            {data.openCount === 0
              ? "No situations waiting on you."
              : `${data.openCount} ${data.openCount === 1 ? "situation" : "situations"} waiting on you.`}
          </p>
          {variant !== "count-only" && data.topItems.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {data.topItems.slice(0, 3).map((item) => (
                <li key={item.id}>
                  <Link href={item.href} className="underline">
                    {item.title}
                  </Link>
                  {item.cityName ? (
                    <span className="text-text-muted"> · {item.cityName}</span>
                  ) : null}
                  {item.kindLabel ? (
                    <span className="text-text-muted"> · {item.kindLabel}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          <Link href={data.queueHref} className="underline">
            Open the full queue
          </Link>
        </div>
      ) : null}
    </PanelShell>
  );
}
