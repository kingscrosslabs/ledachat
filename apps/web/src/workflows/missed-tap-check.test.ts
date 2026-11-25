import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sleep: vi.fn<(ms: number) => Promise<void>>(async () => {}), check: vi.fn() }));
vi.mock("workflow", () => ({ sleep: mocks.sleep }));
vi.mock("@/lib/runtime/missed-taps", () => ({ checkMissedTap: mocks.check }));

import { MISSED_TAP_CHECK_DELAYS_MS, missedTapCheckWorkflow } from "./missed-tap-check";

const input = { runId: "run_1", step: "opening" as const, sentAt: "2026-11-25T17:20:54.000Z" };

beforeEach(() => {
  mocks.sleep.mockClear();
  mocks.check.mockReset();
});

describe("missed-tap check workflow", () => {
  it("checks at +1, +5 and +30 minutes, then gives up", async () => {
    mocks.check.mockResolvedValue("waiting");
    await expect(missedTapCheckWorkflow(input)).resolves.toBe("waiting");
    expect(mocks.sleep.mock.calls.map(([ms]) => ms)).toEqual([60_000, 240_000, 1_500_000]);
    expect(MISSED_TAP_CHECK_DELAYS_MS.reduce((total, ms) => total + ms, 0)).toBe(30 * 60_000);
    expect(mocks.check.mock.calls.map(([call]) => [call.check, call.last])).toEqual([[1, false], [2, false], [3, true]]);
  });

  it("stops at the first check that finds the tap or finds the run moved on", async () => {
    mocks.check.mockResolvedValueOnce("waiting").mockResolvedValueOnce("recovered");
    await expect(missedTapCheckWorkflow(input)).resolves.toBe("recovered");
    expect(mocks.check).toHaveBeenCalledTimes(2);

    mocks.check.mockReset().mockResolvedValueOnce("done");
    await expect(missedTapCheckWorkflow(input)).resolves.toBe("done");
    expect(mocks.check).toHaveBeenCalledTimes(1);
  });

  it("treats a check that throws as nothing found yet", async () => {
    mocks.check.mockRejectedValueOnce(new Error("database down")).mockResolvedValueOnce("recovered");
    await expect(missedTapCheckWorkflow(input)).resolves.toBe("recovered");
    expect(mocks.check).toHaveBeenCalledTimes(2);
  });
});
