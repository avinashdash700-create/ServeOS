import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Sparkles, BellRing, Mail, Clock, Info } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/lib/auth";
import { toast } from "sonner";
import {
  getOutreachWebhook, setOutreachWebhook,
  getFollowupWebhook, setFollowupWebhook,
  getGmailSendWebhook, setGmailSendWebhook,
} from "@/lib/outreach";
import {
  FOLLOW_UP_INTERVAL_OPTIONS, DEFAULT_FOLLOW_UP_INTERVAL, isDemoInterval,
  type FollowUpIntervalKey,
} from "@/lib/follow-up-interval";

export const Route = createFileRoute("/_app/settings")({
  head: () => ({ meta: [{ title: "Settings — ServeOS" }] }),
  component: SettingsPage,
});


function SettingsPage() {
  const { user } = useSession();
  const [fullName, setFullName] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [outreachUrl, setOutreachUrl] = useState("");
  const [followupUrl, setFollowupUrl] = useState("");
  const [gmailUrl, setGmailUrl] = useState("");
  const [interval, setIntervalKey] = useState<FollowUpIntervalKey>(DEFAULT_FOLLOW_UP_INTERVAL);
  const [savingInterval, setSavingInterval] = useState(false);

  useEffect(() => {
    setOutreachUrl(getOutreachWebhook());
    setFollowupUrl(getFollowupWebhook());
    setGmailUrl(getGmailSendWebhook());
  }, []);

  const saveWebhooks = () => {
    setOutreachWebhook(outreachUrl.trim());
    setFollowupWebhook(followupUrl.trim());
    setGmailSendWebhook(gmailUrl.trim());
    toast.success("Webhooks saved");
  };



  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data } = await supabase
        .from("profiles")
        .select("full_name, business_name, email, follow_up_interval")
        .eq("id", user.id)
        .maybeSingle();
      setFullName(data?.full_name ?? "");
      setBusinessName(data?.business_name ?? "");
      setEmail(data?.email ?? user.email ?? "");
      const fi = (data as { follow_up_interval?: string } | null)?.follow_up_interval;
      if (fi && FOLLOW_UP_INTERVAL_OPTIONS.some((o) => o.value === fi)) {
        setIntervalKey(fi as FollowUpIntervalKey);
      }
    })();
  }, [user]);

  const saveInterval = async (next: FollowUpIntervalKey) => {
    if (!user) return;
    setIntervalKey(next);
    setSavingInterval(true);
    const { error } = await supabase
      .from("profiles")
      .update({ follow_up_interval: next, updated_at: new Date().toISOString() })
      .eq("id", user.id);
    setSavingInterval(false);
    if (error) toast.error(error.message);
    else toast.success("Follow-up interval updated");
  };


  const save = async () => {
    if (!user) return;
    setSaving(true);
    const { error } = await supabase.from("profiles").upsert({
      id: user.id,
      full_name: fullName,
      business_name: businessName,
      email,
      updated_at: new Date().toISOString(),
    });
    setSaving(false);
    if (error) toast.error(error.message);
    else toast.success("Settings saved");
  };

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">Tune ServeOS to your workflow.</p>
      </div>

      <Card className="border-border/60 shadow-[var(--shadow-soft)]">
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>How you appear in your outreach.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5"><Label>Full name</Label><Input value={fullName} onChange={(e) => setFullName(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Email</Label><Input value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <div className="space-y-1.5 sm:col-span-2"><Label>Business</Label><Input value={businessName} onChange={(e) => setBusinessName(e.target.value)} /></div>
        </CardContent>
      </Card>

      <Card className="border-border/60 shadow-[var(--shadow-soft)]">
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <Clock className="h-4 w-4" />
                </span>
                Follow-Up Configuration
              </CardTitle>
              <CardDescription className="mt-1">
                Choose how long after a successful send a follow-up reminder should appear.
              </CardDescription>
            </div>
            {isDemoInterval(interval) && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge className="gap-1.5 border-amber-300 bg-amber-100 text-amber-800 hover:bg-amber-100">
                      <Info className="h-3 w-3" />
                      Demo Mode
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>Follow-up reminders are accelerated for demonstration purposes.</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5 max-w-md">
            <Label>Follow-Up Reminder Interval</Label>
            <Select value={interval} onValueChange={(v) => saveInterval(v as FollowUpIntervalKey)} disabled={savingInterval}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {FOLLOW_UP_INTERVAL_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              When an outreach email is sent, the reminder will surface after this interval — automatically moving the
              client from Active Conversation into Follow-Up Reminders.
            </p>
          </div>
        </CardContent>
      </Card>



      <Card className="border-border/60 shadow-[var(--shadow-soft)]">
        <CardHeader>
          <CardTitle>AI Workflow Webhooks</CardTitle>
          <CardDescription>
            Connect ServeOS to your n8n workflows. The two workflows run independently —
            failures in one will not affect the other.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label className="flex items-center gap-2 text-sm">
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-violet-50 text-violet-700">
                <Sparkles className="h-3.5 w-3.5" />
              </span>
              Outreach Generation Webhook
            </Label>
            <Input
              value={outreachUrl}
              onChange={(e) => setOutreachUrl(e.target.value)}
              placeholder="https://your-n8n.cloud/webhook/outreach"
            />
            <p className="text-xs text-muted-foreground">
              Powers Re-Engage, Check In, Send Follow-Up, and Regenerate actions.
            </p>
          </div>
          <div className="space-y-2">
            <Label className="flex items-center gap-2 text-sm">
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-indigo-50 text-indigo-700">
                <BellRing className="h-3.5 w-3.5" />
              </span>
              Follow-Up Generation Webhook
            </Label>
            <Input
              value={followupUrl}
              onChange={(e) => setFollowupUrl(e.target.value)}
              placeholder="https://your-n8n.cloud/webhook/follow-up"
            />
            <p className="text-xs text-muted-foreground">
              Powers the Generate Follow-Up button on the Follow Ups page.
            </p>
          </div>
          <div className="space-y-2">
            <Label className="flex items-center gap-2 text-sm">
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-50 text-emerald-700">
                <Mail className="h-3.5 w-3.5" />
              </span>
              Gmail Send Webhook
            </Label>
            <Input
              value={gmailUrl}
              onChange={(e) => setGmailUrl(e.target.value)}
              placeholder="https://your-n8n.cloud/webhook/gmail-send"
            />
            <p className="text-xs text-muted-foreground">
              Delivers outreach drafts through your n8n Gmail SMTP workflow when you click Send.
            </p>
          </div>
          <div className="flex justify-end">
            <Button onClick={saveWebhooks} variant="outline">Save webhooks</Button>
          </div>
        </CardContent>
      </Card>



      <Card className="border-border/60 shadow-[var(--shadow-soft)]">
        <CardHeader>
          <CardTitle>AI preferences</CardTitle>
          <CardDescription>Control how drafts and reminders are generated.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {[
            { label: "Suggest follow-up reminders automatically", desc: "ServeOS will detect stale conversations." },
            { label: "Match my writing tone", desc: "Drafts mirror your past messages." },
            { label: "Weekly digest email", desc: "Get a Monday recap with priorities." },
          ].map((o) => (
            <div key={o.label} className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium">{o.label}</p>
                <p className="text-xs text-muted-foreground">{o.desc}</p>
              </div>
              <Switch defaultChecked />
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save changes"}</Button>
      </div>
    </div>
  );
}
