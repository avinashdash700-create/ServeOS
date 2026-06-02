import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Sparkles, Send, Pencil, RefreshCw, Archive, Loader2, Lightbulb, ChevronDown, CheckCircle2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
  DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/lib/auth";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { callOutreachWebhook, getGmailSendWebhook, getOutreachWebhook, logActivity, normalizeConfidence, sanitizeDraftText, sendEmailViaWebhook, upsertOutreachDraft } from "@/lib/outreach";
import { scheduleNextReminder } from "@/lib/follow-up-interval";

export const Route = createFileRoute("/_app/outreach")({
  head: () => ({ meta: [{ title: "Outreach Drafts — ServeOS" }] }),
  validateSearch: (search: Record<string, unknown>): { draft?: string } => ({
    draft: typeof search.draft === "string" ? search.draft : undefined,
  }),
  component: OutreachPage,
});

type Draft = {
  id: string;
  subject: string;
  tone: string | null;
  body: string | null;
  strategy: string | null;
  action_label: string | null;
  urgency: string | null;
  reasoning: string[] | null;
  confidence: number | null;
  cta: string | null;
  created_at: string;
  client_id: string | null;
  status: string | null;
  action_type: string | null;
  sent: boolean;
  sent_at: string | null;
  clients: { id: string; name: string; email: string | null; notes: string | null; tags: string[]; last_contacted: string | null } | null;
};

const TONES = ["Friendly", "Professional", "Casual", "Concise", "Persuasive"] as const;

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const URGENCY_STYLES: Record<string, string> = {
  high: "bg-red-50 text-red-700 border-red-200",
  normal: "bg-slate-50 text-slate-700 border-slate-200",
  low: "bg-emerald-50 text-emerald-700 border-emerald-200",
};

/** Normalize an action_label like "send-follow-up draft generated" into "Send Follow-Up". */
function formatActionLabel(raw?: string | null) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s) return null;
  // Strip trailing "draft generated" / "draft" / "generated" suffixes
  s = s.replace(/\s*(draft\s+generated|draft|generated)\s*$/i, "").trim();
  if (!s) return null;
  // Reject internal workflow event types like "outreach_generated"
  if (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(s)) return null;
  return s
    .split(/\s+/)
    .map((word) =>
      word
        .split("-")
        .map((p) => (p ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : p))
        .join("-")
    )
    .join(" ");
}

/** Infer a user-facing action label from strategy text when action_label is missing (legacy drafts). */
function inferActionFromStrategy(strategy?: string | null): string | null {
  if (!strategy) return null;
  const s = strategy.toLowerCase();
  if (/re[\s-]?engage|reconnect|reactivat|win[\s-]?back|dormant|lapsed/.test(s)) return "Re-Engage";
  if (/follow[\s-]?up|following up|next step|nudge/.test(s)) return "Send Follow-Up";
  if (/check[\s-]?in|checking in|touch base|maintain|active relationship|stay in touch/.test(s)) return "Check-In";
  if (/thank|gratitude|appreciat/.test(s)) return "Thank You";
  if (/intro|introduce|first outreach|new client/.test(s)) return "Introduction";
  return "Check-In";
}

function deriveActionLabel(draft: { action_label?: string | null; strategy?: string | null }) {
  return formatActionLabel(draft.action_label) ?? inferActionFromStrategy(draft.strategy);
}



