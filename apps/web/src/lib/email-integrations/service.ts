import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { db, schema, type Database } from "@/lib/db";
import { openSecret, sealSecret } from "@/lib/secret-box";
import { ProviderError, syncContact, validateKey, type Provider } from "./providers";

const { emailConnections: connections, emailSyncJobs: jobs } = schema;

export class AlreadyConnectedError extends Error {
  constructor() { super("Disconnect this provider before adding a different API key."); }
}

export async function connectProvider(userId: string, provider: Provider, key: string) {
  await validateKey(provider, key);
  const [connection] = await db().insert(connections).values({ userId, provider, secret: sealSecret(key) })
    .onConflictDoNothing({ target: [connections.userId, connections.provider] }).returning({ id: connections.id });
  if (!connection) throw new AlreadyConnectedError();
}

export async function disconnectProvider(userId: string, provider: Provider) {
  // Cascading deletion cancels queued work. A currently running request finishes first.
  await db().delete(connections).where(and(eq(connections.userId, userId), eq(connections.provider, provider)));
}

export async function retryProvider(userId: string, provider: Provider) {
  await db().transaction(async (tx) => {
    const [connection] = await tx.select().from(connections).where(and(eq(connections.userId, userId), eq(connections.provider, provider))).for("update");
    if (!connection || connection.blocked) return;
    await tx.update(jobs).set({ state: "pending", attempts: 0, error: null, nextAttemptAt: new Date() }).where(and(eq(jobs.connectionId, connection.id), eq(jobs.state, "failed")));
  });
}

/** Called inside the SAME transaction as lead capture. Email-only identity avoids duplicate contacts across automations. */
export async function enqueueContact(tx: Pick<Database, "select" | "insert">, userId: string, email: string) {
  const destinations = await tx.select({ id: connections.id }).from(connections).where(eq(connections.userId, userId)).for("key share");
  if (destinations.length) await tx.insert(jobs).values(destinations.map(({ id }) => ({ connectionId: id, email: email.trim().toLowerCase() }))).onConflictDoNothing();
}

/** Bounded worker. Transaction locks serialize a destination and release automatically after crashes.
 * External delivery is at-least-once; provider upsert/create-conflict makes replay safe.
 */
export async function processEmailJobs(userId?: string) {
  const deadline = Date.now() + 40000;
  for (let i = 0; i < 100 && Date.now() < deadline; i++) {
    const processed = await db().transaction(async (tx) => {
      const [connection] = await tx.select().from(connections).where(and(
        eq(connections.blocked, false), userId ? eq(connections.userId, userId) : undefined,
        sql`exists (select 1 from email_sync_jobs j where j.connection_id = "email_connections"."id" and j.state = 'pending' and j.next_attempt_at <= now())`,
      )).orderBy(connections.updatedAt).limit(1).for("update", { skipLocked: true });
      if (!connection) return false;
      const [job] = await tx.select().from(jobs).where(and(eq(jobs.connectionId, connection.id), eq(jobs.state, "pending"), sql`${jobs.nextAttemptAt} <= now()`)).orderBy(jobs.nextAttemptAt).limit(1).for("update");
      if (!job) return false;
      try {
        const key = openSecret(connection.secret);
        if (!key) throw new ProviderError(401);
        await syncContact(connection.provider, key, job.email);
        await tx.update(jobs).set({ state: "synced", error: null, updatedAt: new Date() }).where(eq(jobs.id, job.id));
        await tx.update(connections).set({ lastSyncedAt: new Date(), updatedAt: new Date() }).where(eq(connections.id, connection.id));
      } catch (error) {
        const failure = error instanceof ProviderError ? error : new ProviderError(0);
        const attempts = job.attempts + 1;
        const auth = failure.status === 401 || failure.status === 403;
        const transient = failure.status === 0 || failure.status === 408 || failure.status === 429 || failure.status >= 500;
        await tx.update(jobs).set({ attempts, state: transient && attempts < 8 ? "pending" : "failed", error: failure.message, nextAttemptAt: new Date(Date.now() + Math.max(failure.retryAfter, Math.min(3600000, 60000 * 2 ** (attempts - 1)))), updatedAt: new Date() }).where(eq(jobs.id, job.id));
        await tx.update(connections).set({ blocked: auth, updatedAt: new Date() }).where(eq(connections.id, connection.id));
      }
      return true;
    });
    if (!processed) break;
  }
}

export async function connectionStatuses(userId: string) {
  const rows = await db().select({ provider: connections.provider, blocked: connections.blocked, lastSyncedAt: connections.lastSyncedAt,
    pending: sql<number>`(select count(*)::int from email_sync_jobs j where j.connection_id = "email_connections"."id" and j.state = 'pending')`,
    failed: sql<number>`(select count(*)::int from email_sync_jobs j where j.connection_id = "email_connections"."id" and j.state = 'failed')`,
  }).from(connections).where(eq(connections.userId, userId));
  return rows.map((row) => ({ ...row, lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null }));
}
export type ConnectionStatus = Awaited<ReturnType<typeof connectionStatuses>>[number];

/** Sends immediately using the same adapter as real captures, without creating a fake lead. */
export async function sendTestContact(userId: string, provider: Provider, email: string) {
  return db().transaction(async (tx) => {
    const [connection] = await tx.select().from(connections)
      .where(and(eq(connections.userId, userId), eq(connections.provider, provider))).for("update");
    if (!connection) return { ok: false, error: "Connect this provider first." };
    const key = openSecret(connection.secret);
    if (!key) return { ok: false, error: "Disconnect and connect again with a valid API key." };
    try {
      await syncContact(provider, key, email);
      await tx.update(connections).set({ lastSyncedAt: new Date(), blocked: false, updatedAt: new Date() }).where(eq(connections.id, connection.id));
      return { ok: true };
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      if (error.status === 401 || error.status === 403) await tx.update(connections).set({ blocked: true }).where(eq(connections.id, connection.id));
      return { ok: false, error: error.message.replace("Retrying automatically.", "Please try again shortly.") };
    }
  });
}
