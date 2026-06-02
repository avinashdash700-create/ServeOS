import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Users, BellRing, Sparkles, ArrowUpRight, Clock, Wand2, AlertCircle, ArrowRight, Settings2, Loader2, Moon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { useSession, userDisplayName } from "@/lib/auth";
import { ATTENTION_RANK, buildActiveReminders, daysSince, fetchLastSentMap, getFollowUpStatus, statusBadgeClasses, type FollowUpStatus } from "@/lib/follow-up";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  callOutreachWebhook,
  getOutreachWebhook,
  setOutreachWebhook,
  logActivity,
  upsertOutreachDraft,
} from "@/lib/outreach";

export const Route = createFileRoute("/_app/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard — ServeOS" }] }),
  component: Dashboard,
});

type Client = {
  id: string;
  name: string;
  email: string | null;
  tags: string[];
  notes: string | null;
  last_contacted: string | null;
  status: string | null;
};

type FollowUp = {
  id: string;
  client_id: string | null;
  reason: string;
  due_date: string | null;
  done: boolean;
  status: string;
  snoozed_until: string | null;
  draft_id: string | null;
  clients: { name: string } | null;
};



const URGENCY_BAR: Record<FollowUpStatus, string> = {
  Cold: "bg-red-500",
  "Follow Up Needed": "bg-orange-500",
  Warm: "bg-amber-400",
  Active: "bg-emerald-500",
  "Active Conversation": "bg-emerald-600",
  New: "bg-slate-300",
};

const ACTION_CTA: Partial<Record<FollowUpStatus, { label: string; classes: string }>> = {
  New: {
    label: "Generate Outreach",
    classes: "bg-primary/5 text-primary border-primary/20 hover:bg-primary/10",
  },
  Warm: {
    label: "Check In",
    classes: "bg-amber-50 text-amber-800 border-amber-200 hover:bg-amber-100 hover:text-amber-900",
  },
  "Follow Up Needed": {
    label: "Send Follow-Up",
    classes: "bg-orange-50 text-orange-700 border-orange-200 hover:bg-orange-100 hover:text-orange-800",
  },
  Cold: {
    label: "Re-Engage",
    classes: "bg-red-50 text-red-700 border-red-200 hover:bg-red-100 hover:text-red-800",
  },
};
const DEFAULT_CTA = { label: "Generate Outreach", classes: "" };

