/**
 * The standing-Log verifier (Phase 2 brief §4.7 + QA plan v2 §18 TC-E,
 * undo-aware) — an independent consumer of the same public artifacts:
 * entries, manifests, counter, world, and the authoritative state
 * slices. It shares NO code path with the committer beyond the canonical
 * hash functions, so a committer bug cannot hide behind itself:
 *
 *   - hash chaining from genesis (v1 dispatch intact, TC-G03/G04);
 *   - counter/world agreement (TC-E07);
 *   - bijection: every state change traces to exactly one standing
 *     entry, and every standing entry's resolution has its effects
 *     present (TC-E01, undo-aware: erased resolutions are simply gone);
 *   - per-field value chaining (TC-E02);
 *   - citation validity: rules exist; Baseline citations resolve to the
 *     CITED version + hash, ratified, in-scope, prospective (TC-W);
 *   - no orphan citations to erased seqs (a lawful undo can never leave
 *     one — dependents block first; finding one means the undo engine
 *     or a write path misbehaved);
 *   - actor taxonomy: no `system` actor past genesis (P2-G5).
 *
 * Plus the F2 authoritative-slice hasher the QA harness uses to prove
 * "nothing changed" claims (empty wakes, refused undos).
 */

import { canonicalJson, sha256Hex } from "./canonical";
import { computeEntryHash, hashSimDoc, projectFirestoreValue } from "./log";
import { RULE_DESCRIPTORS } from "./rules/registry";
import {
  getBaselineVersion,
  sectionScopeCovers,
  type BaselineRegistry,
} from "./baseline/registry";

export interface VerifyFinding {
  code: string;
  message: string;
  seq?: number;
  resolutionId?: string;
  path?: string;
}

export interface StandingWorld {
  /** All standing entries, any order (the verifier sorts). */
  entries: Record<string, unknown>[];
  manifests: ReadonlyMap<string, Record<string, unknown>>;
  counter: Record<string, unknown>;
  world: Record<string, unknown>;
  /** Authoritative state slices by full doc path (cities + subcollections,
   * allocations, pendings, publications, intel, character extensions). */
  stateDocs: ReadonlyMap<string, Record<string, unknown>>;
  baselineRegistry: BaselineRegistry;
}

const GENESIS_PREV_HASH =
  "0000000000000000000000000000000000000000000000000000000000000000";

function deepEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(projectFirestoreValue(a) as never) ===
    canonicalJson(projectFirestoreValue(b) as never);
}

