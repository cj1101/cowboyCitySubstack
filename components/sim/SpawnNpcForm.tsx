"use client";

/**
 * The spawn form (brief §11.2; Petra spec §2.6; June design §7.1) —
 * ONE component, four placements: deal rooms, Lore Tab threads,
 * Town Hall threads, Situations cards. The form is identical
 * everywhere; `threadRef.kind` is the only difference.
 *
 * The contract this surface keeps:
 *  - Bounds for a negotiation task are REQUIRED — no bounds, no
 *    spawn (Vera §8.4 layer 1). The form will not submit a
 *    negotiation without them, and says so in one sentence.
 *  - `mayCommit` is fixed copy, never a toggle: "This NPC cannot
 *    commit you to anything." The submitted bounds carry
 *    `mayCommit: false` because the shape refuses anything else.
 *  - The task text is the owner's words, verbatim.
 *  - A spawn is a play-intake action (`envelope.spawn`): the fabric
 *    previews it, the owner confirms, and only then does the
 *    envelope exist. After it resolves, the persistent task marker
 *    stays with the thread: spawned — awaiting fabric cycle →
 *    working → exactly one output, badged "〈NPC〉, for 〈owner〉".
 *  - The landed spawn path tasks a STANDING NPC (the envelope
 *    record names one; the resolver refuses a spawn with no NPC
 *    record behind it). A one-off persona label therefore cannot be
 *    tasked from here — the form says so plainly and points at
 *    Settings, where the persona becomes a standing NPC first.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { doc, onSnapshot } from "firebase/firestore";
import { useAuth } from "@/components/auth/AuthProvider";
import { getClientDb } from "@/lib/firebase";
import { newClientRequestId, submitPlayAction } from "@/lib/play/intake";
import { envelopeTaskId } from "@/lib/envelopes";
import type { TaskEnvelopeRecord, TaskOutputRecord } from "@/lib/envelopes/types";
import type { PermissionMode } from "@/lib/npcs/types";
import { modeShortLabel } from "@/lib/npcs/present";
import {
  loadEnvelope,
  loadTaskOutput,
  submitEnvelopeSpawn,
} from "@/lib/situations/client";
import { ActionRunner } from "./ActionRunner";

export interface SpawnNpcOption {
  npcId: string;
  name: string;
  title: string;
  mode: PermissionMode;
  cityId: string;
  status: string;
}

export interface SpawnNpcFormProps {
  /** The placement's thread — the ONLY placement difference. */
  threadRef: { kind: string; id: string } | null;
  /** The owner's NPCs (any status; only active ones can be tasked). */
  npcs: SpawnNpcOption[];
  /** Counterparty options for the bounds block (all cities). */
  cities: { id: string; name: string }[];
  cityName: (cityId: string) => string;
  initialNpcId?: string;
  initialTask?: string;
  /** When spawned from a Situation, the situation it answers. */
  sourceSituationId?: string;
}

/** The task types the fabric's envelope builder accepts today —
 * offered as EXAMPLES in a datalist, never a closed select: the
 * field stays free text (brief §11.2), and a type the fabric does
 * not know comes back refused in the preview, before anything is
 * confirmed. */
const TASK_TYPE_EXAMPLES = ["one-off", "negotiation", "collection", "report", "errand"];

function linesToEntries(text: string): { kind: string; text: string }[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => ({ kind: "text", text: line }));
}

function lines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

