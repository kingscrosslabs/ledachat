import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultAutomationContent } from "@adeli-chat/ui/automation/defaults";
import type { MediaSnapshot } from "@adeli-chat/ui/automation/schemas";
import { listAllMedia, listStories } from "@/lib/adeli/instagram";
import type { AdeliMedia } from "@/lib/adeli/types";
import { getAutomation, listAutomations } from "@/lib/data";
import { db, schema } from "@/lib/db";

import { resetDatabase, seedAccount, seedLiveAutomation, seedUser } from "../../../test/db-helpers";

import { saveAutomation } from "./service";
import { pinThumbnail, repairThumbnails, thumbnailDataUrl } from "./thumbnail";

vi.mock("@/lib/adeli/instagram", async (original) => ({ ...(await original()), listAllMedia: vi.fn(), listStories: vi.fn() }));

const USER = "user_1";
const LIVE = "https://scontent.cdninstagram.com/v/live.jpg?oe=1";
const EXPIRED = "https://scontent.cdninstagram.com/v/expired.jpg?oe=0";
const FRESH = "https://scontent-lga3-1.xx.fbcdn.net/v/fresh.jpg?oe=2";
let png: Buffer;
let accountId: string;
let adeliAccountId: string;
const fetchMock = vi.fn<typeof fetch>();

function snapshot(thumbUrl: string | null, extra: Partial<MediaSnapshot> = {}): MediaSnapshot {
  return { thumbUrl, mediaType: "IMAGE", caption: "A post", permalink: "https://instagram.com/p/1", publishedAt: "2026-11-01T00:00:00Z", ...extra };
}

function media(id: string, thumbnailUrl: string): AdeliMedia {
  return { id, mediaType: "IMAGE", caption: "", thumbnailUrl, permalink: "", publishedAt: "2026-11-01T00:00:00Z", likes: 0, comments: 0 };
}

async function seed(mediaId: string, thumbUrl: string | null, type: "comment_to_dm" | "story_reply" = "comment_to_dm") {
  const trigger = { ...defaultAutomationContent(0, type).trigger, mediaId, mediaSnapshot: snapshot(thumbUrl) };
  return (await seedLiveAutomation(accountId, { type, trigger })).id;
}

async function thumbOf(id: string) {
  const [row] = await db().select().from(schema.automations).where(eq(schema.automations.id, id));
  return row.trigger.mediaSnapshot?.thumbUrl;
}

beforeAll(async () => {
  png = await sharp({ create: { width: 1080, height: 1350, channels: 3, background: "#d84a8a" } }).png().toBuffer();
});

