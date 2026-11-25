import "server-only";

import { eq } from "drizzle-orm";

import { readConversation, type ConversationMessage } from "@/lib/adeli/conversations";
import { track } from "@/lib/analytics/server";
import { db, schema } from "@/lib/db";

import { handleTap } from "./handle";
import type { MissedTapCheckInput, MissedTapStep } from "./schedule-missed-tap";

/** The run state a step's button is waiting in. */
const WAITING_STATE: Record<MissedTapStep, "opening_sent" | "awaiting_follow"> = { opening: "opening_sent", follow: "awaiting_follow" };

/**
 * Instagram dates messages to the second, and our clock and Instagram's can
 * differ a little, so a tap made right after the DM may look slightly older.
 */
const CLOCK_SLACK_MS = 5_000;

/**
 * The tap Instagram recorded in the conversation but sent no webhook for: a
 * message from the person whose text is exactly the button's label, sent
 * after the button DM. Any other message is not a tap.
 */
export function findMissedTap(messages: ConversationMessage[], tap: { igsid: string; label: string; sentAt: Date }) {
  const since = tap.sentAt.getTime() - CLOCK_SLACK_MS;
  return messages.find((message) => message.direction === "inbound"
    && message.fromId === tap.igsid
    && message.text?.trim() === tap.label.trim()
    && Date.parse(message.createdAt) >= since) ?? null;
}

/**
 * One missed-tap check for a run (`workflows/missed-tap-check.ts`).
 * `done`: the run moved on, or there's nothing to check. `recovered`: a tap
 * was found and handled like one. `waiting`: check again later.
 */
export async function checkMissedTap(input: MissedTapCheckInput & { check: number; last: boolean }): Promise<"done" | "recovered" | "waiting"> {
  const [row] = await db().select({ run: schema.runs, account: schema.accounts })
    .from(schema.runs)
    .innerJoin(schema.automations, eq(schema.automations.id, schema.runs.automationId))
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.automations.accountId))
    .where(eq(schema.runs.id, input.runId))
    .limit(1);
  if (!row) return "done";
  const { run, account } = row;
  // A tap arrived, the run failed, or a newer button DM went out with its own check.
  if (run.state !== WAITING_STATE[input.step] || run.lastButtonDmAt?.toISOString() !== input.sentAt || !run.lastButtonLabel) return "done";

  // The follow gate went to whoever tapped; the Opening DM to the commenter, whose comment id is also their messaging id.
  const igsid = run.igSenderId ?? run.igUserId;
  const read = await readConversation(account.adeliAccountId, igsid);
  if (!read.available) return "done";

  const tap = findMissedTap(read.messages, { igsid, label: run.lastButtonLabel, sentAt: run.lastButtonDmAt });
  if (!tap) {
    if (input.last) track(account.userId, "missed_tap_check_exhausted", { automation_id: run.automationId, step: input.step });
    return "waiting";
  }
  track(account.userId, "missed_tap_recovered", { automation_id: run.automationId, step: input.step, check: input.check });
  await handleTap(account.userId, { runId: run.id, senderId: igsid, adeliAccountId: account.adeliAccountId, source: "recovered" });
  return "recovered";
}
