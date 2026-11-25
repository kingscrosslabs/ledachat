import "server-only";

/** Which button a missed-tap check looks for: the Opening DM's, or the follow gate's. */
export type MissedTapStep = "opening" | "follow";

export type MissedTapCheckInput = {
  runId: string;
  step: MissedTapStep;
  /** When the button DM went out (ISO), so a check for an older DM of the same run does nothing. */
  sentAt: string;
};

/** Off when `MISSED_TAP_RECOVERY=off`; on everywhere else, Vercel and local dev alike. */
export function missedTapRecoveryEnabled() {
  return process.env.MISSED_TAP_RECOVERY?.trim().toLowerCase() !== "off";
}

/**
 * Starts the missed-tap check for a button DM that just went out
 * (`workflows/missed-tap-check.ts`). It never throws: without a working
 * Workflow runtime the flow carries on as before, only without recovery.
 */
export async function scheduleMissedTapCheck(input: MissedTapCheckInput) {
  if (!missedTapRecoveryEnabled()) return;
  try {
    const [{ start }, { missedTapCheckWorkflow }] = await Promise.all([import("workflow/api"), import("@/workflows/missed-tap-check")]);
    await start(missedTapCheckWorkflow, [input]);
  } catch (error) {
    console.error(`Couldn't start the missed-tap check for run ${input.runId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
