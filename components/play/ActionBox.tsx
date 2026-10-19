"use client";

/**
 * The live action intake (Phase 4 brief §2.1, module a) — the Phase 3
 * ActionBox shell made real, against the landed contracts only.
 *
 * A member composes in their own words (free text) or through a
 * structured form for a registered kind, submits, and the fabric
 * takes it from there: translate → preview → the member's own
 * confirmation → the wake → the Log. This surface writes exactly two
 * things ever — the born-`received` action doc and, later, the
 * hash-bound confirmation (lib/play/intake.ts) — and it prompts
 * nothing: no suggested actions, no examples invented by the UI, no
 * timers or nudges. The world moves when members act, or not at all.
 *
 * Mounting is the Build Lead's assembly: the dashboard panel and the
 * city page each render this box with the viewer's acting cities
 * (the city page passes `lockedCityId`). Members only — guests never
 * receive the surface, and the rules fence refuses their writes in
 * any case.
 */

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { SubmitButton } from "@/components/ui/SubmitButton";
import {
  buildStructuredAction,
  initialFieldValues,
  targetCityIdsFor,
  validateFieldValues,
  type PlayFieldValues,
} from "@/lib/play/formState";
import {
  confirmPlayAction,
  newClientRequestId,
  submitPlayAction,
  subscribePlayAction,
} from "@/lib/play/intake";
import { FREE_TEXT_KIND, kindById, PLAY_ACTION_KINDS } from "@/lib/play/kinds";
import type { PlayActionKind, PlayActionView, PlayCityOption } from "@/lib/play/types";
import { ConfirmationCard } from "./ConfirmationCard";
import { PreviewCard } from "./PreviewCard";
import { StructuredActionForm } from "./StructuredActionForm";

export interface ActionBoxProps {
  /** The viewer's acting cities, own cities first, then the shared
   * city — the Phase 3 shell's ordering. */
  cities: PlayCityOption[];
  /** Structured kinds this surface may offer. The mount point passes
   * kinds reconciled against the fabric registry (brief §2.1: a kind
   * with no registered handler is not offered); defaults to the
   * module catalog. */
  kinds?: PlayActionKind[];
  /** Fix the acting city (the city page's posture): the selector is
   * replaced by a static "acting as" line. */
  lockedCityId?: string;
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "permission-denied") {
      return "That write was refused by the site's rules — members submit and confirm only their own actions, and only while signed in as a full member. Nothing was recorded.";
    }
  }
  return error instanceof Error ? error.message : "Something went wrong. Nothing was recorded.";
}

