import "server-only";

import { and, eq, sql } from "drizzle-orm";
import sharp from "sharp";

import { listAllMedia, listStories } from "@/lib/adeli/instagram";
import type { AdeliMedia } from "@/lib/adeli/types";
import { db, schema } from "@/lib/db";

import { storyExpired, type Automation, type MediaSnapshot } from "@adeli-chat/ui/automation/schemas";

/*
 * Instagram's image links are signed and stop working after a few days, so a
 * snapshot that kept the link would show a broken image in every list. When an
 * automation picks its post we keep a small copy of the image instead, as a
 * data URI in the snapshot. It never expires, even after a story is gone.
 */

/** Twice the largest place a thumbnail shows (the editor's 64x80), in the editor's 4:5. */
const WIDTH = 160;
const HEIGHT = 200;
const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 8_000;
/** Only Instagram's own CDN, so a link from the browser can't make the server fetch anything else. */
const INSTAGRAM_CDN = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/;

type Trigger = { mediaId: string | null; mediaSnapshot: MediaSnapshot | null };

export function isPinned(url: string | null | undefined): url is string {
  return !!url?.startsWith("data:image/");
}

/** A small JPEG copy of an Instagram image, as a data URI. Null when the link is not Instagram's, has expired, or isn't an image. */
export async function thumbnailDataUrl(url: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || !INSTAGRAM_CDN.test(parsed.hostname)) return null;
  try {
    const response = await fetch(parsed, { redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return null;
    if (Number(response.headers.get("content-length") ?? 0) > MAX_BYTES) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_BYTES) return null;
    const jpeg = await sharp(bytes).rotate().resize(WIDTH, HEIGHT, { fit: "cover" }).jpeg({ quality: 72 }).toBuffer();
    return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * The trigger with its thumbnail kept as a copy. A trigger still on the same
 * post as `previous` reuses the copy already saved, so an editor holding the
 * original (by then expired) link never replaces it. When the image can't be
 * fetched the link stays, and the list shows a placeholder if it breaks.
 */
export async function pinThumbnail<T extends Trigger>(trigger: T, previous?: Trigger | null): Promise<T> {
  const snapshot = trigger.mediaSnapshot;
  if (!snapshot?.thumbUrl || isPinned(snapshot.thumbUrl)) return trigger;
  const saved = previous?.mediaId && previous.mediaId === trigger.mediaId ? previous.mediaSnapshot?.thumbUrl : null;
  const thumbUrl = isPinned(saved) ? saved : (await thumbnailDataUrl(snapshot.thumbUrl)) ?? snapshot.thumbUrl;
  return { ...trigger, mediaSnapshot: { ...snapshot, thumbUrl } };
}

/** Saves a new thumbnail, only if nobody changed the old one meanwhile. Leaves `updatedAt` alone, so the list order doesn't move. */
async function replaceThumbnail(id: string, from: string, to: string | null) {
  await db().update(schema.automations)
    .set({ trigger: sql`jsonb_set(${schema.automations.trigger}, '{mediaSnapshot,thumbUrl}', coalesce(to_jsonb(${to}::text), 'null'::jsonb))` })
    .where(and(eq(schema.automations.id, id), sql`${schema.automations.trigger}->'mediaSnapshot'->>'thumbUrl' = ${from}`));
}

/**
 * Keeps a copy of the thumbnail of automations saved before thumbnails were
 * copied (their links have likely expired). Tries the saved link, then a fresh
 * one from Instagram. A thumbnail that is gone for good (an expired story, or
 * a post Instagram no longer lists) is cleared, so the list shows a
 * placeholder and this doesn't try again. Runs after the list renders.
 */
export async function repairThumbnails(userId: string, adeliAccountId: string, automations: Automation[]) {
  const stale = automations.filter((automation) => {
    const url = automation.trigger.mediaSnapshot?.thumbUrl;
    return !!url && !isPinned(url) && !!automation.trigger.mediaId;
  });
  let posts: Promise<AdeliMedia[]> | null = null;
  let stories: Promise<AdeliMedia[]> | null = null;
  for (const automation of stale) {
    const { mediaId, mediaSnapshot } = automation.trigger;
    const from = mediaSnapshot!.thumbUrl!;
    try {
      let pinned = await thumbnailDataUrl(from);
      if (!pinned) {
        let fresh: AdeliMedia | null | undefined;
        if (automation.type === "story_reply") {
          if (!storyExpired(automation)) {
            stories ??= listStories(userId, adeliAccountId);
            fresh = (await stories).find((story) => story.id === mediaId);
          }
        } else {
          posts ??= listAllMedia(userId, adeliAccountId);
          fresh = (await posts).find((post) => post.id === mediaId);
        }
        pinned = fresh?.thumbnailUrl ? await thumbnailDataUrl(fresh.thumbnailUrl) : null;
        // Gone for good: clear it. A fresh link that didn't load may work next time, so keep trying.
        if (!pinned && fresh) continue;
      }
      await replaceThumbnail(automation.id, from, pinned);
    } catch (error) {
      // Adeli didn't answer. Leave it and try again next time.
      console.error(`Thumbnail repair for ${automation.id} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
