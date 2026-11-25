import Link from "next/link";
import { redirect } from "next/navigation";
import { OnboardingLayout } from "@/components/onboarding/onboarding-layout";
import { ConnectToAgent } from "@/components/settings/agent-connect";
import { buttonVariants } from "@adeli-chat/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@adeli-chat/ui/components/card";
import { authEnabled } from "@/lib/auth/config";
import { requireUserPage } from "@/lib/auth/session";
import { getConnectedAccount } from "@/lib/data";
import { mcpResourceUrl } from "@/lib/mcp/config";
import { listConnectedApps } from "@/lib/mcp/connections";
import { ensureDefaultToken } from "@/lib/mcp/tokens";

export const dynamic = "force-dynamic";

export default async function ConnectAgentPage() {
  const user = await requireUserPage();
  if (!(await getConnectedAccount(user.id))) redirect("/connect");
  const [defaultToken, apps] = await Promise.all([ensureDefaultToken(user.id), listConnectedApps(user.id)]);
  return (
    <OnboardingLayout step="agent" user={user}>
      <Card>
        <CardHeader>
          <CardTitle>Connect your AI Agent</CardTitle>
          <CardDescription>Use your AI agent to create and manage automations. You can also connect one later.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <ConnectToAgent mcpUrl={mcpResourceUrl()} oauthEnabled={authEnabled()} apps={apps} defaultToken={defaultToken} />
          <div className="flex flex-wrap justify-end gap-3 border-t pt-4">
            <Link href="/connect/automation" className={buttonVariants({ variant: "ghost" })}>Skip for now</Link>
            <Link href="/connect/automation" className={buttonVariants()}>Continue</Link>
          </div>
        </CardContent>
      </Card>
    </OnboardingLayout>
  );
}
