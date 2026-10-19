"use client";

/**
 * NPC teams (brief §4.2 #8, §4.3; spec §5.2.8; R-20) — two tabs inside
 * one panel: "My team" (member) and "Realm teams" (everyone). Phase 3
 * is read-only and definitions-only: no NPC extension exists yet, so
 * honest empty team states are the expected render. Creation and
 * mandate editing are Phase 5 — there is NO Manage link in Phase 3
 * (absent, not dead; spec §5.2.8).
 *
 * Data arrives as props: the read path resolves the panel's single
 * selector over `characters` (brief §4.3) into the shapes below, so
 * Vera's Phase 5 discriminator-vs-collection decision changes that one
 * selector, not this panel.
 *
 * Vocabulary discipline (TC-N07; brief §14 / P3-G7 grep): the realm tab
 * shows exactly two statuses — staffed ("team on duty") and unstaffed
 * ("responds only when its owner acts"). The P3-G7 denylist's four
 * city-status words appear nowhere in this file, comments included.
 * Copy says NPC, never "agent" (R-20). Titles and scopes are freeform
 * owner text, rendered verbatim — never a closed roster (R-20).
 */

import { useState, type ReactNode } from "react";
import Link from "next/link";
import type { PanelLoadState } from "@/lib/dashboard/registry";
import { PanelShell } from "../PanelShell";

export interface NpcTeamCard {
  id: string;
  name: string;
  /** Freeform owner-set title — rendered verbatim (R-20). */
  title: string;
  personalityLine: string | null;
  /** Freeform on-duty scope — rendered verbatim (R-20). */
  scopeLine: string | null;
  /** Bounds in may / may-NOT form (spec §5.2.8 prototype card). */
  mayDo: string[];
  mayNotDo: string[];
  /** Owner-set permission mode label, verbatim. */
  permissionModeLabel: string | null;
}

export interface RealmTeamStatus {
  factionId: string;
  cityName: string;
  cityHref: string;
  teamSize: number;
  /** True = a team exists and is on duty. False = no team: the city
   *  responds only when its owner acts (TC-N07's two statuses only). */
  staffed: boolean;
}

export interface NpcTeamData {
  /** The viewer's own NPCs for their default city. Null for guests —
   *  the "My team" tab is member data and is absent, not disabled
   *  (TC-G03). */
  myTeam: { cityName: string | null; npcs: NpcTeamCard[] } | null;
  realmTeams: RealmTeamStatus[];
}

type TeamTab = "mine" | "realm";

export function NpcTeamPanel({
  state,
  variant,
  footer,
}: {
  state: PanelLoadState<NpcTeamData>;
  /** Registry variant picks the initially shown tab ("mine" default). */
  variant: string;
  footer?: ReactNode;
}) {
  const data = state.status === "ready" ? state.data : null;
  const hasMine = data?.myTeam !== null && data?.myTeam !== undefined;
  const [tab, setTab] = useState<TeamTab>(
    variant === "realm" || !hasMine ? "realm" : "mine",
  );
  const activeTab: TeamTab = !hasMine ? "realm" : tab;
  return (
    <PanelShell title="NPC teams" state={state} footer={footer}>
      {data ? (
        <div className="flex flex-col gap-3 text-sm">
          {hasMine ? (
            <div className="flex gap-2" role="tablist" aria-label="NPC teams">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "mine"}
                className="btn text-sm px-4 py-2 min-h-11"
                onClick={() => setTab("mine")}
              >
                My team
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "realm"}
                className="btn text-sm px-4 py-2 min-h-11"
                onClick={() => setTab("realm")}
              >
                Realm teams
              </button>
            </div>
          ) : null}

          {activeTab === "mine" && data.myTeam ? (
            data.myTeam.npcs.length === 0 ? (
              <p>
                No NPCs on your team yet.
                {data.myTeam.cityName
                  ? ` ${data.myTeam.cityName} responds only when you act until you staff it.`
                  : ""}{" "}
                NPC creation arrives in Phase 5 — your team will manage
                your city on your behalf, inside the bounds you set.
              </p>
            ) : (
              <ul className="flex flex-col gap-3">
                {data.myTeam.npcs.map((npc) => (
                  <li
                    key={npc.id}
                    className="rounded border border-darker-brown bg-glass-bg p-4 flex flex-col gap-1"
                  >
                    <p>
                      <span className="font-bold">{npc.name}</span>
                      <span className="text-text-muted"> · {npc.title}</span>
                    </p>
                    {npc.personalityLine ? <p>{npc.personalityLine}</p> : null}
                    {npc.scopeLine ? (
                      <p>
                        <span className="text-text-muted">On duty for: </span>
                        {npc.scopeLine}
                      </p>
                    ) : null}
                    {npc.mayDo.length > 0 ? (
                      <p>
                        <span className="text-text-muted">May: </span>
                        {npc.mayDo.join("; ")}
                      </p>
                    ) : null}
                    {npc.mayNotDo.length > 0 ? (
                      <p>
                        <span className="text-text-muted">May NOT: </span>
                        {npc.mayNotDo.join("; ")}
                      </p>
                    ) : null}
                    {npc.permissionModeLabel ? (
                      <p className="text-xs text-text-muted">
                        Permission: {npc.permissionModeLabel}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )
          ) : (
            data.realmTeams.length === 0 ? (
              <p>No cities to show yet.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {data.realmTeams.map((team) => (
                  <li key={team.factionId}>
                    <Link href={team.cityHref} className="underline">
                      {team.cityName}
                    </Link>
                    <span className="text-text-muted">
                      {" "}
                      ·{" "}
                      {team.staffed
                        ? `${team.teamSize} ${
                            team.teamSize === 1 ? "NPC" : "NPCs"
                          } — team on duty`
                        : "no team — responds only when its owner acts"}
                    </span>
                  </li>
                ))}
              </ul>
            )
          )}
        </div>
      ) : null}
    </PanelShell>
  );
}
