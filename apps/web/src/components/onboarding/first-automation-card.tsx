"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@adeli-chat/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@adeli-chat/ui/components/card";
import { createFirstAutomation } from "@/lib/actions";

export function FirstAutomationCard() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  function create() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await createFirstAutomation();
        if (!result.ok) {
          setError(result.reason === "invalid" ? "Couldn't prepare your draft. Please try again." : result.message);
          return;
        }
        router.push("/automations");
      } catch {
        setError("Couldn't create your draft. Please try again.");
      }
    });
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Create your first automation</CardTitle>
        <CardDescription>Start with a ready-to-edit Comment to DM draft. Nothing sends until you review it and go live.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <dl className="space-y-4 rounded-lg border bg-muted/40 p-4 text-sm">
          <div><dt className="font-medium">Post</dt><dd className="text-muted-foreground">Your most recent Instagram post.</dd></div>
          <div><dt className="font-medium">Comment keyword</dt><dd className="text-muted-foreground">GUIDE</dd></div>
          <div><dt className="font-medium">Public reply</dt><dd className="text-muted-foreground">Sent you a DM! 📩</dd></div>
          <div><dt className="font-medium">Opening message</dt><dd className="text-muted-foreground">Hey there! Click below and I&apos;ll send you the link in a second.</dd></div>
          <div><dt className="font-medium">Guide message</dt><dd className="text-muted-foreground">Here&apos;s your guide! Tap below to take a look.</dd></div>
          <div><dt className="font-medium">Link</dt><dd className="text-muted-foreground">ledachat.com</dd></div>
        </dl>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <div className="flex justify-end"><Button size="lg" onClick={create} disabled={pending}>{pending ? <Loader2 className="animate-spin" /> : null}{pending ? "Creating draft…" : "Create my first draft"}</Button></div>
      </CardContent>
    </Card>
  );
}
