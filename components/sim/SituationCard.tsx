"use client";

/**
 * One situation card (brief §6.2 presentation contract + §6.3's
 * three handling decisions; Petra spec §3). The card always names
 * its city (person-scoped items are badged personal), shows its
 * severity as a plain label that never changes with age, and cites
 * its source in the Log. Unknown kinds render on this same generic
 * card with all three decisions — `kind` is a bounded string, and
 * no kind is special-cased out of a decision.
 *
 * The three decisions (§6.3):
 *  A. Handle it myself — the decision is recorded here; the act
 *     itself happens in the authoritative flow the card deep-links
 *     to. A card button never silently performs the act.
 *  B. Delegate — to one of the owner's NPCs serving this city,
 *     under its standing mandate (authority summary first, then
 *     the §4.3 confirmation card, then the fabric's own preview) or
 *     by one-off envelope (the spawn form, pre-filled with this
 *     situation). A silent-mode NPC refuses the standing path with
 *     the reason stated; the same NPC may still be envelope-tasked
 *     directly (P5-K4).
 *  C. Let it sit — silence as an explicit, first-class decision:
 *     the Log records the non-response as a complete outcome.
 *
 * Terminal cards are read-only history. A card that a delegate
 * escalated returns here with its cycle count showing.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/components/auth/AuthProvider";
import type { SimSituation } from "@/lib/sim/situations";
import type { SimMandateVersion, SimNpc } from "@/lib/npcs/types";
import {
  isHistory,
  kindLabel,
  outcomeLine,
  severityLabel,
  waitingStatusLine,
} from "@/lib/situations/present";
import {
  authoritySummary,
  modeRoutingLine,
  modeShortLabel,
} from "@/lib/npcs/present";
import {
  submitSituationDelegate,
  submitSituationHandle,
  submitSituationSilence,
} from "@/lib/situations/client";
import { ActionRunner } from "./ActionRunner";
import { ConfirmationCard } from "./ConfirmationCard";
import { SpawnNpcForm, type SpawnNpcOption } from "./SpawnNpcForm";

export interface SituationCardProps {
  situation: SimSituation;
  cityName: (cityId: string | null) => string;
  /** City page href for the deep link, when the surface knows it. */
  cityHref?: (cityId: string) => string;
  /** The viewer's NPCs serving this card's audience city. */
  npcsHere: SimNpc[];
  /** Current mandate version per NPC id (null = no mandate). */
  mandateVersionByNpc: Map<string, SimMandateVersion | null>;
  /** Counterparty options for the envelope bounds block. */
  spawnCities: { id: string; name: string }[];
  onChanged?: () => void;
}

function logHref(seq: number | null): string | null {
  return seq !== null ? `/log?anchor=${seq}` : null;
}

/** §6.3A deep links: where the authoritative flow for this kind
 * lives today. Kinds whose flows land in later phases say so on the
 * card rather than pretending a surface exists. */
function handlingLink(
  situation: SimSituation,
  cityHref?: (cityId: string) => string
): { href: string; label: string } | { note: string } {
  const cityId = situation.audienceCityId ?? situation.cityId;
  switch (situation.kind) {
    case "proposal":
    case "counteroffer":
      return { href: "/treaties", label: "Open the deal room" };
    case "incident":
      return cityId && cityHref
        ? { href: cityHref(cityId), label: "Open the city's page" }
        : { note: "Handle this on the city's page." };
    case "ingestion-review":
      return {
        note: "The lore review surface arrives with the lore ingestion build. Recording that you're handling this keeps the matter yours in the meantime.",
      };
    case "election-due":
      return {
        note: "The election flow arrives with the shared-city office build. Recording that you're handling this keeps the matter yours in the meantime.",
      };
    default:
      return {
        note: "There is no separate surface for this kind yet — handling it is recorded here, and the outcome lands in the Log.",
      };
  }
}