beforeEach(async () => {
  await resetDatabase();
  await seedUser(USER);
  const account = await seedAccount(USER);
  accountId = account.id;
  adeliAccountId = account.adeliAccountId;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    return url === LIVE || url === FRESH ? new Response(new Uint8Array(png), { headers: { "content-type": "image/png" } }) : new Response("URL signature expired", { status: 403 });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(listAllMedia).mockReset();
  vi.mocked(listStories).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("thumbnailDataUrl", () => {
  it("keeps a small JPEG copy of an Instagram image", async () => {
    const url = await thumbnailDataUrl(LIVE);
    expect(url).toMatch(/^data:image\/jpeg;base64,/);
    const { width, height } = await sharp(Buffer.from(url!.split(",")[1], "base64")).metadata();
    expect({ width, height }).toEqual({ width: 160, height: 200 });
  });

  it("returns null for an expired link", async () => {
    expect(await thumbnailDataUrl(EXPIRED)).toBeNull();
  });

  it("never fetches anything but Instagram's CDN over https", async () => {
    for (const url of ["https://example.com/a.jpg", "http://scontent.cdninstagram.com/a.jpg", "https://cdninstagram.com.evil.test/a.jpg", "http://169.254.169.254/latest", "not a url"]) {
      expect(await thumbnailDataUrl(url)).toBeNull();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("pinThumbnail", () => {
  it("reuses the copy already saved for the same post instead of the link the editor still holds", async () => {
    const saved = { mediaId: "post_1", mediaSnapshot: snapshot("data:image/jpeg;base64,c2F2ZWQ=") };
    const pinned = await pinThumbnail({ mediaId: "post_1", mediaSnapshot: snapshot(EXPIRED) }, saved);
    expect(pinned.mediaSnapshot?.thumbUrl).toBe("data:image/jpeg;base64,c2F2ZWQ=");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("copies the thumbnail of a newly picked post", async () => {
    const saved = { mediaId: "post_1", mediaSnapshot: snapshot("data:image/jpeg;base64,c2F2ZWQ=") };
    const pinned = await pinThumbnail({ mediaId: "post_2", mediaSnapshot: snapshot(LIVE) }, saved);
    expect(pinned.mediaSnapshot?.thumbUrl).toMatch(/^data:image\/jpeg;base64,/);
    expect(pinned.mediaSnapshot?.thumbUrl).not.toBe("data:image/jpeg;base64,c2F2ZWQ=");
  });

  it("keeps the link when the image can't be fetched", async () => {
    const pinned = await pinThumbnail({ mediaId: "post_1", mediaSnapshot: snapshot(EXPIRED) });
    expect(pinned.mediaSnapshot?.thumbUrl).toBe(EXPIRED);
  });
});

describe("saving an automation", () => {
  it("stores a copy of the picked post's thumbnail", async () => {
    const id = await seed("post_1", null);
    await db().update(schema.automations).set({ status: "draft" }).where(eq(schema.automations.id, id));
    const automation = (await getAutomation(accountId, id))!;
    const result = await saveAutomation(USER, id, { ...automation, trigger: { ...automation.trigger, mediaId: "post_2", mediaSnapshot: snapshot(LIVE) } });
    expect(result).toEqual({ ok: true });
    expect(await thumbOf(id)).toMatch(/^data:image\/jpeg;base64,/);
  });
});

describe("repairThumbnails", () => {
  it("copies a link that still works, without asking Adeli", async () => {
    const id = await seed("post_1", LIVE);
    await repairThumbnails(USER, adeliAccountId, await listAutomations(accountId));
    expect(await thumbOf(id)).toMatch(/^data:image\/jpeg;base64,/);
    expect(listAllMedia).not.toHaveBeenCalled();
  });

  it("fetches a fresh link for an expired post thumbnail, with one Adeli call for every automation", async () => {
    const first = await seed("post_1", EXPIRED);
    const second = await seed("post_2", EXPIRED);
    vi.mocked(listAllMedia).mockResolvedValue([media("post_1", FRESH), media("post_2", FRESH)]);
    await repairThumbnails(USER, adeliAccountId, await listAutomations(accountId));
    expect(await thumbOf(first)).toMatch(/^data:image\/jpeg;base64,/);
    expect(await thumbOf(second)).toMatch(/^data:image\/jpeg;base64,/);
    expect(listAllMedia).toHaveBeenCalledTimes(1);
  });

  it("clears the thumbnail of an expired story, which Instagram no longer has", async () => {
    const id = await seed("story_1", EXPIRED, "story_reply");
    await repairThumbnails(USER, adeliAccountId, await listAutomations(accountId));
    expect(await thumbOf(id)).toBeNull();
    expect(listStories).not.toHaveBeenCalled();
  });

  it("leaves the thumbnail for next time when Adeli doesn't answer", async () => {
    const id = await seed("post_1", EXPIRED);
    vi.mocked(listAllMedia).mockRejectedValue(new Error("Adeli is down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await repairThumbnails(USER, adeliAccountId, await listAutomations(accountId));
    expect(await thumbOf(id)).toBe(EXPIRED);
  });

  it("leaves automations that already have a copy alone", async () => {
    const id = await seed("post_1", "data:image/jpeg;base64,c2F2ZWQ=");
    await repairThumbnails(USER, adeliAccountId, await listAutomations(accountId));
    expect(await thumbOf(id)).toBe("data:image/jpeg;base64,c2F2ZWQ=");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