export function ActionBox({ cities, kinds, lockedCityId }: ActionBoxProps) {
  const { user } = useAuth();
  const offered = useMemo(() => kinds ?? PLAY_ACTION_KINDS, [kinds]);
  const cityById = useMemo(() => new Map(cities.map((city) => [city.factionId, city])), [cities]);
  const cityName = (cityId: string) => cityById.get(cityId)?.name ?? cityId;

  const [selectedCityId, setSelectedCityId] = useState<string>(
    lockedCityId ?? cities[0]?.factionId ?? ""
  );
  const [selectedKindId, setSelectedKindId] = useState<string>("");
  const [draftText, setDraftText] = useState("");
  const [fieldValues, setFieldValues] = useState<PlayFieldValues>({});
  const [clientRequestId, setClientRequestId] = useState<string>(() => newClientRequestId());
  const [submittedActionId, setSubmittedActionId] = useState<string | null>(null);
  const [actionView, setActionView] = useState<PlayActionView | null | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const selectedCity = cityById.get(lockedCityId ?? selectedCityId) ?? cities[0] ?? null;
  const selectedKind = selectedKindId ? kindById(selectedKindId, offered) : null;

  // A different kind means a fresh form.
  useEffect(() => {
    setFieldValues(selectedKind ? initialFieldValues(selectedKind) : {});
    setFormError(null);
  }, [selectedKind]);

  // Follow the submitted action through its lifecycle.
  useEffect(() => {
    if (!submittedActionId) return;
    setActionView(undefined);
    return subscribePlayAction(
      submittedActionId,
      (view) => setActionView(view),
      (error) => setFormError(errorMessage(error))
    );
  }, [submittedActionId]);

  if (!user) {
    return (
      <section aria-label="Take an action" className="flex flex-col gap-3 text-sm">
        <h3 className="font-bold">Take an action</h3>
        <p className="text-text-muted">Sign in to act on your city&rsquo;s behalf.</p>
      </section>
    );
  }

  if (cities.length === 0) {
    return (
      <section aria-label="Take an action" className="flex flex-col gap-3 text-sm">
        <h3 className="font-bold">Take an action</h3>
        <p>
          You haven&rsquo;t created or claimed a city yet — once you have one, this is
          where you&rsquo;ll act on its behalf.
        </p>
      </section>
    );
  }

  const handleSubmit = async () => {
    if (!selectedCity) return;
    setFormError(null);
    let payload: Parameters<typeof submitPlayAction>[0];
    if (selectedKind) {
      const problems = validateFieldValues(selectedKind, fieldValues);
      if (problems.length > 0) {
        setFormError(problems.join(" "));
        return;
      }
      payload = {
        uid: user.uid,
        clientRequestId,
        actionType: selectedKind.kind,
        actionText: draftText.trim() === "" ? null : draftText.trim(),
        structuredAction: buildStructuredAction(selectedKind, fieldValues),
        targetCityIds: targetCityIdsFor(selectedKind, fieldValues, selectedCity.factionId),
      };
    } else {
      if (draftText.trim() === "") {
        setFormError("Describe the action in your own words first — the fabric can't preview a blank page.");
        return;
      }
      payload = {
        uid: user.uid,
        clientRequestId,
        actionType: FREE_TEXT_KIND,
        actionText: draftText.trim(),
        structuredAction: null,
        targetCityIds: [selectedCity.factionId],
      };
    }
    setSubmitting(true);
    try {
      const { actionId } = await submitPlayAction(payload);
      setSubmittedActionId(actionId);
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirm = async () => {
    const preview = actionView?.preview;
    if (!actionView || !preview) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      await confirmPlayAction({
        actionId: actionView.actionId,
        uid: user.uid,
        previewHash: preview.previewHash,
      });
    } catch (error) {
      setConfirmError(errorMessage(error));
    } finally {
      setConfirming(false);
    }
  };

  const handleWriteAnother = () => {
    setSubmittedActionId(null);
    setActionView(undefined);
    setDraftText("");
    setFieldValues(selectedKind ? initialFieldValues(selectedKind) : {});
    setClientRequestId(newClientRequestId());
    setFormError(null);
    setConfirmError(null);
  };

  return (
    <section aria-label="Take an action" className="flex flex-col gap-3 text-sm">
      <h3 className="font-bold">Take an action</h3>

      {submittedActionId === null ? (
        <div className="flex flex-col gap-3">
          {lockedCityId ? (
            <p>
              <span className="text-text-muted">Acting city</span>
              <br />
              {selectedCity?.name}
            </p>
          ) : (
            <label className="flex flex-col gap-1">
              <span className="text-text-muted">Acting city</span>
              <select
                className="form-input min-h-11"
                value={selectedCity?.factionId ?? ""}
                onChange={(event) => setSelectedCityId(event.target.value)}
              >
                {cities.map((city) => (
                  <option key={city.factionId} value={city.factionId}>
                    {city.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {selectedCity?.isShared ? (
            <p className="text-text-muted">
              {selectedCity.name} is the shared city — actions there run through the
              sitting Mayor, with Town Hall able to intervene.
            </p>
          ) : null}

          {offered.length > 0 ? (
            <label className="flex flex-col gap-1">
              <span className="text-text-muted">How do you want to act?</span>
              <select
                className="form-input min-h-11"
                value={selectedKindId}
                onChange={(event) => setSelectedKindId(event.target.value)}
              >
                <option value="">In my own words</option>
                {offered.map((kind) => (
                  <option key={kind.kind} value={kind.kind}>
                    {kind.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {selectedKind ? (
            <StructuredActionForm
              kind={selectedKind}
              values={fieldValues}
              onChange={setFieldValues}
              cities={cities}
            />
          ) : null}

          <label className="flex flex-col gap-1">
            <span className="text-text-muted">
              {selectedKind ? "Anything to add, in your own words? (optional)" : "What do you want to do?"}
            </span>
            <textarea
              className="form-input min-h-24"
              value={draftText}
              onChange={(event) => setDraftText(event.target.value)}
              placeholder="Describe the action in your own words…"
            />
          </label>

          {formError ? (
            <p role="alert" className="text-red-300">
              {formError}
            </p>
          ) : null}

          <SubmitButton
            type="button"
            busy={submitting}
            busyLabel="Submitting…"
            onClick={handleSubmit}
            className="btn min-h-11"
          >
            Submit for preview
          </SubmitButton>
          <p className="text-xs text-text-muted">
            Submitting decides nothing: the fabric previews exactly what would happen,
            and only your confirmation — on that preview — puts it in motion.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <ActionLifecycle
            view={actionView}
            cityName={cityName}
            kind={selectedKind}
            confirming={confirming}
            confirmError={confirmError}
            onConfirm={handleConfirm}
          />
          <button type="button" className="btn min-h-11" onClick={handleWriteAnother}>
            Write another action
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * The submitted action's life after the composer: waiting for the
 * fabric, the preview + confirmation pair, the wake queue, and the
 * terminal states — including the erased state a lawful undo leaves
 * behind, reported as exactly that.
 */
function ActionLifecycle({
  view,
  cityName,
  kind,
  confirming,
  confirmError,
  onConfirm,
}: {
  view: PlayActionView | null | undefined;
  cityName: (cityId: string) => string;
  kind: PlayActionKind | null;
  confirming: boolean;
  confirmError: string | null;
  onConfirm: () => void;
}) {
  if (view === undefined) {
    return <p className="text-text-muted">Following your action…</p>;
  }
  if (view === null) {
    return (
      <p>
        This action is gone — it was undone and erased from the world and the Log, as
        if it never happened.
      </p>
    );
  }

  switch (view.status) {
    case "received":
      return (
        <p>
          Submitted. The fabric has it and a preview comes next — nothing has been
          decided, and nothing in the world has changed.
        </p>
      );
    case "preview_pending":
      return <p>The fabric is computing your preview…</p>;
    case "awaiting_confirmation":
      return view.preview ? (
        <div className="flex flex-col gap-3">
          <PreviewCard
            preview={view.preview}
            actionType={view.actionType}
            actionText={view.actionText}
            cityName={cityName}
          />
          <ConfirmationCard
            preview={view.preview}
            kind={kind}
            cityName={cityName}
            busy={confirming}
            error={confirmError}
            onConfirm={onConfirm}
          />
        </div>
      ) : (
        <p>The fabric marked this ready to confirm, but its preview could not be read back. Nothing can be confirmed from here.</p>
      );
    case "confirmed":
      return (
        <p>
          Confirmed. It resolves at the next wake — the world moves only when the
          fabric runs on confirmed actions, never on its own.
        </p>
      );
    case "queued":
      return <p>Confirmed and queued for the next wake.</p>;
    case "resolving":
      return <p>Resolving now…</p>;
    case "resolved": {
      const seq =
        view.firstLogSeq !== null && view.lastLogSeq !== null
          ? view.firstLogSeq === view.lastLogSeq
            ? ` (Log seq ${view.firstLogSeq})`
            : ` (Log seq ${view.firstLogSeq}–${view.lastLogSeq})`
          : "";
      return <p>Resolved and written to the Log{seq}. The Log is the record of what happened.</p>;
    }
    case "rejected":
      return (
        <p role="alert">
          Rejected{view.failure ? `: ${view.failure.code} — ${view.failure.message}` : "."}
        </p>
      );
    case "failed":
      return (
        <p role="alert">
          This action failed{view.failure ? `: ${view.failure.code} — ${view.failure.message}` : "."}{" "}
          The failure is on the record; nothing was half-applied.
        </p>
      );
    default:
      return <p>Status: {view.status}</p>;
  }
}
