import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Search, Clock, Sparkles, BellRing, Mail, UserPlus, UserCog, Trash2, Send, Archive, Pencil, FileText, RotateCcw } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/lib/auth";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/history")({
  head: () => ({ meta: [{ title: "History — ServeOS" }] }),
  component: HistoryPage,
});

type Row = {
  id: string;
  client_id: string | null;
  client_name: string | null;
  action_type: string;
  action_source: string | null;
  details: string | null;
  created_at: string;
};

const FILTERS = [
  { id: "all", label: "All Activity" },
  { id: "outreach", label: "Outreach", types: ["outreach_generated", "draft_sent", "draft_archived", "draft_restored", "draft_deleted"] },
  { id: "followups", label: "Follow-Ups", types: ["followup_generated", "followup_draft_ready", "followup_sent", "followup_completed", "reminder_snoozed"] },
  { id: "drafts", label: "Drafts", types: ["draft_edited", "draft_sent", "draft_archived", "draft_restored", "draft_deleted"] },
  { id: "clients", label: "Client Actions", types: ["client_added", "client_updated", "client_deleted"] },
] as const;

const ACTION_META: Record<string, { label: string; icon: typeof Sparkles; color: string }> = {
  outreach_generated:   { label: "Outreach Draft Generated", icon: Sparkles, color: "bg-violet-50 text-violet-700 border-violet-200" },
  followup_generated:   { label: "Follow-Up Draft Generated", icon: BellRing, color: "bg-indigo-50 text-indigo-700 border-indigo-200" },
  followup_draft_ready: { label: "Follow-Up Ready to Send", icon: FileText, color: "bg-indigo-50 text-indigo-700 border-indigo-200" },
  draft_edited:         { label: "Draft Edited",   icon: Pencil,  color: "bg-amber-50 text-amber-700 border-amber-200" },
  draft_sent:           { label: "Outreach Email Sent",     icon: Send,    color: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  followup_sent:        { label: "Follow-Up Email Sent",    icon: Send,    color: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  draft_archived:       { label: "Draft Archived", icon: Archive, color: "bg-slate-50 text-slate-700 border-slate-200" },
  draft_restored:       { label: "Draft Restored", icon: RotateCcw, color: "bg-sky-50 text-sky-700 border-sky-200" },
  draft_deleted:        { label: "Draft Deleted",  icon: Trash2, color: "bg-red-50 text-red-700 border-red-200" },
  reminder_snoozed:     { label: "Reminder Snoozed", icon: BellRing, color: "bg-amber-50 text-amber-700 border-amber-200" },
  followup_completed:   { label: "Reminder Completed", icon: Mail, color: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  client_added:         { label: "Client Added",   icon: UserPlus, color: "bg-blue-50 text-blue-700 border-blue-200" },
  client_updated:       { label: "Client Updated", icon: UserCog,  color: "bg-blue-50 text-blue-700 border-blue-200" },
  client_deleted:       { label: "Client Deleted", icon: Trash2,   color: "bg-red-50 text-red-700 border-red-200" },
};

function initials(name: string | null) {
  if (!name) return "?";
  return name.split(/\s+/).filter(Boolean).map((s) => s[0]).join("").slice(0, 2).toUpperCase();
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

function groupOf(iso: string): "Today" | "Yesterday" | "Earlier" {
  const d = new Date(iso);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const target = new Date(d); target.setHours(0, 0, 0, 0);
  const diff = (today.getTime() - target.getTime()) / 86400000;
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return "Earlier";
}

function HistoryPage() {
  const { user } = useSession();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("all");
  const [q, setQ] = useState("");

  const load = async () => {
    setLoading(true);
    const { data } = await supabase
      .from("activity_history")
      .select("id, client_id, client_name, action_type, action_source, details, created_at")
      .order("created_at", { ascending: false })
      .limit(300);
    setRows((data ?? []) as Row[]);
    setLoading(false);
  };

  useEffect(() => {
    if (!user) return;
    load();
    const ch = supabase
      .channel("history-feed")
      .on("postgres_changes", { event: "*", schema: "public", table: "activity_history" }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [user]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (filter !== "all") {
        const types = (FILTERS.find((f) => f.id === filter) as { types?: string[] })?.types;
        if (types && !types.includes(r.action_type)) return false;
      }
      if (q) {
        const blob = `${r.client_name ?? ""} ${r.details ?? ""} ${r.action_type}`.toLowerCase();
        if (!blob.includes(q.toLowerCase())) return false;
      }
      return true;
    });
  }, [rows, filter, q]);

  const groups = useMemo(() => {
    const g: Record<string, Row[]> = { Today: [], Yesterday: [], Earlier: [] };
    filtered.forEach((r) => g[groupOf(r.created_at)].push(r));
    return g;
  }, [filtered]);

  return (
    <div className="mx-auto max-w-7xl space-y-6 animate-fade-in">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">History</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Track all CRM and AI activity across your workspace.
        </p>
      </div>

      <Card className="border-border/70 shadow-[var(--shadow-soft)]">
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="relative w-full md:max-w-sm">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search activity..."
                className="pl-9"
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  onClick={() => setFilter(f.id)}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs font-medium transition",
                    filter === f.id
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background text-muted-foreground hover:bg-accent",
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <div className="space-y-3">
          {[0,1,2,3].map((i) => (
            <div key={i} className="h-16 rounded-lg bg-muted animate-pulse" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <Card className="border-dashed border-border/60">
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            No activity yet. Actions you take will appear here.
          </CardContent>
        </Card>
      ) : (
        (["Today", "Yesterday", "Earlier"] as const).map((label) => {
          const items = groups[label];
          if (!items.length) return null;
          return (
            <section key={label} className="space-y-3">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</h2>
              <ol className="relative space-y-2 border-l border-border/60 pl-5">
                {items.map((r) => {
                  const meta = ACTION_META[r.action_type] ?? {
                    label: r.action_type, icon: Clock, color: "bg-muted text-muted-foreground border-border",
                  };
                  const Icon = meta.icon;
                  return (
                    <li key={r.id} className="relative">
                      <span className="absolute -left-[26px] top-3 flex h-3 w-3 items-center justify-center rounded-full border-2 border-background bg-primary" />
                      <div className="flex items-start gap-3 rounded-lg border border-border/60 bg-card p-3.5 transition-colors hover:bg-muted/40">
                        <Avatar className="h-9 w-9 shrink-0">
                          <AvatarFallback className="bg-primary/10 text-primary text-xs font-semibold">
                            {initials(r.client_name)}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="outline" className={cn("gap-1 font-medium text-[10.5px]", meta.color)}>
                              <Icon className="h-3 w-3" /> {meta.label}
                            </Badge>
                            {r.client_name && (
                              <span className="text-sm font-medium text-foreground">{r.client_name}</span>
                            )}
                          </div>
                          {r.details && (
                            <p className="mt-1 text-sm text-muted-foreground">{r.details}</p>
                          )}
                          <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground/80">
                            <span>{timeAgo(r.created_at)}</span>
                            {r.action_source && (
                              <>
                                <span>·</span>
                                <Badge variant="secondary" className="font-normal text-[10px] capitalize">
                                  {r.action_source.replace(/_/g, " ")}
                                </Badge>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>
          );
        })
      )}
    </div>
  );
}
