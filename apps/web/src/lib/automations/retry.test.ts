import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { listAutomationPeople } from "@/lib/audience";
import { db, schema } from "@/lib/db";

import { apiError, fakeAdeli } from "../../../test/fake-adeli";
import { resetDatabase, seedAccount, seedLiveAutomation, seedUser } from "../../../test/db-helpers";

import { retryRun, ServiceError } from "./service";

const USER = "user_1";
const DAY = 24 * 60 * 60_000;
let accountId: string;
let automationId: string;

async function seedRun(overrides: Partial<typeof schema.runs.$inferInsert> = {}) {
  const [run] = await db().insert(schema.runs).values({
    automationId,
    igUserId: "ig_fan",
    igUsername: "fan",
    commentId: "c_1",
    commentText: "Guide please",
    state: "failed",
    commentReplyState: "sent",
    error: "provider_error: The provider request failed",
    ...overrides,
  }).returning();
  return run;
}

async function runRow(id: string) {
  const [run] = await db().select().from(schema.runs).where(eq(schema.runs.id, id));
  return run;
}

beforeEach(async () => {
  await resetDatabase();
  await seedUser(USER);
  accountId = (await seedAccount(USER)).id;
  automationId = (await seedLiveAutomation(accountId)).id;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("retryRun", () => {
  it("sends a failed Opening DM again as a private reply to the comment, without the public reply", async () => {
    const run = await seedRun();
    const adeli = fakeAdeli();

    expect(await retryRun(USER, automationId, "ig_fan")).toEqual({ ok: true, stage: "opening_sent" });

    expect(adeli.comments()).toHaveLength(0);
    expect(adeli.messages()).toHaveLength(1);
    expect(adeli.messages()[0].body).toMatchObject({ accountId: "acc_1", recipient: { commentId: "c_1" }, buttons: [{ payload: run.id }] });
    const after = await runRow(run.id);
    expect(after).toMatchObject({ state: "opening_sent", error: null });
    expect(after.openingSentAt).toBeInstanceOf(Date);
  });

  it("returns Instagram's reason and keeps the run failed when it's refused again", async () => {
    const run = await seedRun();
    fakeAdeli([(sent) => sent.path === "/messages/instagram" ? apiError(422, "provider_rejected", "The comment is invalid for a private reply") : undefined]);

    const result = await retryRun(USER, automationId, "ig_fan");

    expect(result).toEqual({ ok: false, reason: "error", message: "Instagram didn't accept the Opening DM again. The comment is invalid for a private reply" });
    expect(await runRow(run.id)).toMatchObject({ state: "failed", error: "provider_rejected: The comment is invalid for a private reply" });
  });

  it("works on a paused automation", async () => {
    await db().update(schema.automations).set({ status: "paused" }).where(eq(schema.automations.id, automationId));
    await seedRun();
    fakeAdeli();
    expect(await retryRun(USER, automationId, "ig_fan")).toEqual({ ok: true, stage: "opening_sent" });
  });

  it("refuses a run whose Opening DM went out, and sends nothing", async () => {
    await seedRun({ state: "failed", openingSentAt: new Date(), error: "The tap came from a different Instagram account." });
    const adeli = fakeAdeli();
    await expect(retryRun(USER, automationId, "ig_fan")).rejects.toThrow(ServiceError);
    await expect(retryRun(USER, automationId, "ig_fan")).rejects.toThrow("Only someone whose Opening DM failed can be retried.");
    expect(adeli.sent).toHaveLength(0);
  });

  it("refuses a comment older than Instagram's 7 day private reply window", async () => {
    await seedRun({ createdAt: new Date(Date.now() - 8 * DAY) });
    const adeli = fakeAdeli();
    await expect(retryRun(USER, automationId, "ig_fan")).rejects.toThrow("Instagram only allows a DM within 7 days of their comment.");
    expect(adeli.sent).toHaveLength(0);
  });

  it("only reaches the user's own automations", async () => {
    await seedRun();
    await seedUser("user_2", { profileId: "profile_2" });
    const adeli = fakeAdeli();
    await expect(retryRun("user_2", automationId, "ig_fan")).rejects.toThrow(ServiceError);
    expect(adeli.sent).toHaveLength(0);
  });

  it("sends once when two retries race", async () => {
    await seedRun();
    const adeli = fakeAdeli([], { delayMs: 20 });
    const results = await Promise.allSettled([retryRun(USER, automationId, "ig_fan"), retryRun(USER, automationId, "ig_fan")]);
    expect(results.filter((result) => result.status === "fulfilled" && result.value.ok)).toHaveLength(1);
    expect(adeli.messages()).toHaveLength(1);
  });

  it("DMs a story reply's sender directly", async () => {
    await db().update(schema.automations).set({ type: "story_reply" }).where(eq(schema.automations.id, automationId));
    await seedRun({ commentId: "mid_story", igSenderId: "ig_fan", commentReplyState: "skipped" });
    const adeli = fakeAdeli();
    expect(await retryRun(USER, automationId, "ig_fan")).toEqual({ ok: true, stage: "opening_sent" });
    expect(adeli.messages()[0].body).toMatchObject({ recipient: { id: "ig_fan" } });
  });
});

describe("Audience canRetry", () => {
  it("is true only for a failed Opening DM inside the window", async () => {
    await seedRun({ igUserId: "ig_a", commentId: "c_a" });
    await seedRun({ igUserId: "ig_b", commentId: "c_b", createdAt: new Date(Date.now() - 8 * DAY) });
    await seedRun({ igUserId: "ig_c", commentId: "c_c", state: "opening_sent", openingSentAt: new Date(), error: null });
    const people = await listAutomationPeople(accountId, automationId);
    expect(Object.fromEntries(people.map((person) => [person.igUserId, person.canRetry]))).toEqual({ ig_a: true, ig_b: false, ig_c: false });
  });
});