export function verifyStandingLog(input: StandingWorld): {
  ok: boolean;
  findings: VerifyFinding[];
} {
  const findings: VerifyFinding[] = [];
  const push = (finding: VerifyFinding) => findings.push(finding);
  const entries = [...input.entries].sort(
    (a, b) => (a.seq as number) - (b.seq as number)
  );

  // -- Genesis + contiguity + chain --------------------------------------
  if (entries.length === 0) {
    push({ code: "EMPTY_LOG", message: "no standing entries — genesis missing" });
    return { ok: false, findings };
  }
  const genesis = entries[0];
  if (
    genesis.seq !== 1 ||
    genesis.kind !== "genesis" ||
    genesis.resolutionId !== "genesis" ||
    genesis.prevHash !== GENESIS_PREV_HASH
  ) {
    push({ code: "GENESIS_SHAPE", message: "seq 1 is not the genesis entry", seq: 1 });
  }
  let prevHash = GENESIS_PREV_HASH;
  entries.forEach((entry, index) => {
    const seq = entry.seq as number;
    if (seq !== index + 1) {
      push({ code: "SEQ_GAP", message: `entry at position ${index} has seq ${seq}`, seq });
    }
    if (entry.prevHash !== prevHash) {
      push({ code: "CHAIN_BREAK", message: `prevHash mismatch at seq ${seq}`, seq });
    }
    const computed = computeEntryHash(entry);
    if (computed !== entry.entryHash) {
      push({ code: "HASH_MISMATCH", message: `entryHash does not recompute at seq ${seq}`, seq });
    }
    if (entry.hashVersion !== "cowboy-canonical-json-v2" && seq !== 1) {
      push({
        code: "HASH_VERSION",
        message: `entry at seq ${seq} uses ${String(entry.hashVersion)} — v1 is genesis-only`,
        seq,
      });
    }
    prevHash = entry.entryHash as string;
  });
  const headSeq = entries.length;
  if (input.counter.lastSeq !== headSeq) {
    push({
      code: "COUNTER_DIVERGES",
      message: `counter lastSeq ${String(input.counter.lastSeq)} != standing head ${headSeq}`,
    });
  }
  if (input.counter.lastEntryHash !== prevHash) {
    push({ code: "COUNTER_HASH", message: "counter lastEntryHash != head entryHash" });
  }
  if (input.world.lastCommittedSeq !== input.counter.lastSeq) {
    push({
      code: "WORLD_HEAD_DIVERGES",
      message: `world lastCommittedSeq ${String(input.world.lastCommittedSeq)} != counter ${String(input.counter.lastSeq)}`,
    });
  }

  const standingSeqs = new Set(entries.map((e) => e.seq as number));
  const entriesByResolution = new Map<string, Record<string, unknown>[]>();
  for (const entry of entries) {
    const list = entriesByResolution.get(entry.resolutionId as string) ?? [];
    list.push(entry);
    entriesByResolution.set(entry.resolutionId as string, list);
  }

  // -- Actor taxonomy (P2-G5) ---------------------------------------------
  for (const entry of entries) {
    const actor = entry.actor as { type?: string } | undefined;
    if ((entry.seq as number) > 1 && actor?.type === "system") {
      push({
        code: "SYSTEM_ACTOR",
        message: `entry at seq ${entry.seq} carries the system actor — genesis is the sole exception`,
        seq: entry.seq as number,
      });
    }
  }

  // -- Citations: rules + Baseline + orphans -------------------------------
  for (const entry of entries) {
    for (const ruleId of (entry.ruleIds as string[] | undefined) ?? []) {
      if (!RULE_DESCRIPTORS[ruleId]) {
        push({
          code: "UNKNOWN_RULE",
          message: `entry cites rule ${ruleId}, absent from the registry`,
          seq: entry.seq as number,
        });
      }
    }
    const baseline = entry.baseline as {
      version: string;
      docHash: string;
      sections: string[];
    } | null;
    if (baseline) {
      const version = getBaselineVersion(input.baselineRegistry, baseline.version);
      if (!version) {
        push({ code: "BASELINE_UNKNOWN_VERSION", message: `cites ${baseline.version}`, seq: entry.seq as number });
      } else {
        if (version.status !== "ratified") {
          push({
            code: "BASELINE_UNRATIFIED_CITED",
            message: `entry cites Baseline ${baseline.version} with status ${version.status} — TC-W01 forbids citing a draft`,
            seq: entry.seq as number,
          });
        }
        if (version.docHash !== baseline.docHash) {
          push({ code: "BASELINE_HASH_MISMATCH", message: `citation hash != registry docHash for ${baseline.version}`, seq: entry.seq as number });
        }
        if (version.effectiveFromSeq !== null && (entry.seq as number) < version.effectiveFromSeq) {
          push({
            code: "BASELINE_RETROACTIVE",
            message: `entry at seq ${entry.seq} cites ${baseline.version}, effective only from seq ${version.effectiveFromSeq} (amendments are prospective, TC-W04)`,
            seq: entry.seq as number,
          });
        }
        for (const sectionId of baseline.sections) {
          const section = version.sections.find((s) => s.id === sectionId);
          if (!section) {
            push({ code: "BASELINE_UNKNOWN_SECTION", message: `cites section ${sectionId} absent from ${baseline.version}`, seq: entry.seq as number });
          } else if (!sectionScopeCovers(section, (entry.cityIds as string[]) ?? [])) {
            push({
              code: "BASELINE_OUT_OF_SCOPE",
              message: `section ${sectionId} applied outside its scope (entry cities: ${((entry.cityIds as string[]) ?? []).join(", ")})`,
              seq: entry.seq as number,
            });
          }
        }
      }
    }
    for (const field of ["causedBySeq", "spilloverFromSeq", "correctsSeq"] as const) {
      const target = entry[field] as number | null;
      if (target !== null && target !== undefined && !standingSeqs.has(target)) {
        push({
          code: "ORPHAN_CITATION",
          message: `entry ${field} points at erased/absent seq ${target}`,
          seq: entry.seq as number,
        });
      }
    }
  }

  // -- Per-field value chaining (TC-E02) -----------------------------------
  const running = new Map<string, unknown>();
  for (const entry of entries) {
    const cityId = entry.cityId as string | null;
    for (const change of (entry.changes as { field: string; before: unknown; after: unknown }[] | undefined) ?? []) {
      if (!cityId) continue;
      const key = `${cityId}|${change.field}`;
      if (running.has(key) && !deepEqual(running.get(key), change.before)) {
        push({
          code: "FIELD_CHAIN_BREAK",
          message: `${key}: change at seq ${entry.seq} claims before=${JSON.stringify(change.before)} but the chain holds ${JSON.stringify(running.get(key))}`,
          seq: entry.seq as number,
        });
      }
      running.set(key, change.after);
    }
  }

  // -- Bijection (TC-E01, undo-aware) ---------------------------------------
  const writeSetsByPath = new Map<
    string,
    { resolutionId: string; lastSeq: number; afterHash: string; op: string }[]
  >();
  for (const [resolutionId, manifest] of input.manifests) {
    const resolutionEntries = entriesByResolution.get(resolutionId);
    if (!resolutionEntries && resolutionId !== "genesis") {
      push({
        code: "MANIFEST_WITHOUT_ENTRIES",
        message: `manifest ${resolutionId} stands but none of its entries do`,
        resolutionId,
      });
    }
    const writeSet = (manifest.writeSet as Record<string, unknown>[] | undefined) ?? [];
    for (const write of writeSet) {
      if (write.recordClass !== "state" && write.recordClass !== "pending") continue;
      const list = writeSetsByPath.get(write.path as string) ?? [];
      list.push({
        resolutionId,
        lastSeq: manifest.lastSeq as number,
        afterHash: write.afterHash as string,
        op: write.op as string,
      });
      writeSetsByPath.set(write.path as string, list);
    }
  }
  for (const entry of entries) {
    if (entry.resolutionId === "genesis") continue;
    if (!input.manifests.has(entry.resolutionId as string)) {
      push({
        code: "ENTRY_WITHOUT_MANIFEST",
        message: `entry at seq ${entry.seq} belongs to ${entry.resolutionId}, which has no standing manifest`,
        seq: entry.seq as number,
        resolutionId: entry.resolutionId as string,
      });
    }
  }
  for (const [path, docData] of input.stateDocs) {
    const writers = (writeSetsByPath.get(path) ?? []).sort((a, b) => a.lastSeq - b.lastSeq);
    const lastWriter = writers[writers.length - 1];
    const lastChangedSeq = docData.lastChangedSeq as number | null | undefined;
    if (!lastWriter) {
      if (lastChangedSeq !== null && lastChangedSeq !== undefined) {
        push({
          code: "UNLOGGED_STATE",
          message: `${path} carries lastChangedSeq ${lastChangedSeq} but no standing manifest wrote it`,
          path,
        });
      }
      continue;
    }
    if (hashSimDoc(docData) !== lastWriter.afterHash) {
      push({
        code: "STATE_DIVERGES",
        message: `${path} does not match its last standing writer (${lastWriter.resolutionId})`,
        path,
        resolutionId: lastWriter.resolutionId,
      });
    }
    if (lastChangedSeq !== null && lastChangedSeq !== undefined && lastChangedSeq !== lastWriter.lastSeq) {
      push({
        code: "STATE_SEQ_DIVERGES",
        message: `${path} lastChangedSeq ${lastChangedSeq} != last writer's summary seq ${lastWriter.lastSeq}`,
        path,
      });
    }
  }
  for (const [path, writers] of writeSetsByPath) {
    const lastWriter = [...writers].sort((a, b) => a.lastSeq - b.lastSeq)[writers.length - 1];
    if (!input.stateDocs.has(path) && lastWriter.op !== "delete") {
      push({
        code: "STATE_MISSING",
        message: `${path} was written by ${lastWriter.resolutionId} but does not stand`,
        path,
        resolutionId: lastWriter.resolutionId,
      });
    }
  }

  return { ok: findings.length === 0, findings };
}

