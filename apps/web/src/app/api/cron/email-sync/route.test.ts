import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/email-integrations/service", () => ({ processEmailJobs: vi.fn() }));
import { processEmailJobs } from "@/lib/email-integrations/service";
import { GET } from "./route";
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe("email sync cron", () => {
  it("fails closed without a configured secret", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await GET(new Request("https://example.com/api/cron/email-sync"))).status).toBe(401);
    expect(processEmailJobs).not.toHaveBeenCalled();
  });
  it("rejects invalid authorization and processes only authenticated requests", async () => {
    vi.stubEnv("CRON_SECRET", "test-secret");
    expect((await GET(new Request("https://example.com", { headers: { Authorization: "Bearer wrong" } }))).status).toBe(401);
    expect(processEmailJobs).not.toHaveBeenCalled();
    expect((await GET(new Request("https://example.com", { headers: { Authorization: "Bearer test-secret" } }))).status).toBe(200);
    expect(processEmailJobs).toHaveBeenCalledTimes(1);
  });
});
