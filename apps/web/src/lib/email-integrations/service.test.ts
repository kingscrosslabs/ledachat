import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { resetDatabase, seedUser } from "../../../test/db-helpers";
import { sendTestContact, connectProvider, connectionStatuses, disconnectProvider, enqueueContact, processEmailJobs, retryProvider } from "./service";
import { syncContact } from "./providers";

const fetchMock = vi.fn();
beforeEach(async () => { await resetDatabase(); await seedUser(); vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset().mockImplementation(async () => Response.json({ success: true })); });
afterEach(() => vi.unstubAllGlobals());
const enqueue = (email = "fan@example.com", user = "user_1") => db().transaction((tx) => enqueueContact(tx, user, email));

describe("email provider sync", () => {
  it("encrypts keys, scopes connections and deduplicates captures", async () => {
    await seedUser("user_2");
    await connectProvider("user_1", "klaviyo", "private-key");
    await connectProvider("user_2", "loops", "other-key");
    await enqueue("Fan@example.com"); await enqueue("fan@example.com");
    const rows = await db().select().from(schema.emailSyncJobs);
    expect(rows).toHaveLength(1);
    expect((await db().select().from(schema.emailConnections))[0].secret).not.toContain("private-key");
    await processEmailJobs("user_2");
    expect(fetchMock).toHaveBeenCalledTimes(2); // validation only
    await processEmailJobs("user_1");
    const [url, options] = fetchMock.mock.calls[2];
    expect(url).toContain("profile-import");
    expect(JSON.parse(options.body).data.attributes).toEqual({ email: "fan@example.com", properties: { ledachat_source: "LedaChat" } });
    expect((await connectionStatuses("user_1"))[0].lastSyncedAt).not.toBeNull();
    await enqueue(); await processEmailJobs();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("creates Loops contacts without subscribing and leaves existing contacts untouched", async () => {
    await syncContact("loops", "key", "fan@example.com");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ email: "fan@example.com", source: "LedaChat", subscribed: false });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 409 }));
    await expect(syncContact("loops", "key", "fan@example.com")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rolls back queued contacts with their enclosing transaction", async () => {
    await connectProvider("user_1", "loops", "key");
    await expect(db().transaction(async (tx) => { await enqueueContact(tx, "user_1", "fan@example.com"); throw new Error("rollback"); })).rejects.toThrow("rollback");
    expect(await db().select().from(schema.emailSyncJobs)).toHaveLength(0);
  });

  it("honors Retry-After without blocking the other provider", async () => {
    await connectProvider("user_1", "klaviyo", "key"); await connectProvider("user_1", "loops", "key"); await enqueue();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": "600" } }));
    await processEmailJobs();
    const rows = await db().select().from(schema.emailSyncJobs);
    expect(rows.filter((row) => row.state === "synced")).toHaveLength(1);
    const pending = rows.find((row) => row.state === "pending")!;
    expect(pending.attempts).toBe(1);
    expect(pending.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 590000);
    await db().update(schema.emailSyncJobs).set({ nextAttemptAt: new Date(0) }).where(eq(schema.emailSyncJobs.id, pending.id));
    await processEmailJobs();
    expect((await connectionStatuses("user_1")).every((row) => row.pending === 0)).toBe(true);
  });

  it("blocks rejected keys and requires disconnect before replacing them", async () => {
    await connectProvider("user_1", "loops", "key"); await enqueue();
    fetchMock.mockResolvedValueOnce(new Response("secret-provider-error", { status: 401 }));
    await processEmailJobs(); await enqueue("second@example.com");
    expect((await connectionStatuses("user_1"))[0].blocked).toBe(true);
    const calls = fetchMock.mock.calls.length; await processEmailJobs(); expect(fetchMock).toHaveBeenCalledTimes(calls);
    expect((await db().select().from(schema.emailSyncJobs))[0].error).not.toContain("secret-provider-error");
    await expect(connectProvider("user_1", "loops", "new-key")).rejects.toThrow("Disconnect this provider");
    expect((await connectionStatuses("user_1"))[0].blocked).toBe(true);
    await disconnectProvider("user_1", "loops");
    await connectProvider("user_1", "loops", "new-key");
    await enqueue("fresh@example.com");
    await processEmailJobs();
    expect((await connectionStatuses("user_1"))[0]).toMatchObject({ blocked: false, pending: 0, failed: 0 });
  });

  it("allows retry of permanent failures and disconnect cancels queued work only for its owner", async () => {
    await connectProvider("user_1", "loops", "key"); await enqueue();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 400 })); await processEmailJobs();
    expect((await connectionStatuses("user_1"))[0].failed).toBe(1);
    await retryProvider("user_2", "loops"); expect((await connectionStatuses("user_1"))[0].failed).toBe(1);
    await retryProvider("user_1", "loops"); await processEmailJobs();
    expect((await connectionStatuses("user_1"))[0].failed).toBe(0);
    await enqueue("new@example.com"); await disconnectProvider("user_2", "loops");
    expect(await connectionStatuses("user_1")).toHaveLength(1);
    await disconnectProvider("user_1", "loops");
    expect(await db().select().from(schema.emailSyncJobs)).toHaveLength(0);
  });
});


describe("send test contact", () => {
  it("uses the connected key and updates status without creating a lead or queue job", async () => {
    await connectProvider("user_1", "loops", "real-test-key");
    expect(await sendTestContact("user_1", "loops", "test@example.com")).toEqual({ ok: true });
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer real-test-key");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ email: "test@example.com", subscribed: false });
    expect((await connectionStatuses("user_1"))[0].lastSyncedAt).not.toBeNull();
    expect(await db().select().from(schema.leads)).toHaveLength(0);
    expect(await db().select().from(schema.emailSyncJobs)).toHaveLength(0);
  });
  it("cannot use another customer's connection and reports failures without claiming a retry", async () => {
    await connectProvider("user_1", "loops", "key");
    expect((await sendTestContact("user_2", "loops", "test@example.com")).ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    const result = await sendTestContact("user_1", "loops", "test@example.com");
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain("automatically");
    expect((await connectionStatuses("user_1"))[0].lastSyncedAt).toBeNull();
  });
});