function OutreachPage() {
  const { user } = useSession();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBuf, setEditBuf] = useState<{ subject: string; body: string }>({ subject: "", body: "" });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const handledDraftRef = useRef<string | null>(null);

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("outreach_drafts")
      .select("id, subject, tone, body, strategy, action_label, urgency, reasoning, confidence, cta, created_at, client_id, status, action_type, sent, sent_at, clients(id, name, email, notes, tags, last_contacted)")
      .eq("archived", false)
      .eq("sent", false)
      .order("created_at", { ascending: false });
    if (error) toast.error(error.message);
    else setDrafts((data ?? []) as unknown as Draft[]);
    setLoading(false);
  };

  useEffect(() => {
    if (!user) return;
    load();
    const ch = supabase
      .channel("outreach-feed")
      .on("postgres_changes", { event: "*", schema: "public", table: "outreach_drafts" }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [user]);

  // Auto-scroll & highlight a requested draft (?draft=<id>)
  useEffect(() => {
    const id = search.draft;
    if (!id || loading) return;
    if (handledDraftRef.current === id) return;
    const exists = drafts.some((d) => d.id === id);
    if (!exists) {
      toast.error("Follow-up draft not found.");
      handledDraftRef.current = id;
      navigate({ search: {}, replace: true });
      return;
    }
    handledDraftRef.current = id;
    const el = cardRefs.current.get(id);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      setHighlightId(id);
      setTimeout(() => setHighlightId((cur) => (cur === id ? null : cur)), 2400);
    }
    // Clean the param so re-loads don't re-trigger
    setTimeout(() => navigate({ search: {}, replace: true }), 100);
  }, [search.draft, drafts, loading, navigate]);



  const startEdit = (d: Draft) => {
    setEditingId(d.id);
    setEditBuf({ subject: sanitizeDraftText(d.subject), body: sanitizeDraftText(d.body) });
  };

  const saveEdit = async (d: Draft) => {
    if (!user) return;
    const { error } = await supabase
      .from("outreach_drafts")
      .update({ subject: editBuf.subject, body: editBuf.body })
      .eq("id", d.id);
    if (error) return toast.error(error.message);
    toast.success("Draft updated");
    await logActivity({
      user_id: user.id,
      client_id: d.client_id,
      client_name: d.clients?.name ?? null,
      action_type: "draft_edited",
      action_source: "outreach_page",
      details: `Edited outreach draft for ${d.clients?.name ?? "client"}`,
    });
    setEditingId(null);
    load();
  };

  const sendEmail = async (d: Draft) => {
    if (!user) return;
    if (d.sent || d.status === "sent") {
      toast.info("This draft has already been sent");
      return;
    }
    if (!d.clients?.email) {
      toast.error(`No email on file for ${d.clients?.name ?? "this client"}`);
      return;
    }
    const webhook = getGmailSendWebhook();
    if (!webhook) {
      toast.error("Configure the Gmail Send webhook in Settings first");
      return;
    }
    const isFollowup = d.action_type === "followup" || d.action_type === "follow-up";
    setSendingId(d.id);
    try {
      const result = await sendEmailViaWebhook({
        webhookUrl: webhook,
        draft_id: d.id,
        recipient_email: d.clients.email,
        subject: sanitizeDraftText(d.subject),
        body: sanitizeDraftText(d.body),
        client_id: d.clients.id,
        client_name: d.clients.name,
      });
      if (!result.success) {
        toast.error("Failed to send email", { description: result.error });
        return;
      }
      const sentAt = new Date().toISOString();
      const { error } = await supabase
        .from("outreach_drafts")
        .update({ sent: true, status: "sent", sent_at: sentAt })
        .eq("id", d.id);
      if (error) {
        toast.error(error.message);
        return;
      }

      // DB-driven relationship update — only after webhook confirmed success.
      // Status flips to "Active" for ANY successful send (outreach or
      // follow-up). This is the single source of truth for the badge
      // shown on Dashboard / Clients / Engagement Centre.
      await supabase
        .from("clients")
        .update({ status: "Active", last_contacted: sentAt.slice(0, 10) })
        .eq("id", d.client_id ?? "");

      // For follow-up drafts, also complete the linked follow_ups reminder so
      // it disappears from the Engagement Centre Follow-Up Reminders list.
      if (isFollowup) {
        await supabase
          .from("follow_ups")
          .update({ done: true, status: "completed", completed_at: sentAt, sent_at: sentAt })
          .eq("user_id", user.id)
          .eq("client_id", d.client_id ?? "")
          .neq("status", "completed");
      }

      // Schedule the next reminder using the user's configured interval.
      // Applies to ANY successful send so the lifecycle keeps cycling:
      // Outreach Sent → Active Conversation → Reminder Due → Follow-Up → ...
      if (d.client_id) {
        await scheduleNextReminder({ userId: user.id, clientId: d.client_id, sentAtIso: sentAt });
      }


      toast.success(isFollowup ? "Follow-up email sent successfully" : "Email sent successfully");
      await logActivity({
        user_id: user.id,
        client_id: d.client_id,
        client_name: d.clients?.name ?? null,
        action_type: isFollowup ? "followup_sent" : "draft_sent",
        action_source: "outreach_page",
        details: isFollowup
          ? `Follow-up email successfully sent to ${d.clients?.name ?? "client"}`
          : `Email successfully sent to ${d.clients?.name ?? "client"}`,
      });
      if (isFollowup) {
        await logActivity({
          user_id: user.id,
          client_id: d.client_id,
          client_name: d.clients?.name ?? null,
          action_type: "followup_completed",
          action_source: "outreach_page",
          details: `Reminder completed for ${d.clients?.name ?? "client"}`,
        });
      }
      try {
        await supabase.from("history_logs").insert({
          user_id: user.id,
          client_id: d.client_id,
          action_type: "email_sent",
          action_label: isFollowup ? "Follow-up email sent" : "Outreach email sent",
          metadata: {
            description: `Email successfully sent to ${d.clients?.name ?? "client"}`,
            subject: d.subject,
            to_email: d.clients.email,
          },
        });
      } catch (e) {
        console.warn("Failed to insert history log", e);
      }
    } finally {
      setSendingId(null);
      load();
    }
  };

  const archive = async (d: Draft) => {
    if (!user) return;
    const { error } = await supabase
      .from("outreach_drafts")
      .update({ archived: true, archived_at: new Date().toISOString() })
      .eq("id", d.id);
    if (error) return toast.error(error.message);
    toast.success("Draft archived — restore anytime from Archived Drafts");
    await logActivity({
      user_id: user.id,
      client_id: d.client_id,
      client_name: d.clients?.name ?? null,
      action_type: "draft_archived",
      action_source: "outreach_page",
      details: `Archived outreach draft for ${d.clients?.name ?? "client"}`,
    });
  };

  const regenerate = async (d: Draft, tone?: string) => {
    if (!user) return;
    const webhook = getOutreachWebhook();
    if (!webhook) {
      toast.error("Configure the n8n Outreach webhook in Settings first");
      return;
    }
    if (!d.clients) return;
    const isSameTone = !tone;
    setBusyId(d.id);
    try {
      const { success, ai, error: webhookError } = await callOutreachWebhook(webhook, {
        client_id: d.clients.id,
        user_id: user.id,
        client_name: d.clients.name,
        client_email: d.clients.email,
        tags: d.clients.tags,
        notes: d.clients.notes,
        last_contacted: d.clients.last_contacted,
        intent: d.strategy ?? "Regenerate",
        tone: isSameTone ? undefined : tone?.toLowerCase(),
        mode: isSameTone ? "same_tone" : "new_tone",
        previous_subject: d.subject,
        previous_body: d.body ?? "",
        previous_tone: d.tone ?? undefined,
      });
      if (!success) {
        toast.error("Draft generation failed.", { description: webhookError });
        return;
      }

      // If n8n returned the regenerated draft inline, upsert immediately.
      // Otherwise n8n will update Supabase asynchronously — realtime refresh
      // will pick up the new version automatically.
      if (ai) {
        const { error } = await upsertOutreachDraft({
          user_id: user.id,
          client_id: d.clients.id,
          subject: ai.subject,
          body: ai.body,
          tone: ai.tone,
          strategy: ai.strategy ?? d.strategy,
          action_label: ai.action_label ?? d.action_label,
          urgency: ai.urgency ?? d.urgency,
          reasoning: ai.reasoning ?? null,
          confidence: ai.confidence ?? null,
          cta: ai.cta ?? null,
        });
        if (error) {
          toast.error(error);
          return;
        }
      }

      toast.success("Draft generated successfully.");

      await logActivity({
        user_id: user.id,
        client_id: d.client_id,
        client_name: d.clients?.name ?? null,
        action_type: "outreach_generated",
        action_source: "outreach_page",
        details: isSameTone
          ? `Draft regenerated with Same Tone variation for ${d.clients?.name ?? "client"}`
          : `Draft regenerated in ${tone} tone for ${d.clients?.name ?? "client"}`,
      });
    } finally {
      setBusyId(null);
    }
  };



  return (
    <div className="mx-auto max-w-7xl space-y-6 animate-fade-in">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Outreach Drafts</h1>
        <p className="mt-1 text-sm text-muted-foreground">AI-generated messages, ready for your final touch.</p>
      </div>

      <div className="grid gap-4">
        {loading && (
          <div className="space-y-3">
            {[0,1].map((i) => <div key={i} className="h-48 rounded-lg bg-muted animate-pulse" />)}
          </div>
        )}

        {!loading && drafts.map((d) => {
          const isEditing = editingId === d.id;
          const busy = busyId === d.id;
          return (
            <Card
              key={d.id}
              ref={(el) => {
                if (el) cardRefs.current.set(d.id, el);
                else cardRefs.current.delete(d.id);
              }}
              className={cn(
                "border-border/60 shadow-[var(--shadow-soft)] transition-all hover:shadow-[var(--shadow-elevated)]",
                highlightId === d.id && "ring-2 ring-indigo-400 shadow-[var(--shadow-elevated)]"
              )}
            >
              <CardHeader className="space-y-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="outline" className="gap-1 bg-violet-50 text-violet-700 border-violet-200 text-[10.5px] font-medium">
                    <Sparkles className="h-3 w-3" /> AI generated
                  </Badge>
                  {d.tone && (
                    <Badge variant="outline" className="text-[10.5px] capitalize bg-indigo-50 text-indigo-700 border-indigo-200">{d.tone}</Badge>
                  )}
                  {(() => {
                    const label = deriveActionLabel(d);
                    if (!label) return null;
                    return (
                      <Badge variant="outline" className="text-[10.5px] bg-sky-50 text-sky-700 border-sky-200">
                        {label}
                      </Badge>
                    );
                  })()}

                  {d.urgency && (
                    <Badge variant="outline" className={cn("text-[10.5px] capitalize", URGENCY_STYLES[d.urgency] ?? "")}>
                      {d.urgency} urgency
                    </Badge>
                  )}
                  {(() => {
                    const pct = normalizeConfidence(d.confidence);
                    if (pct === null) {
                      return (
                        <Badge variant="outline" className="text-[10.5px] bg-slate-50 text-slate-600 border-slate-200">
                          AI Confidence: --
                        </Badge>
                      );
                    }
                    const tier =
                      pct >= 90
                        ? { cls: "bg-emerald-50 text-emerald-700 border-emerald-200", label: "Strong relationship context detected" }
                        : pct >= 70
                          ? { cls: "bg-amber-50 text-amber-800 border-amber-200", label: "Moderate context — could be enriched with more notes" }
                          : { cls: "bg-rose-50 text-rose-700 border-rose-200", label: "Limited client history available" };
                    return (
                      <TooltipProvider delayDuration={200}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge variant="outline" className={cn("text-[10.5px] cursor-help", tier.cls)}>
                              AI Confidence: {pct}%
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="max-w-[220px] text-xs">
                            {tier.label}
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    );
                  })()}
                  {(d.sent || d.status === "sent") && (
                    <Badge variant="outline" className="gap-1 text-[10.5px] bg-emerald-50 text-emerald-700 border-emerald-200">
                      <CheckCircle2 className="h-3 w-3" /> Sent{d.sent_at ? ` · ${timeAgo(d.sent_at)}` : ""}
                    </Badge>
                  )}
                  <span className="ml-auto text-[11px] text-muted-foreground">{timeAgo(d.created_at)}</span>
                </div>
                <div>
                  {isEditing ? (
                    <Input
                      value={editBuf.subject}
                      onChange={(e) => setEditBuf({ ...editBuf, subject: e.target.value })}
                      className="text-base font-semibold"
                    />
                  ) : (
                    <CardTitle className="text-base">{sanitizeDraftText(d.subject, "subject")}</CardTitle>
                  )}

                  <CardDescription>To {d.clients?.name ?? "—"}</CardDescription>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {isEditing ? (
                  <Textarea
                    rows={9}
                    value={editBuf.body}
                    onChange={(e) => setEditBuf({ ...editBuf, body: e.target.value })}
                    className="resize-none leading-relaxed"
                  />
                ) : (
                  <p className="text-sm leading-relaxed text-foreground/80 whitespace-pre-wrap">{sanitizeDraftText(d.body)}</p>
                )}

                {!isEditing && (() => {
                  const reasoningList = Array.isArray(d.reasoning)
                    ? d.reasoning
                    : typeof d.reasoning === "string" && d.reasoning
                      ? [d.reasoning]
                      : [];
                  if (reasoningList.length === 0) return null;
                  return (
                    <div className="rounded-lg border border-violet-100 bg-violet-50/40 px-3.5 py-3">
                      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-violet-700">
                        <Lightbulb className="h-3 w-3" /> Why this outreach?
                      </div>
                      <ul className="mt-1.5 space-y-1 text-xs text-foreground/75">
                        {reasoningList.map((r, i) => (
                          <li key={i} className="flex gap-2"><span className="text-violet-400">·</span>{String(r)}</li>
                        ))}
                      </ul>
                    </div>
                  );
                })()}

                <div className="flex flex-wrap gap-2">
                  {isEditing ? (
                    <>
                      <Button size="sm" onClick={() => saveEdit(d)}>Save</Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>Cancel</Button>
                    </>
                  ) : (
                    <>
                      {d.sent || d.status === "sent" ? (
                        <Button size="sm" disabled className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-600">
                          <CheckCircle2 className="h-3.5 w-3.5" /> Sent
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          className="gap-1.5 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white"
                          onClick={() => sendEmail(d)}
                          disabled={sendingId === d.id}
                        >
                          {sendingId === d.id ? (
                            <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Sending…</>
                          ) : (
                            <><Send className="h-3.5 w-3.5" /> Send</>
                          )}
                        </Button>
                      )}
                      {(() => {
                        const isSent = d.sent || d.status === "sent";
                        const isFollowup = d.action_type === "followup" || d.action_type === "follow-up";
                        return (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              className="gap-1.5"
                              onClick={() => startEdit(d)}
                              disabled={isSent}
                              title={isSent ? "This draft has already been sent" : undefined}
                            >
                              <Pencil className="h-3.5 w-3.5" /> Edit
                            </Button>
                            {!isFollowup && (
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="gap-1.5"
                                    disabled={busy || isSent}
                                    title={isSent ? "This draft has already been sent" : undefined}
                                  >
                                    {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                                    {busy ? "Regenerating..." : "Regenerate"}
                                    {!busy && <ChevronDown className="h-3 w-3 opacity-60" />}
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="start" className="w-48">
                                  <DropdownMenuLabel className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
                                    Regenerate with tone
                                  </DropdownMenuLabel>
                                  <DropdownMenuItem onClick={() => regenerate(d)}>
                                    <Sparkles className="h-3.5 w-3.5" /> Same Tone
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  {TONES.map((t) => (
                                    <DropdownMenuItem key={t} onClick={() => regenerate(d, t)}>
                                      {t}
                                    </DropdownMenuItem>
                                  ))}
                                </DropdownMenuContent>
                              </DropdownMenu>
                            )}
                          </>
                        );
                      })()}
                      <Button size="sm" variant="ghost" className="gap-1.5 text-muted-foreground" onClick={() => archive(d)}>
                        <Archive className="h-3.5 w-3.5" /> Archive
                      </Button>
                    </>
                  )}
                </div>

              </CardContent>
            </Card>
          );
        })}

        {!loading && drafts.length === 0 && (
          <Card className="border-dashed border-border/60">
            <CardContent className="py-12 text-center text-sm text-muted-foreground">
              No outreach drafts yet. Generate one from the Dashboard.
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
