"use client";

/**
 * Take an action — the Phase 3 display-only shell (brief §4.2 #11)
 * made live by the Phase 4 Intake UI assembly (step 2, module a).
 *
 * The panel is a pass-through: it keeps the shell's PanelShell frame
 * and data contract (`ActionBoxData.cities` — the viewer's own cities
 * first, then the shared city) and renders June's live
 * `components/play/ActionBox` inside it. The structured kinds offered
 * are reconciled against the fabric registry at this mount point
 * (brief §2.1: a kind with no registered handler is not offered):
 * `offeredKinds` filters the intake catalog by the registry's live
 * `ACTION_KIND_INDEX` keys. At this step every registered kind is a
 * Phase 2 fixture and the product catalog is empty, so the box offers
 * free text only — entries appear as catalogue steps land, with no
 * further wiring change here.
 *
 * No rules change rides this mount: the landed `sim_actions` clause
 * (Phase 2 §9.4) already fences exactly the intake's two writes —
 * create born-`received` with null lifecycle fields and
 * `actor.memberId == uid`; confirm touching only
 * confirmation/status/updatedAt, from `awaiting_confirmation`, with
 * the confirmation's previewHash bound to the stored preview's.
 * Verified field-by-field against `firestore.rules` at assembly.
 *
 * Members only (registry): guests never receive this panel.
 */

import { useMemo } from "react";
import type { PanelLoadState } from "@/lib/dashboard/registry";
import { ActionBox } from "@/components/play/ActionBox";
import { offeredKinds } from "@/lib/play/kinds";
import { ACTION_KIND_INDEX } from "@/lib/sim/rules/registry";
import { PanelShell } from "../PanelShell";

export interface ActionBoxCity {
  factionId: string;
  name: string;
  /** The shared city (Cowboy City): acting there routes through the
   *  Mayor / Town Hall, not a sole owner (brief §4.3). */
  isShared: boolean;
}

export interface ActionBoxData {
  /** The viewer's own cities first, then the shared city. */
  cities: ActionBoxCity[];
}

export function ActionBoxPanel({
  state,
}: {
  state: PanelLoadState<ActionBoxData>;
}) {
  const data = state.status === "ready" ? state.data : null;
  const kinds = useMemo(
    () => offeredKinds(Object.keys(ACTION_KIND_INDEX)),
    []
  );
  return (
    <PanelShell title="Take an action" state={state}>
      {data ? <ActionBox cities={data.cities} kinds={kinds} /> : null}
    </PanelShell>
  );
}