function Dashboard() {
  const { user } = useSession();
  const [allClients, setAllClients] = useState<Client[]>([]);
  const [followUps, setFollowUps] = useState<FollowUp[]>([]);
  const [draftCount, setDraftCount] = useState(0);
  const [generatingFor, setGeneratingFor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [webhookUrl, setWebhookUrl] = useState("");

  useEffect(() => {
    setWebhookUrl(getOutreachWebhook());
  }, []);


  // Clients with unsent outreach drafts — drives the "Clients Requiring Attention" list.
  const [unsentDraftClientIds, setUnsentDraftClientIds] = useState<Set<string>>(new Set());
  // Drafts that have already been sent — used to exclude their reminders from "Follow Up Alerts".
  const [sentDraftIds, setSentDraftIds] = useState<Set<string>>(new Set());
  // client_id → most recent successful send timestamp. Drives "Active Conversation".
  const [lastSentMap, setLastSentMap] = useState<Map<string, string>>(new Map());

  const refresh = async () => {
    if (!user) return;
    const [{ data: c }, { data: f }, { count }, { data: unsent }, { data: sent }, lastSent] = await Promise.all([
      supabase.from("clients").select("id, name, email, tags, notes, last_contacted, status").order("created_at", { ascending: false }),
      // Fetch ALL active follow_ups (including snoozed) so we can compute the
      // snoozed bucket. We exclude only completed/done.
      supabase
        .from("follow_ups")
        .select("id, client_id, reason, due_date, done, status, snoozed_until, draft_id, clients(name)")
        .eq("done", false)
        .neq("status", "completed")
        .order("due_date", { ascending: true }),
      supabase.from("outreach_drafts").select("id", { count: "exact", head: true }).eq("archived", false).eq("sent", false),
      supabase.from("outreach_drafts").select("client_id").eq("archived", false).eq("sent", false),
      supabase.from("outreach_drafts").select("id").eq("sent", true),
      fetchLastSentMap(user.id),
    ]);
    setAllClients((c ?? []) as Client[]);
    setFollowUps((f ?? []) as unknown as FollowUp[]);
    setDraftCount(count ?? 0);
    setUnsentDraftClientIds(new Set(((unsent ?? []) as { client_id: string | null }[]).map((d) => d.client_id).filter((x): x is string => !!x)));
    setSentDraftIds(new Set(((sent ?? []) as { id: string }[]).map((d) => d.id)));
    setLastSentMap(lastSent);
    setLoading(false);
  };

  useEffect(() => { refresh(); }, [user]);

  useEffect(() => {
    if (!user) return;
    const ch = supabase
      .channel("dashboard-feed")
      .on("postgres_changes", { event: "*", schema: "public", table: "outreach_drafts" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "follow_ups" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "clients" }, refresh)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [user]);

  // Auto-rehydrate snoozed reminders the moment their snooze expires.
  useEffect(() => {
    const next = followUps
      .map((f) => (f.snoozed_until ? new Date(f.snoozed_until).getTime() : 0))
      .filter((t) => t > Date.now());
    if (next.length === 0) return;
    const soonest = Math.min(...next);
    const delay = Math.max(1000, Math.min(soonest - Date.now() + 500, 5 * 60 * 1000));
    const t = window.setTimeout(refresh, delay);
    return () => window.clearTimeout(t);
  }, [followUps]);

  const recentClients = useMemo(() => allClients.slice(0, 5), [allClients]);

  // ---------------------------------------------------------------------
  // Single source of truth: per-client dashboard state.
  //   Priority: snoozed → reminder → outreach → none.
  // Every section (and its count) is derived from this resolver so a client
  // can only appear in exactly one place.
  // ---------------------------------------------------------------------
  const { snoozedList, reminderClientIds, outreachList } = useMemo(() => {
    const now = Date.now();
    const fuByClient = new Map<string, FollowUp>();
    for (const fu of followUps) {
      if (fu.client_id) fuByClient.set(fu.client_id, fu);
    }
    const snoozedIds = new Set<string>();
    const reminderIds = new Set<string>();
    const snoozedItems: { client: Client; fu: FollowUp; resumeAt: string }[] = [];

    // Pass 1 — snoozed wins over everything.
    for (const c of allClients) {
      const fu = fuByClient.get(c.id);
      if (!fu) continue;
      if (fu.status === "snoozed" || (fu.snoozed_until && new Date(fu.snoozed_until).getTime() > now)) {
        snoozedIds.add(c.id);
        snoozedItems.push({ client: c, fu, resumeAt: fu.snoozed_until ?? "" });
      }
    }

    // Pass 2 — active follow-up reminders (excluding snoozed).
    // LIFECYCLE GATE: a client must have at least one successfully sent
    // outreach (or a prepared follow-up draft) before it can be a reminder.
    for (const c of allClients) {
      if (snoozedIds.has(c.id)) continue;
      const fu = fuByClient.get(c.id);
      if (!fu) continue;
      if (fu.done || fu.status === "completed") continue;
      if (fu.snoozed_until && new Date(fu.snoozed_until).getTime() > now) continue;
      // Linked draft already sent → reminder resolved.
      if (fu.draft_id && sentDraftIds.has(fu.draft_id)) continue;
      const hasSentOutreach = !!lastSentMap.get(c.id);
      const isDraftReady = fu.status === "draft_ready";
      if (!hasSentOutreach && !isDraftReady) continue;
      reminderIds.add(c.id);
    }

    // Pass 3 — outreach attention (excluding snoozed + reminder).
    // LIFECYCLE GATE: a client with a prior successful outreach send is
    // either in "Active Conversation" or a follow-up cycle — never back in
    // "Clients Requiring Attention". Only the unsent-draft fast path can
    // override that, since the draft itself is the pending action.
    const outreach = allClients
      .map((c) => ({
        c,
        status: getFollowUpStatus(c.last_contacted, c.status, lastSentMap.get(c.id) ?? null),
        days: daysSince(c.last_contacted),
        hasUnsentDraft: unsentDraftClientIds.has(c.id),
        hasSentOutreach: !!lastSentMap.get(c.id),
      }))
      .filter((x) => {
        if (snoozedIds.has(x.c.id)) return false;
        if (reminderIds.has(x.c.id)) return false;
        if (x.hasUnsentDraft) return true;
        if (x.hasSentOutreach) return false;
        return x.status === "Cold" || x.status === "Follow Up Needed" || x.status === "Warm" || x.status === "New";
      })
      .sort((a, b) => {
        if (a.hasUnsentDraft !== b.hasUnsentDraft) return a.hasUnsentDraft ? -1 : 1;
        return ATTENTION_RANK[a.status] - ATTENTION_RANK[b.status];
      });

    snoozedItems.sort((a, b) => {
      const ta = a.resumeAt ? new Date(a.resumeAt).getTime() : 0;
      const tb = b.resumeAt ? new Date(b.resumeAt).getTime() : 0;
      return ta - tb;
    });

    return { snoozedList: snoozedItems, reminderClientIds: reminderIds, outreachList: outreach };
  }, [allClients, followUps, unsentDraftClientIds, sentDraftIds, lastSentMap]);

  const attention = outreachList;

  // Active reminders use the shared helper, then are filtered to the
  // resolver's reminder bucket so the two stay in lockstep.
  const activeReminders = useMemo(() => {
    const reminders = buildActiveReminders(
      allClients,
      (followUps ?? []).map((f) => ({
        id: f.id,
        client_id: f.client_id,
        done: f.done,
        status: f.status,
        snoozed_until: f.snoozed_until,
        draft_id: f.draft_id,
      })),
      lastSentMap,
    );
    return reminders
      .filter((r) => reminderClientIds.has(r.client.id))
      .filter((r) => !(r.draftId && sentDraftIds.has(r.draftId)))
      .slice(0, 5);
  }, [allClients, followUps, sentDraftIds, lastSentMap, reminderClientIds]);



  const generateDraft = async (c: Client, status: FollowUpStatus, intent: string) => {
    if (!user) return;
    if (!webhookUrl) {
      toast.error("Configure your n8n outreach webhook in Settings first");
      return;
    }

    setGeneratingFor(c.id);
    try {
      const { success, ai, error: webhookError } = await callOutreachWebhook(webhookUrl, {
        client_id: c.id,
        user_id: user.id,
        client_name: c.name,
        client_email: c.email,
        tags: c.tags,
        notes: c.notes,
        last_contacted: c.last_contacted,
        relationship_status: status,
        intent,
      });
      if (!success) {
        toast.error("Draft generation failed.", { description: webhookError });
        return;
      }

      // If n8n returned the draft inline, upsert immediately (fast path).
      // Otherwise n8n is generating asynchronously and will insert directly
      // into Supabase — realtime + refresh() will surface it.
      if (ai) {
        const { error, created } = await upsertOutreachDraft({
          user_id: user.id,
          client_id: c.id,
          subject: ai.subject,
          body: ai.body,
          tone: ai.tone,
          strategy: ai.strategy ?? intent,
          urgency: ai.urgency ?? (status === "Cold" ? "high" : "normal"),
          reasoning: ai.reasoning ?? null,
          confidence: ai.confidence ?? null,
          cta: ai.cta ?? null,
        });
        if (error) {
          toast.error(error);
          return;
        }
        toast.success(created ? "Draft generated successfully." : "AI draft updated");
      } else {
        toast.success("Draft generated successfully.");
      }

      await logActivity({
        user_id: user.id,
        client_id: c.id,
        client_name: c.name,
        action_type: "outreach_generated",
        action_source: "dashboard",
        details: `Generated ${intent.toLowerCase()} outreach for ${c.name}`,
      });
      refresh();
    } finally {
      setGeneratingFor(null);
    }
  };


  const stats = [
    { label: "Total Clients", value: allClients.length, icon: Users },
    { label: "Pending Follow Ups", value: reminderClientIds.size, icon: BellRing, accent: reminderClientIds.size > 0 },
    { label: "Outreach Drafts", value: draftCount, icon: Sparkles },
  ];

  return (
    <div className="mx-auto max-w-7xl space-y-6 animate-fade-in">
      {/* Header */}
      <section className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-sm font-medium text-primary">Welcome back, {userDisplayName(user)}</p>
          <h1 className="mt-1.5 text-4xl font-semibold tracking-tight text-foreground">
            Here's your day at a glance
          </h1>
          <p className="mt-2 text-[15px] text-muted-foreground">
            Your client activity and reminders, all in one place.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="default" className="gap-2 shadow-sm" asChild>
            <Link to="/clients"><Sparkles className="h-4 w-4" /> Add a client</Link>
          </Button>
        </div>
      </section>



      {/* Compact KPI strip */}
      <section className="grid gap-3 sm:grid-cols-3">
        {stats.map((s) => (
          <Card
            key={s.label}
            className="group border-border/70 shadow-[var(--shadow-soft)] transition-all hover:shadow-[var(--shadow-elevated)] hover:-translate-y-0.5"
          >
            <CardContent className="flex items-center justify-between p-5">
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-muted-foreground">{s.label}</p>
                <p className="mt-1 text-3xl font-semibold tracking-tight tabular-nums text-foreground">
                  {s.value}
                </p>
              </div>
              <div className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-colors",
                s.accent ? "bg-orange-50 text-orange-600" : "bg-accent text-accent-foreground"
              )}>
                <s.icon className="h-4.5 w-4.5" />
              </div>
            </CardContent>
          </Card>
        ))}
      </section>

      {/* HERO: Clients Requiring Attention */}
      <Card className="overflow-hidden border-border/70 shadow-[var(--shadow-soft)]">
        <CardHeader className="flex flex-row items-start justify-between gap-4 border-b border-border/60 bg-gradient-to-b from-accent/40 to-transparent pb-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <CardTitle className="text-lg">Clients Requiring Attention</CardTitle>
              {attention.length > 0 && (
                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground">
                  {attention.length}
                </span>
              )}
            </div>
            <CardDescription className="mt-1">
              Clients with unsent outreach drafts or no recent outreach activity
            </CardDescription>
          </div>
          {attention.length > 0 && (
            <Button asChild variant="ghost" size="sm" className="shrink-0 gap-1 text-muted-foreground hover:text-foreground">
              <Link to="/engagement">View all <ArrowRight className="h-3.5 w-3.5" /></Link>
            </Button>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="space-y-px">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex items-center gap-4 px-6 py-4">
                  <div className="h-10 w-1 rounded-full bg-muted animate-pulse" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 w-1/3 rounded bg-muted animate-pulse" />
                    <div className="h-3 w-1/4 rounded bg-muted animate-pulse" />
                  </div>
                  <div className="h-8 w-32 rounded bg-muted animate-pulse" />
                </div>
              ))}
            </div>
          ) : attention.length === 0 ? (
            <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
                <BellRing className="h-5 w-5" />
              </div>
              <p className="mt-4 text-sm font-medium text-foreground">All client relationships are up to date.</p>
              <p className="mt-1 text-xs text-muted-foreground">Nothing needs your attention right now.</p>
            </div>
          ) : (
            <ul className="divide-y divide-border/60">
              {attention.map(({ c, status, days, hasUnsentDraft }) => (
                <li
                  key={c.id}
                  className="group flex items-center gap-4 px-6 py-4 transition-colors hover:bg-muted/40"
                >
                  <span
                    className={cn("h-10 w-1 rounded-full shrink-0", URGENCY_BAR[status])}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-semibold text-foreground">{c.name}</p>
                      <Badge variant="outline" className={cn("font-medium text-[10.5px] px-1.5 py-0", statusBadgeClasses(status))}>
                        {status}
                      </Badge>
                      {hasUnsentDraft && (
                        <Badge variant="outline" className="font-medium text-[10.5px] px-1.5 py-0 bg-primary/10 text-primary border-primary/20">
                          Draft ready
                        </Badge>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {hasUnsentDraft ? (
                        "AI outreach drafted — review and send"
                      ) : c.last_contacted ? (
                        <>Last contacted {c.last_contacted}{days !== null && <> · <span className="font-medium text-foreground/70">{days} {days === 1 ? "day" : "days"} ago</span></>}</>
                      ) : (
                        "Never contacted"
                      )}
                    </p>
                  </div>
                  {hasUnsentDraft ? (
                    <Button asChild size="sm" variant="outline" className="h-8 shrink-0 gap-1.5 px-3 text-xs font-medium">
                      <Link to="/outreach"><Wand2 className="h-3.5 w-3.5" /> Open Draft</Link>
                    </Button>
                  ) : (() => {
                    const cta = ACTION_CTA[status] ?? DEFAULT_CTA;
                    const busy = generatingFor === c.id;
                    return (
                      <Button
                        size="sm"
                        variant="outline"
                        className={cn(
                          "h-8 shrink-0 gap-1.5 px-3 text-xs font-medium opacity-90 transition-opacity hover:opacity-100",
                          cta.classes,
                        )}
                        disabled={busy}
                        onClick={() => generateDraft(c, status, cta.label)}
                      >
                        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
                        {busy ? "Generating AI outreach..." : cta.label}
                      </Button>
                    );
                  })()}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Secondary: Recent + Alerts */}
      <section className="grid gap-5 lg:grid-cols-3">
        <Card className="border-border/70 shadow-[var(--shadow-soft)] lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <div>
              <CardTitle className="text-base">Recent Clients</CardTitle>
              <CardDescription className="mt-0.5">Your latest contacts</CardDescription>
            </div>
            <Button asChild variant="ghost" size="sm" className="gap-1 text-muted-foreground hover:text-foreground">
              <Link to="/clients">View all <ArrowUpRight className="h-3.5 w-3.5" /></Link>
            </Button>
          </CardHeader>
          <CardContent className="px-2 pb-2">
            <Table>
              <TableHeader>
                <TableRow className="border-border/60 hover:bg-transparent">
                  <TableHead className="h-9 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Name</TableHead>
                  <TableHead className="h-9 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Tags</TableHead>
                  <TableHead className="h-9 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Status</TableHead>
                  <TableHead className="h-9 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Last contacted</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentClients.map((c) => {
                  const status = getFollowUpStatus(c.last_contacted, c.status, lastSentMap.get(c.id) ?? null);
                  return (
                    <TableRow key={c.id} className="border-border/60 transition-colors hover:bg-muted/40">
                      <TableCell className="py-3">
                        <div className="text-sm font-medium text-foreground">{c.name}</div>
                        <div className="text-xs text-muted-foreground">{c.email}</div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {c.tags.map((t) => (
                            <Badge key={t} variant="secondary" className="font-normal bg-muted text-muted-foreground hover:bg-muted">{t}</Badge>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={cn("font-medium", statusBadgeClasses(status))}>
                          {status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{c.last_contacted ?? "—"}</TableCell>
                    </TableRow>
                  );
                })}
                {!loading && recentClients.length === 0 && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={4} className="py-12 text-center">
                      <div className="flex flex-col items-center gap-2">
                        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
                          <Users className="h-4 w-4 text-muted-foreground" />
                        </div>
                        <p className="text-sm text-muted-foreground">
                          No clients yet. <Link to="/clients" className="font-medium text-primary hover:underline">Add your first client</Link>
                        </p>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="border-border/70 shadow-[var(--shadow-soft)]">
          <CardHeader className="pb-3 flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-base">Follow Up Alerts</CardTitle>
              <CardDescription className="mt-0.5">Active reminders from Engagement Centre</CardDescription>
            </div>
            {activeReminders.length > 0 && (
              <Button asChild variant="ghost" size="sm" className="gap-1 text-muted-foreground hover:text-foreground">
                <Link to="/engagement">View all <ArrowUpRight className="h-3.5 w-3.5" /></Link>
              </Button>
            )}
          </CardHeader>
          <CardContent className="space-y-2">
            {activeReminders.map((r) => {
              const pill =
                r.status === "Overdue"
                  ? "bg-red-50 text-red-700 border-red-200"
                  : r.status === "Today"
                  ? "bg-amber-50 text-amber-700 border-amber-200"
                  : "bg-blue-50 text-blue-700 border-blue-200";
              return (
                <div key={r.client.id} className="flex items-start gap-3 rounded-lg border border-border/60 p-3 transition-colors hover:bg-muted/40">
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <Clock className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-medium text-foreground">{r.client.name}</p>
                      <Badge variant="outline" className={cn("shrink-0 text-[10.5px] font-medium", pill)}>{r.status}</Badge>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">{r.context}</p>
                    <div className="mt-2 flex justify-end">
                      <Button asChild size="sm" variant="outline" className="h-7 gap-1.5 px-2.5 text-[11px]">
                        <Link to="/engagement">
                          <Wand2 className="h-3 w-3" />
                          {r.workflowStatus === "draft_ready" ? "Open Follow-Up" : "Generate Follow-Up"}
                        </Link>
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
            {activeReminders.length === 0 && (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <AlertCircle className="h-5 w-5 text-muted-foreground/60" />
                <p className="mt-2 text-xs text-muted-foreground">No active reminders.</p>
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      {/* Snoozed Follow-Ups — clients deferred by the user. They live ONLY here. */}
      {snoozedList.length > 0 && (
        <Card className="border-border/70 shadow-[var(--shadow-soft)]">
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
                <Moon className="h-4 w-4" />
              </div>
              <div>
                <CardTitle className="text-base">Snoozed Follow-Ups</CardTitle>
                <CardDescription className="mt-0.5">
                  {snoozedList.length} {snoozedList.length === 1 ? "client" : "clients"} deferred — they'll return automatically
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="grid gap-2 sm:grid-cols-2">
            {snoozedList.map(({ client, fu, resumeAt }) => {
              const resumeDate = resumeAt ? new Date(resumeAt) : null;
              const resumeLabel = resumeDate
                ? resumeDate.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
                  " · " +
                  resumeDate.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
                : "—";
              return (
                <div
                  key={client.id}
                  className="flex items-start gap-3 rounded-lg border border-border/60 bg-muted/20 p-3 transition-colors hover:bg-muted/40"
                >
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground">
                    <Moon className="h-3.5 w-3.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{client.name}</p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">{fu.reason}</p>
                    <p className="mt-1 text-[11px] font-medium text-muted-foreground/80">
                      Resumes {resumeLabel}
                    </p>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
