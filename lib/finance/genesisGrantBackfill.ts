/**
 * The F-01 genesis-grant backfill planner (P4-K6) — the pure half of
 * the backfill for members who predate Phase 4.
 *
 * P4-K6: the 250,000 R personal grant lands as a committer act in the
 * member's first resolution chain; pre-Phase-4 members receive it via
 * the same backfill discipline as brief §3.6 (idempotent, logged as a
 * mint line from finance §3.3's closed list, verified by assertion
 * pass), exactly once per member, at the identical figure late joiners
 * receive.
 *
 * This planner is deliberately distinct from Module 0's §3.6 stamp: the
 * stamp concerned stat-allocation provenance; this concerns MONEY —
 * every backfilled grant is an F-01 Resolution Event (an
 * `open_member_account` action resolved by the F-01 handler, mint entry
 * and all), never a data-step write. A member whose account already
 * stands open with its grant is skipped (idempotent re-runs emit
 * nothing for them). A member with an account doc that lacks the
 * genesisGrant block is an ANOMALY, reported for the Lead — the
 * planner never invents a grant-only write path around F-01's
 * exactly-once discipline.
 *
 * The runner that submits these actions through the dispatcher is an
 * emulator-only Lead assembly item (scripts/**, following Module 0's
 * phase4DataStep pattern); this module only plans.
 */

import { GENESIS_GRANT_RUBARS, memberAccountOf } from "./accounts";

export interface BackfillMemberInput {
  memberId: string;
  /** The standing `sim_member_accounts/{memberId}` doc, or null. */
  accountDoc: Record<string, unknown> | null;
}

export interface BackfillActionSpec {
  memberId: string;
  actionType: "open_member_account";
  /** The actor the action is submitted as: the member themselves —
   * the grant is the member's own F-01 act, backfilled. */
  actorMemberId: string;
  structuredAction: { via: "backfill" };
  /** The mint this action will perform, stated for the runner's
   * pre-flight report: GENESIS_GRANT_RUBARS, from §3.3's closed list. */
  expectedMintRubars: number;
}

export interface BackfillPlan {
  actions: BackfillActionSpec[];
  skipped: { memberId: string; reason: string }[];
  anomalies: { memberId: string; reason: string }[];
}

export function planGenesisGrantBackfill(
  members: readonly BackfillMemberInput[]
): BackfillPlan {
  const actions: BackfillActionSpec[] = [];
  const skipped: BackfillPlan["skipped"] = [];
  const anomalies: BackfillPlan["anomalies"] = [];
  const seen = new Set<string>();
  for (const member of members) {
    if (seen.has(member.memberId)) {
      anomalies.push({
        memberId: member.memberId,
        reason: "duplicate member id in the backfill input — exactly-once cannot be planned over a duplicated roster",
      });
      continue;
    }
    seen.add(member.memberId);
    if (!member.accountDoc) {
      actions.push({
        memberId: member.memberId,
        actionType: "open_member_account",
        actorMemberId: member.memberId,
        structuredAction: { via: "backfill" },
        expectedMintRubars: GENESIS_GRANT_RUBARS,
      });
      continue;
    }
    const account = memberAccountOf(member.accountDoc);
    if (account && account.genesisGrant) {
      skipped.push({
        memberId: member.memberId,
        reason: `account already stands with its genesis grant of ${account.genesisGrant.amountRubars} R (granted at seq ${account.genesisGrant.grantedAtSeq}) — exactly-once holds, nothing to backfill`,
      });
      continue;
    }
    anomalies.push({
      memberId: member.memberId,
      reason:
        "account doc stands without a genesisGrant block — F-01's exactly-once discipline has no grant-only write path; the Lead must reconcile this record before any grant is planned",
    });
  }
  return { actions, skipped, anomalies };
}
