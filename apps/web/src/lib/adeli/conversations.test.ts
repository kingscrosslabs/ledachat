import { afterEach, describe, expect, it, vi } from "vitest";

import { fakeAdeli } from "../../../test/fake-adeli";

import { readConversation } from "./conversations";

afterEach(() => vi.unstubAllGlobals());

describe("readConversation", () => {
  // @adeli/sdk 0.9.0 predates GET /messages/instagram/conversations/:igsid. Once the SDK is bumped, this becomes a fake-fetch test of the read.
  it("reports the read unavailable, without calling Adeli, while the SDK has no conversation read", async () => {
    const adeli = fakeAdeli();
    await expect(readConversation("acc_1", "ig_fan")).resolves.toEqual({ available: false });
    expect(adeli.sent).toHaveLength(0);
  });
});