// ---------------------------------------------------------------------------
// F2 authoritative-slice hashing (QA plan v2 §1): the hash pair the
// harness compares to prove "nothing changed". Control-plane collections
// (sim_actions bookkeeping, sim_undo_operations) are excluded by
// definition; the Log slices are entries + manifests + counter + world.
// ---------------------------------------------------------------------------

export function hashDocSlice(docs: Iterable<[string, Record<string, unknown>]>): string {
  const pairs = [...docs]
    .map(([path, docData]) => [path, projectFirestoreValue(docData)] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));
  return sha256Hex({ slice: pairs } as unknown as Record<string, unknown>);
}

export function hashWorldStateSlices(input: {
  stateDocs: ReadonlyMap<string, Record<string, unknown>>;
  entries: Record<string, unknown>[];
  manifests: ReadonlyMap<string, Record<string, unknown>>;
  counter: Record<string, unknown>;
  world: Record<string, unknown>;
}): { authoritative: string; log: string } {
  const authoritative = hashDocSlice(input.stateDocs.entries());
  const log = sha256Hex({
    entries: [...input.entries]
      .sort((a, b) => (a.seq as number) - (b.seq as number))
      .map((e) => [e.seq, e.entryHash]),
    manifests: [...input.manifests.entries()]
      .map(([id, m]) => [id, m.writeSetDigest])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    counter: projectFirestoreValue(input.counter),
    worldLastCommittedSeq: input.world.lastCommittedSeq,
  } as Record<string, unknown>);
  return { authoritative, log };
}
