import { after } from "next/server";

import { AutomationsView } from "@/components/automations/automations-view";
import { requireUserPage } from "@/lib/auth/session";
import { repairThumbnails } from "@/lib/automations/thumbnail";
import { listAutomations, requireAccount } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function AutomationsPage() {
  const user = await requireUserPage();
  const account = await requireAccount(user.id);
  const automations = await listAutomations(account.id);
  // Automations saved before thumbnails were copied get theirs fixed, for the next visit.
  after(() => repairThumbnails(user.id, account.accountId, automations));
  return <AutomationsView automations={automations} />;
}