export function SituationCard({
  situation,
  cityName,
  cityHref,
  npcsHere,
  mandateVersionByNpc,
  spawnCities,
  onChanged,
}: SituationCardProps) {
  const { user } = useAuth();
  const [showDecisions, setShowDecisions] = useState(false);
  const [note, setNote] = useState("");
  const [pickedNpcId, setPickedNpcId] = useState<string>("");
  const [delegateStage, setDelegateStage] = useState<
    "pick" | "confirm-standing" | "submitted-standing" | "envelope"
  >("pick");

  const cityId = situation.audienceCityId ?? situation.cityId;
  const personal = situation.audienceCityId === null && situation.recipientUid !== null;
  const sourceLogHref = logHref(situation.source.sourceSeq);
  const terminal = isHistory(situation);
  const posture = waitingStatusLine(situation);
  const pickedNpc = npcsHere.find((n) => n.npcId === pickedNpcId) ?? null;
  const pickedVersion = pickedNpc
    ? (mandateVersionByNpc.get(pickedNpc.npcId) ?? null)
    : null;

  const spawnOptions: SpawnNpcOption[] = useMemo(
    () =>
      npcsHere.map((npc) => ({
        npcId: npc.npcId,
        name: npc.displayNameSnapshot,
        title: npc.titleFreeform,
        mode: npc.permissionMode,
        cityId: npc.cityId,
        status: npc.status,
      })),
    [npcsHere]
  );

  const handling = situation.handling;
  const handlingNpc =
    handling?.npcId !== null && handling?.npcId !== undefined
      ? (npcsHere.find((n) => n.npcId === handling.npcId) ?? null)
      : null;

  return (
    <article className="glass-panel p-4 flex flex-col gap-3">
      <header className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-bold uppercase tracking-wide">
          {kindLabel(situation.kind)}
        </span>
        <span className="text-text-muted">{severityLabel(situation.severity)}</span>
        <span className="text-text-muted">·</span>
        <span>{cityName(cityId)}</span>
        {personal && (
          <span className="rounded border border-darker-brown px-1">personal</span>
        )}
        {situation.createdSeq !== null && (
          <span className="text-text-muted">· seq {situation.createdSeq}</span>
        )}
        {sourceLogHref && (
          <Link href={sourceLogHref} className="text-accent-gold underline ml-auto">
            Source in the Log
          </Link>
        )}
      </header>

      <div>
        <h3 className="font-bold">{situation.title}</h3>
        <p className="text-sm mt-1">{situation.summary}</p>
        {situation.detail && Object.keys(situation.detail).length > 0 && (
          <dl className="text-sm text-text-muted mt-2 flex flex-col gap-1">
            {Object.entries(situation.detail).map(([key, value]) => (
              <div key={key} className="flex gap-2">
                <dt className="font-bold">{key}</dt>
                <dd className="break-words">
                  {typeof value === "string" ? value : JSON.stringify(value)}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      {situation.delegationCycleCount > 0 && !terminal && (
        <p className="text-sm text-text-muted">
          This matter came back to your queue after a delegation (cycle{" "}
          {situation.delegationCycleCount}) — the delegate's handling of it is
          in the Log.
        </p>
      )}

      {posture && <p className="text-sm">{posture}</p>}

      {handling && (handling.mode !== null || handling.npcId) && (
        <p className="text-sm text-text-muted">
          {handling.mode === "delegated" || handling.mode === "auto-delegated" ? (
            <>
              Delegated to{" "}
              {handlingNpc
                ? `${handlingNpc.displayNameSnapshot}, for you`
                : `NPC ${handling.npcId ?? ""}`}
              {handling.mandateId
                ? ` under mandate v${handling.mandateVersion ?? "?"}`
                : ""}
              {handling.mode === "auto-delegated" && handling.delegationRuleId
                ? `, by one of your delegation rules (v${handling.delegationRuleVersion ?? "?"})`
                : ""}
              .
            </>
          ) : handling.mode === "self" ? (
            "You are handling this yourself."
          ) : handling.mode === "silent" ? (
            "You chose to let this sit."
          ) : null}
          {handling.decisionNote ? ` Note: ${handling.decisionNote}` : ""}
        </p>
      )}

      {terminal ? (
        <p className="text-sm">
          {outcomeLine(situation, cityName)}
          {situation.resolvedSeq !== null && (
            <>
              {" "}
              <Link
                href={logHref(situation.resolvedSeq) ?? "/log"}
                className="text-accent-gold underline"
              >
                Log seq {situation.resolvedSeq}
              </Link>
            </>
          )}
        </p>
      ) : situation.status === "delegated" ? (
        <p className="text-sm text-text-muted">
          This is with your delegate now. If it escalates, or outgrows the
          mandate it was handed under, the card returns to your queue — the
          return is never silent.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {!showDecisions ? (
            <button
              type="button"
              className="btn min-h-11 self-start"
              onClick={() => setShowDecisions(true)}
            >
              Decide how to handle this
            </button>
          ) : (
            <>
              {/* ——— A. Handle it myself ——— */}
              <section className="rounded border border-darker-brown p-3 flex flex-col gap-2">
                <h4 className="font-bold">Handle it myself</h4>
                {(() => {
                  const link = handlingLink(situation, cityHref);
                  return "href" in link ? (
                    <p className="text-sm">
                      <Link href={link.href} className="text-accent-gold underline">
                        {link.label}
                      </Link>{" "}
                      — the act itself happens there, in the flow that owns it.
                      Recording the decision here marks the card yours.
                    </p>
                  ) : (
                    <p className="text-sm text-text-muted">{link.note}</p>
                  );
                })()}
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-text-muted">Note for the record (optional)</span>
                  <input
                    className="form-input min-h-11"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </label>
                {user && (
                  <ActionRunner
                    subtle
                    ctaLabel="Record that I'm handling this"
                    cityName={(id) => cityName(id)}
                    onResolved={onChanged}
                    submit={() =>
                      submitSituationHandle(user.uid, {
                        situationId: situation.situationId,
                        cityId,
                        ...(note.trim() !== "" ? { decisionNote: note.trim() } : {}),
                      })
                    }
                  />
                )}
              </section>

              {/* ——— B. Delegate ——— */}
              {situation.status === "open" && (
                <section className="rounded border border-darker-brown p-3 flex flex-col gap-2">
                  <h4 className="font-bold">Delegate to an NPC</h4>
                  {npcsHere.length === 0 ? (
                    <p className="text-sm text-text-muted">
                      You have no NPC serving {cityName(cityId)} yet.{" "}
                      <Link href="/settings/npcs" className="text-accent-gold underline">
                        Create one in Settings
                      </Link>{" "}
                      — or handle this yourself, or let it sit.
                    </p>
                  ) : (
                    <>
                      <div className="flex flex-col gap-2" role="radiogroup" aria-label="Choose an NPC">
                        {npcsHere
                          .filter((npc) => npc.status !== "retired")
                          .map((npc) => {
                            const version =
                              mandateVersionByNpc.get(npc.npcId) ?? null;
                            return (
                              <label
                                key={npc.npcId}
                                className="flex gap-2 items-start text-sm rounded border border-darker-brown p-2"
                              >
                                <input
                                  type="radio"
                                  name={`delegate-${situation.situationId}`}
                                  className="mt-1"
                                  checked={pickedNpcId === npc.npcId}
                                  onChange={() => {
                                    setPickedNpcId(npc.npcId);
                                    setDelegateStage("pick");
                                  }}
                                />
                                <span>
                                  <strong>
                                    {npc.displayNameSnapshot} — {npc.titleFreeform}
                                  </strong>{" "}
                                  · {modeShortLabel(npc.permissionMode)}
                                  {version
                                    ? ` · mandate v${version.version}`
                                    : " · no standing mandate"}
                                  <br />
                                  <span className="text-text-muted">
                                    {npc.status !== "active"
                                      ? "Still pending activation — the fabric activates NPCs when their creation resolves."
                                      : npc.permissionMode === "silent"
                                        ? "Say-nothing mode: a standing delegation to this NPC is refused, with the reason stated. You can still task them directly with a one-off envelope — your direct instruction is the permission for that task."
                                        : modeRoutingLine(npc.permissionMode)}
                                  </span>
                                </span>
                              </label>
                            );
                          })}
                      </div>

                      {pickedNpc && (
                        <p className="text-sm">
                          {authoritySummary(
                            pickedNpc.displayNameSnapshot,
                            pickedVersion
                          )}
                        </p>
                      )}

                      {pickedNpc && delegateStage === "pick" && (
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            className="btn min-h-11"
                            disabled={
                              pickedNpc.status !== "active" ||
                              pickedNpc.permissionMode === "silent" ||
                              !pickedNpc.currentMandateId
                            }
                            onClick={() => setDelegateStage("confirm-standing")}
                          >
                            Delegate under the standing mandate
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary min-h-11"
                            disabled={pickedNpc.status !== "active"}
                            onClick={() => setDelegateStage("envelope")}
                          >
                            Task with a one-off envelope instead
                          </button>
                        </div>
                      )}
                      {pickedNpc &&
                        delegateStage === "pick" &&
                        pickedNpc.permissionMode !== "silent" &&
                        !pickedNpc.currentMandateId && (
                          <p className="text-sm text-text-muted">
                            {pickedNpc.displayNameSnapshot} holds no standing
                            mandate, so there is nothing to delegate under — a
                            one-off envelope is the way to task them with this.
                          </p>
                        )}

                      {pickedNpc && delegateStage === "confirm-standing" && user && (
                        <ConfirmationCard
                          title={`Delegate this matter — ${cityName(cityId)}`}
                          proposedBy={`${pickedNpc.displayNameSnapshot}, for you · ${modeShortLabel(pickedNpc.permissionMode)}`}
                          authority={[
                            ...(pickedNpc.currentMandateId
                              ? [
                                  {
                                    label: `mandate v${pickedVersion?.version ?? pickedNpc.currentMandateVersion ?? "?"}`,
                                    href: "/settings/npcs",
                                  },
                                ]
                              : []),
                            { label: `situation ${situation.situationId.slice(-6)}` },
                          ]}
                          effects={[
                            `${pickedNpc.displayNameSnapshot} takes this ${kindLabel(situation.kind).toLowerCase()} matter for ${cityName(cityId)}, inside the mandate's scope and caps.`,
                            pickedNpc.permissionMode === "ask-first"
                              ? "The response comes back to you as a draft — nothing binds until you confirm it."
                              : "Matters inside the mandate may resolve in your name; every act is logged as theirs, on your behalf.",
                            "The card leaves your queue and shows as delegated, with the mandate cited.",
                          ]}
                          notHappening="The matter is not decided by delegating it — no outcome is promised, and binding steps still come back to you."
                          declineOutcome="Declining keeps the card in your queue, exactly as it is."
                          confirmLabel={`Delegate to ${pickedNpc.displayNameSnapshot}`}
                          onDecline={() => setDelegateStage("pick")}
                          onConfirm={() => setDelegateStage("submitted-standing")}
                        />
                      )}

                      {pickedNpc && delegateStage === "submitted-standing" && user && (
                        <ActionRunner
                          autoStart
                          ctaLabel="Delegate"
                          cityName={(id) => cityName(id)}
                          onResolved={onChanged}
                          submit={() =>
                            submitSituationDelegate(user.uid, {
                              situationId: situation.situationId,
                              cityId,
                              npcId: pickedNpc.npcId,
                              mandateId: pickedNpc.currentMandateId,
                            })
                          }
                        />
                      )}

                      {pickedNpc && delegateStage === "envelope" && (
                        <div className="flex flex-col gap-2">
                          <SpawnNpcForm
                            threadRef={{ kind: "situation", id: situation.situationId }}
                            npcs={spawnOptions}
                            cities={spawnCities}
                            cityName={(id) => cityName(id)}
                            initialNpcId={pickedNpc.npcId}
                            initialTask={`Handle this matter for ${cityName(cityId)}: ${situation.title} — ${situation.summary}`}
                            sourceSituationId={situation.situationId}
                          />
                          <button
                            type="button"
                            className="btn btn-secondary min-h-11 self-start"
                            onClick={() => setDelegateStage("pick")}
                          >
                            Back to the delegation choices
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </section>
              )}

              {/* ——— C. Let it sit ——— */}
              <section className="rounded border border-darker-brown p-3 flex flex-col gap-2">
                <h4 className="font-bold">Let it sit</h4>
                <p className="text-sm text-text-muted">
                  Saying nothing is a decision too, and a complete one: the Log
                  records the non-response — "No response — {cityName(cityId)}
                  's leader didn't say anything" — and the card closes as
                  silent. Nothing is sent to anyone, and nobody is reminded.
                </p>
                {user && (
                  <ActionRunner
                    subtle
                    ctaLabel="Stay silent — record no response"
                    cityName={(id) => cityName(id)}
                    onResolved={onChanged}
                    submit={() =>
                      submitSituationSilence(user.uid, {
                        situationId: situation.situationId,
                        cityId,
                      })
                    }
                  />
                )}
              </section>
            </>
          )}
        </div>
      )}
    </article>
  );
}
