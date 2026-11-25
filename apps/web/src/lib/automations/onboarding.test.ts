import { beforeEach, expect, it, vi } from "vitest";
import { db, schema } from "@/lib/db";
import { latestMedia } from "@/lib/adeli/instagram";
import { resetDatabase, seedAccount, seedUser } from "../../../test/db-helpers";
import { createFirstAutomation } from "./service";

vi.mock("@/lib/adeli/instagram", () => ({ latestMedia: vi.fn() }));
beforeEach(async () => {
  await resetDatabase();
  await seedUser("onboarding-user");
  await seedAccount("onboarding-user");
  vi.mocked(latestMedia).mockReset();
});

it("creates a draft with the latest post and placeholders, and reuses it on retry", async () => {
  vi.mocked(latestMedia).mockResolvedValue({ id: "latest", mediaType: "IMAGE", caption: "Latest post", thumbnailUrl: "https://example.com/post.jpg", permalink: "https://instagram.com/p/latest", publishedAt: "2026-11-25T12:00:00Z", likes: 0, comments: 0 });
  const first = await createFirstAutomation("onboarding-user");
  expect(await createFirstAutomation("onboarding-user")).toEqual(first);
  const rows = await db().select().from(schema.automations);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: "draft", liveAt: null, trigger: { mediaId: "latest", keywords: ["GUIDE"], postScope: "specific", mediaSnapshot: { caption: "Latest post" } }, finalDm: { buttons: [{ label: "Get the guide", url: "https://ledachat.com" }] } });
});

it("keeps an account without posts as a draft with no post selected", async () => {
  vi.mocked(latestMedia).mockResolvedValue(null);
  await createFirstAutomation("onboarding-user");
  const [row] = await db().select().from(schema.automations);
  expect(row).toMatchObject({ status: "draft", trigger: { mediaId: null, mediaSnapshot: null, postScope: "specific" } });
});

it("does not create a partial draft if fetching posts fails", async () => {
  vi.mocked(latestMedia).mockRejectedValue(new Error("Unavailable"));
  await expect(createFirstAutomation("onboarding-user")).rejects.toThrow("Unavailable");
  expect(await db().select().from(schema.automations)).toHaveLength(0);
});
