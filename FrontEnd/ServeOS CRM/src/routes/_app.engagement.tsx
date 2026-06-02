import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Mail, Sparkles, Archive, Activity, Pencil, UserPlus, UserCog, Trash2, BellRing, Send, RefreshCw, Inbox, Loader2, FileText, CheckCircle2, Moon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { callFollowupWebhook, getFollowupWebhook, getGmailSendWebhook, logActivity, sanitizeDraftText, sendFollowupEmailViaWebhook } from "@/lib/outreach";
import { daysSince, fetchLastSentMap, getFollowUpStatus, buildActiveReminders, type ReminderClient as ClientRow, type ReminderFollowUp as FollowUpRow, type ActiveReminder as Reminder } from "@/lib/follow-up";
import { scheduleNextReminder } from "@/lib/follow-up-interval";

export const Route = createFileRoute("/_app/engagement")({
  head: () => ({ meta: [{ title: "Engagement Centre — ServeOS" }] }),
  component: EngagementPage,
});

type LogRow = {
  id: string;
  client_id: string | null;
  client_name: string | null;
  action_type: string;
  action_source: string | null;
  details: string | null;
  created_at: string;
};

type IconType = typeof Sparkles;

const ENGAGEMENT_ACTION_TYPES = [
  "outreach_generated",
  "followup_generated",
  "followup_draft_ready",
  "draft_sent",
  "followup_sent",
  "followup_completed",
  "reminder_snoozed",
] as const;