export function SpawnNpcForm({
  threadRef,
  npcs,
  cities,
  cityName,
  initialNpcId,
  initialTask,
  sourceSituationId,
}: SpawnNpcFormProps) {
  const { user } = useAuth();
  const activeNpcs = useMemo(() => npcs.filter((n) => n.status === "active"), [npcs]);
  const pendingCount = npcs.length - activeNpcs.length;

  const [npcId, setNpcId] = useState<string>(
    initialNpcId ?? activeNpcs[0]?.npcId ?? ""
  );
  const [taskType, setTaskType] = useState("one-off");
  const [task, setTask] = useState(initialTask ?? "");
  const [scope, setScope] = useState("");
  const [counterpartyCityIds, setCounterpartyCityIds] = useState<string[]>([]);
  const [subject, setSubject] = useState("");
  const [mayOffer, setMayOffer] = useState("");
  const [mayAccept, setMayAccept] = useState("");
  const [walkAwayIf, setWalkAwayIf] = useState("");
  const [maxTurns, setMaxTurns] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [envelopeClientRequestId, setEnvelopeClientRequestId] = useState<string>(
    () => newClientRequestId()
  );
  const [spawnedTaskId, setSpawnedTaskId] = useState<string | null>(null);

  const selectedNpc = activeNpcs.find((n) => n.npcId === npcId) ?? null;
  const isNegotiation = taskType.trim() === "negotiation";

  if (!user) {
    return (
      <p className="text-sm text-text-muted">
        Sign in to task one of your NPCs here.
      </p>
    );
  }

  if (activeNpcs.length === 0) {
    return (
      <div className="flex flex-col gap-2 text-sm">
        <p>
          None of your NPCs is active yet, so there is no one to task here.
          {pendingCount > 0
            ? " An NPC you created is still pending activation — it becomes taskable when the fabric commits its creation."
            : ""}{" "}
          A one-off persona label can't be tasked on its own — the task has to
          name a standing NPC, so the work is attributable.{" "}
          <Link href="/settings/npcs" className="text-accent-gold underline">
            Create or check your NPCs in Settings
          </Link>
          .
        </p>
      </div>
    );
  }

  const validate = (): string | null => {
    if (!selectedNpc) return "Choose which of your NPCs takes this task.";
    if (task.trim() === "") return "Write the task in your own words first — your words are the task, verbatim.";
    if (isNegotiation) {
      if (subject.trim() === "") {
        return "A negotiation task needs its bounds — the subject is the first of them. No bounds, no spawn.";
      }
      if (linesToEntries(mayOffer).length === 0 && linesToEntries(mayAccept).length === 0) {
        return "A negotiation task needs bounds — say what this NPC may offer or may accept. No bounds, no spawn.";
      }
      const turns = Number.parseInt(maxTurns, 10);
      if (!Number.isFinite(turns) || turns < 1) {
        return "A negotiation task needs a maximum number of turns in its bounds. No bounds, no spawn.";
      }
    }
    return null;
  };

  const buildPayload = (): Record<string, unknown> => ({
    npcId: selectedNpc?.npcId ?? "",
    taskType: taskType.trim(),
    task: task.trim(),
    structuredIntent: {
      ...(scope.trim() !== "" ? { scope: scope.trim() } : {}),
      ...(sourceSituationId ? { sourceSituationId } : {}),
    },
    bounds: {
      mayCommit: false,
      counterpartyCityIds,
      negotiationBounds: isNegotiation
        ? {
            subject: subject.trim(),
            mayOffer: linesToEntries(mayOffer),
            mayAccept: linesToEntries(mayAccept),
            walkAwayIf: lines(walkAwayIf),
            maxTurns: Number.parseInt(maxTurns, 10),
          }
        : null,
    },
  });

  if (spawnedTaskId) {
    return (
      <div className="flex flex-col gap-3">
        <EnvelopeMarker taskId={spawnedTaskId} />
        <button
          type="button"
          className="btn btn-secondary min-h-11"
          onClick={() => {
            setSpawnedTaskId(null);
            setEnvelopeClientRequestId(newClientRequestId());
            setTask("");
          }}
        >
          Task another NPC here
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 text-sm">
      <label className="flex flex-col gap-1">
        <span className="text-text-muted">NPC (yours only)</span>
        <select
          className="form-input min-h-11"
          value={npcId}
          onChange={(e) => setNpcId(e.target.value)}
        >
          {activeNpcs.map((npc) => (
            <option key={npc.npcId} value={npc.npcId}>
              {npc.name} — {npc.title} · {modeShortLabel(npc.mode)} ·{" "}
              {cityName(npc.cityId)}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-text-muted">Task type</span>
        <input
          className="form-input min-h-11"
          value={taskType}
          onChange={(e) => setTaskType(e.target.value)}
          list="spawn-task-type-examples"
        />
        <datalist id="spawn-task-type-examples">
          {TASK_TYPE_EXAMPLES.map((example) => (
            <option key={example} value={example} />
          ))}
        </datalist>
        <span className="text-xs text-text-muted">
          Examples the fabric understands today: {TASK_TYPE_EXAMPLES.join(", ")}.
          The field is free text — a type the fabric does not know comes back
          refused in the preview, before you confirm anything.
        </span>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-text-muted">Task *</span>
        <textarea
          className="form-input min-h-24"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder="Your words are the task, verbatim."
        />
      </label>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-text-muted">Bounds</legend>
        <label className="flex flex-col gap-1">
          <span className="text-text-muted">Scope of this task</span>
          <input
            className="form-input min-h-11"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            placeholder="e.g. this proposal, this thread only"
          />
        </label>
        {cities.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="text-text-muted">Counterparty cities this task may touch</span>
            <div className="flex flex-wrap gap-2">
              {cities
                .filter((city) => city.id !== selectedNpc?.cityId)
                .map((city) => {
                  const checked = counterpartyCityIds.includes(city.id);
                  return (
                    <label key={city.id} className="flex items-center gap-1 text-sm">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) =>
                          setCounterpartyCityIds((current) =>
                            e.target.checked
                              ? [...current, city.id]
                              : current.filter((id) => id !== city.id)
                          )
                        }
                      />
                      {city.name}
                    </label>
                  );
                })}
            </div>
          </div>
        )}

        {isNegotiation && (
          <div className="flex flex-col gap-2 rounded border border-darker-brown p-3">
            <p className="font-bold">
              Negotiation bounds — required for a negotiation task. No bounds,
              no spawn.
            </p>
            <label className="flex flex-col gap-1">
              <span className="text-text-muted">Subject *</span>
              <input
                className="form-input min-h-11"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-text-muted">May offer (one per line)</span>
              <textarea
                className="form-input"
                rows={2}
                value={mayOffer}
                onChange={(e) => setMayOffer(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-text-muted">May accept (one per line)</span>
              <textarea
                className="form-input"
                rows={2}
                value={mayAccept}
                onChange={(e) => setMayAccept(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-text-muted">Walk away if (one per line)</span>
              <textarea
                className="form-input"
                rows={2}
                value={walkAwayIf}
                onChange={(e) => setWalkAwayIf(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-text-muted">Max turns *</span>
              <input
                className="form-input min-h-11 w-32"
                value={maxTurns}
                onChange={(e) => setMaxTurns(e.target.value)}
                inputMode="numeric"
              />
            </label>
            <p className="text-xs text-text-muted">
              While the task is live, these bounds are part of the fairness
              surface — they are recorded with the task, not kept as a private
              prompt.
            </p>
          </div>
        )}
      </fieldset>

      <div className="rounded border border-darker-brown p-3 flex flex-col gap-1">
        <p className="font-bold">This NPC cannot commit you to anything.</p>
        <p className="text-text-muted">
          Anything binding comes back to you as a confirmation card. On spawn
          the task is queued: the fabric runs NPCs in cycles, and the marker
          stays with this thread until the one output lands. Nothing here
          pretends the NPC is live in the meantime.
        </p>
      </div>

      {problem ? (
        <p role="alert" className="text-red-300">
          {problem}
        </p>
      ) : null}

      <ActionRunner
        ctaLabel={selectedNpc ? `Spawn the task for ${selectedNpc.name}` : "Spawn the task"}
        cityName={(id) => cityName(id)}
        submit={async () => {
          const issue = validate();
          if (issue) {
            setProblem(issue);
            throw new Error(issue);
          }
          setProblem(null);
          if (!selectedNpc) throw new Error("No NPC selected.");
          return submitEnvelopeSpawn(user.uid, {
            cityId: selectedNpc.cityId,
            payload: buildPayload(),
            envelopeClientRequestId,
            ...(threadRef ? { threadRef } : {}),
          });
        }}
        onResolved={() => {
          setSpawnedTaskId(envelopeTaskId(user.uid, envelopeClientRequestId));
        }}
      />
    </div>
  );
}

/**
 * The persistent task marker (§2.6.1): the envelope's state, in the
 * thread where it was spawned. QUEUED reads "spawned — awaiting
 * fabric cycle"; RUNNING, "working — output will appear in this
 * thread"; terminal renders the exactly-one output, badged
 * "〈NPC〉, for 〈owner〉" when the caller supplies the badge. A
 * queued, unclaimed envelope can be cancelled from the marker —
 * there is no edit-in-place; changing the task is cancel + respawn,
 * both logged.
 */
export function EnvelopeMarker({
  taskId,
  badge,
  cityName,
}: {
  taskId: string;
  badge?: string;
  cityName?: (cityId: string) => string;
}) {
  const { user } = useAuth();
  const [envelope, setEnvelope] = useState<TaskEnvelopeRecord | null | undefined>(
    undefined
  );
  const [output, setOutput] = useState<TaskOutputRecord | null>(null);

  useEffect(() => {
    const db = getClientDb();
    const unsubEnvelope = onSnapshot(
      doc(db, "sim_task_envelopes", taskId),
      (snap) =>
        setEnvelope(snap.exists() ? (snap.data() as TaskEnvelopeRecord) : null),
      () => {
        loadEnvelope(taskId).then(setEnvelope).catch(() => setEnvelope(null));
      }
    );
    const unsubOutput = onSnapshot(
      doc(db, "sim_task_outputs", taskId),
      (snap) =>
        setOutput(snap.exists() ? (snap.data() as TaskOutputRecord) : null),
      () => {
        loadTaskOutput(taskId).then(setOutput).catch(() => undefined);
      }
    );
    return () => {
      unsubEnvelope();
      unsubOutput();
    };
  }, [taskId]);

  const shortId = `…${taskId.slice(-6)}`;
  const terminal =
    envelope?.status === "DONE" ||
    envelope?.status === "NEED-INFO" ||
    envelope?.status === "FAILED";

  return (
    <div className="rounded border border-darker-brown bg-glass-bg p-3 text-sm flex flex-col gap-2">
      <p className="text-xs text-text-muted">NPC task {shortId}</p>
      {badge ? <p className="font-bold">{badge}</p> : null}
      {envelope === undefined ? (
        <p className="text-text-muted">Reading the task…</p>
      ) : envelope === null || envelope.status === "QUEUED" ? (
        <>
          <p>spawned — awaiting fabric cycle</p>
          {user && envelope !== null && (
            <ActionRunner
              subtle
              ctaLabel="Cancel this task"
              cityName={cityName ?? ((id) => id)}
              submit={async () => {
                const { actionId } = await submitPlayAction({
                  uid: user.uid,
                  clientRequestId: newClientRequestId(),
                  actionType: "envelope.cancel",
                  actionText: null,
                  structuredAction: { taskId },
                  targetCityIds: [envelope.cityId],
                });
                return { actionId };
              }}
            />
          )}
        </>
      ) : envelope.status === "RUNNING" ? (
        <p>working — output will appear in this thread</p>
      ) : terminal ? (
        <div className="flex flex-col gap-1">
          <p className="font-bold">
            {output?.outcome === "NEED-INFO" || envelope.status === "NEED-INFO"
              ? "Needs information"
              : envelope.status === "FAILED"
                ? "Failed as recorded"
                : "Done"}
          </p>
          {output?.outputText ? (
            <p className="whitespace-pre-wrap">{output.outputText}</p>
          ) : envelope.lastError ? (
            <p>{envelope.lastError.message}</p>
          ) : (
            <p className="text-text-muted">The output is recorded in the Log.</p>
          )}
          {output?.createdSeq !== null && output?.createdSeq !== undefined && (
            <p className="text-xs text-text-muted">Log seq {output.createdSeq}</p>
          )}
        </div>
      ) : (
        <p>Status: {envelope.status}</p>
      )}
    </div>
  );
}
