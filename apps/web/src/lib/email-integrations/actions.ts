"use server";

import { z } from "zod";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireUserId } from "@/lib/auth/session";
import { isProvider, ProviderError } from "./providers";
import { sendTestContact, AlreadyConnectedError, connectProvider, disconnectProvider, processEmailJobs, retryProvider } from "./service";

export async function changeEmailConnection(provider: unknown, operation: unknown, apiKey?: string) {
  const userId = await requireUserId();
  if (!isProvider(provider) || !["connect", "disconnect", "retry"].includes(String(operation))) return { ok: false, error: "Invalid integration action." };
  try {
    if (operation === "connect") {
      if (typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 512 || /[\r\n]/.test(apiKey)) return { ok: false, error: "Enter a valid API key." };
      await connectProvider(userId, provider, apiKey.trim());
    } else if (operation === "disconnect") await disconnectProvider(userId, provider);
    else await retryProvider(userId, provider);
    if (operation !== "disconnect") after(() => processEmailJobs(userId));
    revalidatePath("/settings");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof ProviderError || error instanceof AlreadyConnectedError ? error.message : "Couldn't save this connection. Please try again." };
  }
}

export async function testEmailConnection(provider: unknown, email: unknown) {
  const userId = await requireUserId();
  if (!isProvider(provider)) return { ok: false, error: "Invalid provider." };
  const parsed = z.string().trim().email().max(254).safeParse(email);
  if (!parsed.success) return { ok: false, error: "Enter a valid test email address." };
  try {
    const result = await sendTestContact(userId, provider, parsed.data.toLowerCase());
    revalidatePath("/settings");
    return result;
  } catch { return { ok: false, error: "Couldn't send the test contact. Please try again." }; }
}
