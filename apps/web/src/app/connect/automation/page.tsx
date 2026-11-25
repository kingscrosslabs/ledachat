import { redirect } from "next/navigation";
import { OnboardingLayout } from "@/components/onboarding/onboarding-layout";
import { FirstAutomationCard } from "@/components/onboarding/first-automation-card";
import { requireUserPage } from "@/lib/auth/session";
import { getConnectedAccount, listAutomations } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function FirstAutomationPage() {
  const user = await requireUserPage();
  const account = await getConnectedAccount(user.id);
  if (!account) redirect("/connect");
  if ((await listAutomations(account.id)).length) redirect("/automations");
  return <OnboardingLayout step="automation" user={user}><FirstAutomationCard /></OnboardingLayout>;
}
