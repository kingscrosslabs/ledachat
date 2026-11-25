"use client";

import { useState } from "react";
import { Mail } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@adeli-chat/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@adeli-chat/ui/components/card";
import { Input } from "@adeli-chat/ui/components/input";
import { Label } from "@adeli-chat/ui/components/label";
import { changeEmailConnection, testEmailConnection } from "@/lib/email-integrations/actions";
import type { ConnectionStatus } from "@/lib/email-integrations/service";

export function EmailIntegrations({ connections }: { connections: ConnectionStatus[] }) {
  return <Card>
    <CardHeader><CardTitle className="flex items-center gap-2"><Mail className="size-4 text-link" aria-hidden="true" />Email integrations</CardTitle><CardDescription>Send contacts from DM automations to your email provider automatically</CardDescription></CardHeader>
    <CardContent className="space-y-6">
      {(["klaviyo", "loops"] as const).map((provider) => <ProviderConnection key={provider} provider={provider} connection={connections.find((item) => item.provider === provider)} />)}
    </CardContent>
  </Card>;
}

function ProviderConnection({ provider, connection }: { provider: "klaviyo" | "loops"; connection?: ConnectionStatus }) {
  const router = useRouter();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [testEmail, setTestEmail] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState("");
  const name = provider === "klaviyo" ? "Klaviyo" : "Loops";
  async function act(operation: "connect" | "disconnect" | "retry") {
    setBusy(true);
    try {
      const result = await changeEmailConnection(provider, operation, key);
      if (!result.ok) toast.error(result.error);
      else { setKey(""); toast.success(operation === "connect" ? `${name} connected` : operation === "disconnect" ? `${name} disconnected` : "Retry queued"); router.refresh(); }
    } catch { toast.error("Couldn't update the connection. Try again."); }
    finally { setBusy(false); }
  }
  async function sendTest() {
    setBusy(true);
    setTesting(true);
    setTestResult("");
    try {
      const result = await testEmailConnection(provider, testEmail);
      setTestResult(result.ok ? `Connection verified. Look for ${testEmail.trim()} in ${name}. Existing contacts are left in place.` : result.error ?? "Test failed.");
      router.refresh();
    } catch { setTestResult("Couldn't send the test contact. Try again."); }
    finally { setBusy(false); setTesting(false); }
  }
  return <section className="space-y-3 border-t pt-4" aria-label={name}>
    <div className="flex items-center justify-between gap-2"><h3 className="font-medium">{name}</h3><span className="text-sm" role="status">{connection ? connection.blocked ? "Reconnect required" : "Connected" : "Not connected"}</span></div>
    {connection && <div className="space-y-1 text-sm text-muted-foreground">
      <p>{connection.pending} pending · {connection.failed} failed · {connection.lastSyncedAt ? `Last synced ${new Date(connection.lastSyncedAt).toLocaleString()}` : "Waiting for the first contact"}</p>
      {connection.blocked && <p>Disconnect, then connect again with a valid API key.</p>}
      {connection.failed > 0 && !connection.blocked && <p>Some contacts could not be added. Check their email addresses or retry after resolving the provider issue.</p>}
    </div>}
    {!connection && <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void act("connect"); }}>
      <Label htmlFor={`${provider}-key`}>API key</Label>
      <div className="flex gap-2"><Input id={`${provider}-key`} type="password" autoComplete="new-password" value={key} maxLength={512} onChange={(event) => setKey(event.target.value)} placeholder={`Paste your ${name} API key`} disabled={busy} /><Button disabled={busy || !key.trim()} type="submit">{busy ? "Saving…" : "Connect"}</Button></div>
      <p className="text-xs text-muted-foreground">{provider === "klaviyo" ? "Create a private key with Profiles: Read and Write access in Klaviyo → Settings → API keys." : "Create a key in Loops → Settings → API. New contacts are added without a marketing subscription."}</p>
    </form>}
    {connection && <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void sendTest(); }}>
      <Label htmlFor={`${provider}-test-email`}>Test contact email</Label>
      <div className="flex flex-wrap gap-2">
        <Input className="min-w-48 flex-1" id={`${provider}-test-email`} type="email" required maxLength={254} placeholder="you@example.com" value={testEmail} disabled={busy} onChange={(event) => { setTestEmail(event.target.value); setTestResult(""); }} />
        <Button variant="outline" type="submit" disabled={busy || !testEmail.trim()}>{testing ? "Sending…" : "Send test contact"}</Button>
      </div>
      <p className="text-xs text-muted-foreground">Adds a real contact to {name}. Use an email you control. No email is sent by LedaChat.</p>
      {testResult && <p className="text-sm" role="status">{testResult}</p>}
    </form>}
    {connection && <div className="flex flex-wrap gap-2">
      {connection.failed > 0 && !connection.blocked && <Button variant="outline" disabled={busy} onClick={() => void act("retry")}>Retry failed contacts</Button>}
      <Button variant="outline" disabled={busy} onClick={() => router.refresh()}>Refresh status</Button>
      <Button variant="destructive" disabled={busy} onClick={() => void act("disconnect")}>Disconnect</Button>
      <p className="w-full text-xs text-muted-foreground">Disconnecting cancels pending syncs. Contacts already in {name} stay there.</p>
    </div>}
  </section>;
}
