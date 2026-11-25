import { sleep } from "workflow";

import type { MissedTapCheckInput } from "@/lib/runtime/schedule-missed-tap";

const MINUTE = 60_000;

/**
 * Waits before each check: +1, +5 and +30 minutes after the button DM. Most
 * people tap within a minute, so the first check finds most missed taps.
 */
export const MISSED_TAP_CHECK_DELAYS_MS = [MINUTE, 4 * MINUTE, 25 * MINUTE] as const;

async function checkStep(input: MissedTapCheckInput & { check: number; last: boolean }) {
  "use step";
  const { checkMissedTap } = await import("@/lib/runtime/missed-taps");
  return checkMissedTap(input);
}
// The checks are this workflow's schedule, not the step runner's.
checkStep.maxRetries = 0;

/**
 * Finds a tap whose webhook Instagram never sent. A dropped tap looks the
 * same as no tap yet, so after a button DM this reads that one conversation
 * three times and stops as soon as the run moves on. Sleeping holds no
 * compute and no database connection.
 */
export async function missedTapCheckWorkflow(input: MissedTapCheckInput) {
  "use workflow";

  for (let check = 1; check <= MISSED_TAP_CHECK_DELAYS_MS.length; check += 1) {
    await sleep(MISSED_TAP_CHECK_DELAYS_MS[check - 1]!);
    const outcome = await checkStep({ ...input, check, last: check === MISSED_TAP_CHECK_DELAYS_MS.length }).catch(() => "waiting" as const);
    if (outcome !== "waiting") return outcome;
  }
  return "waiting" as const;
}