const ACTION_META: Record<string, { label: string; icon: IconType; tint: string }> = {
  outreach_generated:   { label: "Outreach Draft Generated", icon: Sparkles, tint: "bg-violet-50 text-violet-700 border-violet-200" },
  followup_generated:   { label: "Follow-Up Draft Generated", icon: Sparkles, tint: "bg-violet-50 text-violet-700 border-violet-200" },
  followup_draft_ready: { label: "Follow-Up Ready to Send", icon: FileText, tint: "bg-indigo-50 text-indigo-700 border-indigo-200" },
  draft_sent:           { label: "Outreach Email Sent", icon: Send, tint: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  followup_sent:        { label: "Follow-Up Email Sent", icon: Send, tint: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  followup_completed:   { label: "Reminder Completed", icon: Mail, tint: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  reminder_snoozed:     { label: "Reminder Snoozed", icon: BellRing, tint: "bg-amber-50 text-amber-700 border-amber-200" },
};

function metaFor(actionType: string): { label: string; icon: IconType; tint: string } {
  return ACTION_META[actionType] ?? { label: actionType, icon: Activity, tint: "bg-muted text-muted-foreground border-border" };
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const t = new Date(iso); t.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - t.getTime()) / 86400000);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function EngagementPage() {
  const { user } = useSession();
  const navigate = useNavigate();
  const [rows, setRows] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("activity_history")
      .select("id, client_id, client_name, action_type, action_source, details, created_at")
      .eq("user_id", user.id)
      .in("action_type", ENGAGEMENT_ACTION_TYPES as unknown as string[])
      .order("created_at", { ascending: false })
      .limit(100);
    if (!error) setRows((data ?? []) as LogRow[]);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    if (!user) return;
    load();
    const channel = supabase
      .channel("engagement-activity")
      .on("postgres_changes", { event: "*", schema: "public", table: "activity_history" }, load)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user, load]);

  const handleOpen = (r: LogRow) => {
    if (r.action_type === "draft_sent" || r.action_type === "followup_sent" ||
        r.action_type === "outreach_generated" || r.action_type === "followup_generated" ||
        r.action_type === "followup_draft_ready") {
      navigate({ to: "/outreach" });
      return;
    }
    if (r.client_id) navigate({ to: "/clients" });
  };

  return (
    <div className="mx-auto max-w-7xl space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">Engagement Centre</h1>
        <p className="mt-1 text-sm text-muted-foreground">Active follow-up reminders and recent relationship engagement activity.</p>
      </div>

      <FollowUpReminders />

      <div className="space-y-3 pt-2">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Recent Engagement Activity</h2>
          <p className="text-sm text-muted-foreground">Completed outreach and follow-up actions across your CRM.</p>
        </div>
        {loading && rows.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">Loading activity…</p>
        ) : rows.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-16 text-center">
              <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <Inbox className="h-7 w-7" />
              </div>
              <p className="text-base font-medium text-foreground">No engagement activity yet</p>
              <p className="mt-1 max-w-xs text-sm text-muted-foreground">
                Generated drafts, sent emails and completed reminders will appear here.
              </p>
            </CardContent>
          </Card>
        ) : (
          <ol className="relative space-y-2 border-l border-border/60 pl-4 sm:pl-6 ml-2">
            {rows.map((r) => {
              const { label, icon: Icon, tint } = metaFor(r.action_type);
              const isSent = r.action_type === "draft_sent" || r.action_type === "followup_sent" || r.action_type === "followup_completed";
              return (
                <li key={r.id} className="relative">
                  <span className="absolute -left-[26px] sm:-left-[34px] top-3 flex h-6 w-6 items-center justify-center rounded-full border border-border bg-background">
                    <Icon className="h-3 w-3 text-muted-foreground" />
                  </span>
                  <button
                    type="button"
                    onClick={() => handleOpen(r)}
                    className="w-full text-left rounded-lg border border-border/60 bg-card px-3 py-2.5 sm:px-4 sm:py-3 transition-all duration-200 hover:bg-muted/40 hover:border-border hover:shadow-sm cursor-pointer"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className={cn("text-[10.5px] font-medium gap-1", tint)}>
                        <Icon className="h-3 w-3" />
                        {label}
                      </Badge>
                      {r.client_name && (<span className="text-sm font-medium truncate">{r.client_name}</span>)}
                      {isSent && (
                        <Badge variant="outline" className="gap-1 text-[10.5px] bg-emerald-50 text-emerald-700 border-emerald-200">
                          <CheckCircle2 className="h-3 w-3" /> Done
                        </Badge>
                      )}
                      <span className="ml-auto text-xs text-muted-foreground tabular-nums shrink-0">{relativeTime(r.created_at)}</span>
                    </div>
                    {r.details && (
                      <p className="mt-1.5 text-xs text-muted-foreground truncate">{r.details}</p>
                    )}
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}

function statusTint(s: Reminder["status"]): string {
  if (s === "Today") return "bg-yellow-50 text-yellow-800 border-yellow-200";
  if (s === "Upcoming") return "bg-blue-50 text-blue-700 border-blue-200";
  return "bg-red-50 text-red-700 border-red-200";
}

function statusAccentBorder(s: Reminder["status"]): string {
  if (s === "Today") return "border-l-yellow-400";
  if (s === "Upcoming") return "border-l-blue-400";
  return "border-l-red-400";
}

function buildReminders(
  clients: ClientRow[],
  followUps: FollowUpRow[],
  lastSentMap?: Map<string, string>,
): Reminder[] {
  return buildActiveReminders(clients, followUps, lastSentMap).slice(0, 9);
}


function FollowUpReminders() {
  const { user } = useSession();
  const navigate = useNavigate();
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [followUps, setFollowUps] = useState<FollowUpRow[]>([]);
  const [lastSentMap, setLastSentMap] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [generatingId, setGeneratingId] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const [{ data: cData }, { data: fData }, sentMap] = await Promise.all([
      supabase
        .from("clients")
        .select("id, name, email, notes, tags, last_contacted, status")
        .eq("user_id", user.id),
      supabase
        .from("follow_ups")
        .select("id, client_id, done, status, snoozed_until, draft_id")
        .eq("user_id", user.id),
      fetchLastSentMap(user.id),
    ]);
    setClients((cData ?? []) as ClientRow[]);
    setFollowUps((fData ?? []) as FollowUpRow[]);
    setLastSentMap(sentMap);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    if (!user) return;
    load();
    const ch = supabase
      .channel("engagement-reminders")
      .on("postgres_changes", { event: "*", schema: "public", table: "clients" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "follow_ups" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "outreach_drafts" }, load)
      .subscribe();
    // Re-check every 60s so expired snoozes move back to active automatically.
    const interval = window.setInterval(load, 60_000);
    return () => { supabase.removeChannel(ch); window.clearInterval(interval); };
  }, [user, load]);

  const reminders = useMemo(() => buildReminders(clients, followUps, lastSentMap), [clients, followUps, lastSentMap]);

  const snoozed = useMemo(() => {
    const now = Date.now();
    const clientById = new Map(clients.map((c) => [c.id, c]));
    return followUps
      .filter((fu) => {
        if (fu.done || fu.status === "completed") return false;
        if (!fu.snoozed_until) return false;
        return new Date(fu.snoozed_until).getTime() > now;
      })
      .map((fu) => ({
        id: fu.id,
        client: fu.client_id ? clientById.get(fu.client_id) ?? null : null,
        snoozedUntil: fu.snoozed_until as string,
      }))
      .filter((s) => s.client)
      .sort((a, b) => new Date(a.snoozedUntil).getTime() - new Date(b.snoozedUntil).getTime());
  }, [clients, followUps]);

  const upsertFollowUp = async (
    r: Reminder,
    patch: {
      done?: boolean;
      snoozed_until?: string | null;
      reason?: string;
      status?: string;
      draft_id?: string | null;
      completed_at?: string | null;
      sent_at?: string | null;
    },
  ) => {
    if (!user) return { error: "Not signed in" as string };
    if (r.followUpId) {
      const { error } = await supabase
        .from("follow_ups")
        .update(patch)
        .eq("id", r.followUpId);
      return { error: error?.message ?? null };
    }
    const { error } = await supabase.from("follow_ups").insert({
      user_id: user.id,
      client_id: r.client.id,
      reason: patch.reason ?? "Engagement reminder",
      done: patch.done ?? false,
      status: patch.status ?? "pending",
      snoozed_until: patch.snoozed_until ?? null,
      draft_id: patch.draft_id ?? null,
      completed_at: patch.completed_at ?? null,
      sent_at: patch.sent_at ?? null,
    });
    return { error: error?.message ?? null };
  };


  const handleGenerate = async (r: Reminder) => {
    if (!user) return;
    const webhook = getFollowupWebhook();
    if (!webhook) {
      toast.error("Configure the Follow-Up Generation webhook in Settings first");
      return;
    }
    setGeneratingId(r.client.id);
    try {
      const status = getFollowUpStatus(r.client.last_contacted, r.client.status, lastSentMap.get(r.client.id) ?? null);
      const result = await callFollowupWebhook(webhook, {
        client_id: r.client.id,
        user_id: user.id,
        client_name: r.client.name,
        client_email: r.client.email,
        notes: r.client.notes,
        tags: r.client.tags,
        last_contacted: r.client.last_contacted,
        relationship_status: status,
        intent: "follow_up",
      });
      if (!result.success) {
        toast.error("Failed to generate follow-up", { description: result.error });
        return;
      }
      // Look up the freshly-inserted draft for this client so we can link it.
      const { data: draft } = await supabase
        .from("outreach_drafts")
        .select("id")
        .eq("user_id", user.id)
        .eq("client_id", r.client.id)
        .eq("archived", false)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      // Defensive: ensure the freshly-generated draft is in draft_ready state.
      // n8n occasionally inserts with sent=true/status=sent — reset so the UI
      // shows enabled Send/Edit/Regenerate and no "Sent" badge until SMTP success.
      if (draft?.id) {
        await supabase
          .from("outreach_drafts")
          .update({ sent: false, sent_at: null, status: "draft_ready", action_type: "follow-up" })
          .eq("id", draft.id);
      }

      await upsertFollowUp(r, {
        status: "draft_ready",
        draft_id: draft?.id ?? null,
        done: false,
        snoozed_until: null,
        reason: "Follow-up draft ready",
      });

      toast.success("Follow-up draft ready", { description: "Review and send when you're ready." });
      await logActivity({
        user_id: user.id,
        client_id: r.client.id,
        client_name: r.client.name,
        action_type: "followup_generated",
        action_source: "followups_page",
        details: `Follow-up draft created for ${r.client.name}`,
      });
      await logActivity({
        user_id: user.id,
        client_id: r.client.id,
        client_name: r.client.name,
        action_type: "followup_draft_ready",
        action_source: "followups_page",
        details: `Follow-up draft is ready to send for ${r.client.name}`,
      });
      load();
    } finally {
      setGeneratingId(null);
    }
  };


  const handleOpenDraft = async (r: Reminder) => {
    let draftId = r.draftId;
    if (!draftId && user) {
      const { data } = await supabase
        .from("outreach_drafts")
        .select("id")
        .eq("user_id", user.id)
        .eq("client_id", r.client.id)
        .eq("archived", false)
        .eq("sent", false)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      draftId = data?.id ?? null;
    }
    if (!draftId) {
      toast.error("Follow-up draft not found.");
      return;
    }
    navigate({ to: "/outreach", search: { draft: draftId } });
  };

  const handleSendEmail = async (r: Reminder) => {
    if (!user) return;
    if (!r.client.email) {
      toast.error("This client has no email on file");
      return;
    }
    const sendWebhook = getGmailSendWebhook();
    if (!sendWebhook) {
      toast.error("Configure the Email Send webhook in Settings first");
      return;
    }
    setActingId(r.client.id);
    try {
      // Resolve the draft to send: linked draft, or the latest non-archived/non-sent draft.
      let draftQ = supabase
        .from("outreach_drafts")
        .select("id, subject, body")
        .eq("user_id", user.id)
        .eq("client_id", r.client.id);
      if (r.draftId) {
        draftQ = draftQ.eq("id", r.draftId);
      } else {
        draftQ = draftQ.eq("archived", false).eq("sent", false).order("created_at", { ascending: false }).limit(1);
      }
      const { data: draft } = await draftQ.maybeSingle();
      if (!draft) {
        toast.error("No follow-up draft found. Generate one first.");
        return;
      }

      // STRICT: only proceed if n8n returns { success: true, reminder_completed: true }
      const res = await sendFollowupEmailViaWebhook({
        webhookUrl: sendWebhook,
        reminder_id: r.followUpId,
        draft_id: draft.id,
        client_id: r.client.id,
        user_id: user.id,
        recipient_email: r.client.email,
        subject: sanitizeDraftText(draft.subject),
        body: sanitizeDraftText(draft.body),
        client_name: r.client.name,
      });
      if (!res.success || !res.reminder_completed) {
        toast.error("Failed to send follow-up email.", { description: res.error });
        return;
      }

      // n8n is the source of truth — it updates reminder, draft, and history.
      // We mirror those writes as a safety net in case n8n's DB side-effects
      // are delayed, then refresh from Supabase. Idempotent updates only.
      const nowIso = new Date().toISOString();
      await supabase
        .from("outreach_drafts")
        .update({ sent: true, sent_at: nowIso, status: "sent" })
        .eq("id", draft.id);
      await supabase
        .from("clients")
        .update({ status: "Active", last_contacted: nowIso.slice(0, 10) })
        .eq("id", r.client.id);
      await upsertFollowUp(r, {
        done: true,
        status: "completed",
        completed_at: nowIso,
        sent_at: nowIso,
        reason: "Follow-up email sent",
      });
      // Schedule the NEXT reminder after this follow-up using the user's
      // configured interval. Inserts a fresh pending row (the one above is
      // now completed).
      await scheduleNextReminder({ userId: user.id, clientId: r.client.id, sentAtIso: nowIso });
      await logActivity({
        user_id: user.id,
        client_id: r.client.id,
        client_name: r.client.name,
        action_type: "followup_sent",
        action_source: "followups_page",
        details: `Follow-up email successfully sent to ${r.client.name}`,
      });
      await logActivity({
        user_id: user.id,
        client_id: r.client.id,
        client_name: r.client.name,
        action_type: "followup_completed",
        action_source: "followups_page",
        details: `Reminder completed for ${r.client.name}`,
      });
      toast.success("Follow-up email sent successfully.");
      load();
    } finally {
      setActingId(null);
    }
  };

  const handleSnooze = async (r: Reminder) => {
    if (!user) return;
    setActingId(r.client.id);
    try {
      const snoozeUntil = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
      const { error } = await upsertFollowUp(r, {
        snoozed_until: snoozeUntil,
        status: "snoozed",
        reason: "Snoozed reminder",
      });
      if (error) {
        toast.error("Snooze failed", { description: error });
        return;
      }
      await logActivity({
        user_id: user.id,
        client_id: r.client.id,
        client_name: r.client.name,
        action_type: "reminder_snoozed",
        action_source: "followups_page",
        details: `Reminder snoozed for 3 days for ${r.client.name}`,
      });
      toast.success("Reminder snoozed for 3 days");
      load();
    } finally {
      setActingId(null);
    }
  };


  return (
    <section className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Follow-Up Reminders</h2>
          <p className="text-sm text-muted-foreground">Stay on top of important relationships until the email is actually sent.</p>
        </div>
        {snoozed.length > 0 && (
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="group inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-gradient-to-b from-muted/60 to-muted/30 px-3.5 py-1.5 text-xs font-medium text-muted-foreground shadow-sm backdrop-blur-sm transition-all hover:bg-muted hover:text-foreground hover:shadow-md hover:-translate-y-px"
              >
                <Moon className="h-3.5 w-3.5 transition-transform duration-300 group-hover:-rotate-12" />
                Snoozed ({snoozed.length})
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 p-0 overflow-hidden rounded-2xl border-border/70 shadow-xl">
              <div className="border-b border-border/60 bg-gradient-to-b from-muted/40 to-muted/20 px-4 py-3">
                <p className="text-sm font-semibold text-foreground">Snoozed Follow-Ups</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">Hidden from active reminders until they resume.</p>
              </div>
              <ul className="max-h-72 overflow-y-auto divide-y divide-border/50">
                {snoozed.map((s) => {
                  const resumeAt = new Date(s.snoozedUntil);
                  const msLeft = resumeAt.getTime() - Date.now();
                  const minutesLeftRaw = msLeft / (1000 * 60);
                  const hoursLeftRaw = msLeft / (1000 * 60 * 60);
                  const daysLeft = Math.max(0, Math.ceil(msLeft / (1000 * 60 * 60 * 24)));
                  const hoursLeft = Math.max(1, Math.ceil(hoursLeftRaw));
                  const minutesLeft = Math.max(1, Math.ceil(minutesLeftRaw));
                  const remaining = hoursLeftRaw >= 24
                    ? `${daysLeft} day${daysLeft === 1 ? "" : "s"} left`
                    : minutesLeftRaw < 60
                      ? `${minutesLeft}m left`
                      : `${hoursLeft}h left`;
                  const urgency = hoursLeftRaw < 24
                    ? "bg-red-50 text-red-700 border-red-200"
                    : hoursLeftRaw < 72
                      ? "bg-amber-50 text-amber-700 border-amber-200"
                      : "bg-muted text-muted-foreground border-border/60";
                  const resumeLabel = resumeAt.toLocaleString(undefined, {
                    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
                  });
                  return (
                    <li key={s.id} className="px-4 py-3 transition-colors hover:bg-muted/40 cursor-default">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm font-medium text-foreground truncate">{s.client!.name}</span>
                        <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-[10.5px] font-semibold tabular-nums", urgency)}>{remaining}</span>
                      </div>
                      <p className="mt-1 text-[11px] text-muted-foreground">Resumes {resumeLabel}</p>
                    </li>
                  );
                })}
              </ul>
            </PopoverContent>
          </Popover>
        )}

      </div>
      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-32 rounded-lg bg-muted animate-pulse" />
          ))}
        </div>
      ) : reminders.length === 0 ? (
        <Card className="border-dashed border-border/60 shadow-none">
          <CardContent className="py-8 text-center">
            <p className="text-sm font-medium text-foreground">No follow-ups pending.</p>
            <p className="mt-1 text-xs text-muted-foreground">Your relationships are up to date.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {reminders.map((r) => {
            const isGenerating = generatingId === r.client.id;
            const isActing = actingId === r.client.id;
            const busy = isGenerating || isActing;
            const isDraftReady = r.workflowStatus === "draft_ready";
            return (
              <Card key={r.client.id} className={cn("border-border/60 border-l-4 shadow-none transition-all duration-200 hover:shadow-md hover:-translate-y-0.5", statusAccentBorder(r.status))}>
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">Follow up with {r.client.name}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground truncate">{r.context}</p>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <Badge variant="outline" className={cn("text-[10.5px]", statusTint(r.status))}>
                        {r.status}
                      </Badge>
                      {isDraftReady && (
                        <Badge variant="outline" className="text-[10.5px] bg-violet-50 text-violet-700 border-violet-200">
                          Draft Ready
                        </Badge>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {isDraftReady ? (
                      <>
                        <Button
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => handleSendEmail(r)}
                          disabled={busy}
                        >
                          {isActing ? (
                            <><Loader2 className="h-3 w-3 animate-spin" /> Sending…</>
                          ) : (
                            <><Send className="h-3 w-3" /> Send Email</>
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={() => handleOpenDraft(r)}
                          disabled={busy}
                        >
                          <FileText className="h-3 w-3" />
                          Open Draft
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs border border-border/60 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                          onClick={() => handleSnooze(r)}
                          disabled={busy}
                        >
                          Snooze
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => handleGenerate(r)}
                          disabled={busy}
                        >
                          {isGenerating ? (
                            <><Loader2 className="h-3 w-3 animate-spin" /> Generating…</>
                          ) : (
                            <><Sparkles className="h-3 w-3" /> Generate Follow-Up</>
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={() => handleSnooze(r)}
                          disabled={busy}
                        >
                          Snooze
                        </Button>
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}
