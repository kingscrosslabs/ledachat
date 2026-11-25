import "server-only";

export type Provider = "klaviyo" | "loops";
export function isProvider(value: unknown): value is Provider { return value === "klaviyo" || value === "loops"; }

export class ProviderError extends Error {
  constructor(public status: number, public retryAfter = 0) {
    super(status === 401 || status === 403 ? "API key rejected. Check its permissions and reconnect." : status === 429 ? "Provider rate limit reached. Retrying automatically." : status >= 500 || status === 0 ? "Provider unavailable. Retrying automatically." : "Provider rejected this contact. Check the email and retry.");
  }
}

async function request(provider: Provider, key: string, path: string, body?: unknown): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${provider === "klaviyo" ? "https://a.klaviyo.com/api" : "https://app.loops.so/api/v1"}${path}`, {
      method: body ? "POST" : "GET",
      headers: provider === "klaviyo" ? { Authorization: `Klaviyo-API-Key ${key}`, revision: "2026-10-15", "Content-Type": "application/vnd.api+json", accept: "application/vnd.api+json" } : { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(5000), cache: "no-store", redirect: "error",
    });
  } catch { throw new ProviderError(0); }
  // A create conflict in Loops means the contact already exists; never change its consent.
  if (!response.ok && !(provider === "loops" && path === "/contacts/create" && response.status === 409)) {
    const retry = response.headers.get("retry-after");
    const delay = retry ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : 0;
    throw new ProviderError(response.status, Number.isFinite(delay) ? Math.max(0, delay) : 0);
  }
  return response;
}

export async function validateKey(provider: Provider, key: string) {
  // Klaviyo requires Profiles read for validation and Profiles write for contact sync.
  await request(provider, key, provider === "klaviyo" ? "/profiles/?page[size]=1" : "/api-key");
}

export async function syncContact(provider: Provider, key: string, email: string) {
  if (provider === "klaviyo") {
    await request(provider, key, "/profile-import", { data: { type: "profile", attributes: { email, properties: { ledachat_source: "LedaChat" } } } });
  } else {
    await request(provider, key, "/contacts/create", { email, source: "LedaChat", subscribed: false });
  }
}
