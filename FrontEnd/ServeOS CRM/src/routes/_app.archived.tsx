import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Archive, RotateCcw, Trash2, Sparkles, Search, Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/lib/auth";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { logActivity, normalizeConfidence } from "@/lib/outreach";

export const Route = createFileRoute("/_app/archived")({
  head: () => ({ meta: [{ title: "Archived Drafts — ServeOS" }] }),
  component: ArchivedPage,
});

type Draft = {
  id: string;
  subject: string;
  tone: string | null;
  body: string | null;
  strategy: string | null;
  action_label: string | null;
  urgency: string | null;
  confidence: number | null;
  created_at: string;
  archived_at: string | null;
  client_id: string | null;
  clients: { id: string; name: string } | null;
};

const URGENCY_STYLES: Record<string, string> = {
  high: "bg-red-50 text-red-700 border-red-200",
  normal: "bg-slate-50 text-slate-700 border-slate-200",
  low: "bg-emerald-50 text-emerald-700 border-emerald-200",
};

function formatActionLabel(raw?: string | null) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s) return null;
  s = s.replace(/\s*(draft\s+generated|draft|generated)\s*$/i, "").trim();
  if (!s) return null;
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

function timeAgo(iso: string | null) {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function ArchivedPage() {
  const { user } = useSession();
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Draft | null>(null);
  const [search, setSearch] = useState("");
  const [toneFilter, setToneFilter] = useState<string>("all");
  const [strategyFilter, setStrategyFilter] = useState<string>("all");
  const [dateFilter, setDateFilter] = useState<string>("all");

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("outreach_drafts")
      .select("id, subject, tone, body, strategy, action_label, urgency, confidence, created_at, archived_at, client_id, clients(id, name)")
      .eq("archived", true)
      .order("archived_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false });
    if (error) toast.error(error.message);
    else setDrafts((data ?? []) as unknown as Draft[]);
    setLoading(false);
  };

  useEffect(() => {
    if (!user) return;
    load();
    const ch = supabase
      .channel("archived-feed")
      .on("postgres_changes", { event: "*", schema: "public", table: "outreach_drafts" }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [user]);

  const tones = useMemo(
    () => Array.from(new Set(drafts.map((d) => d.tone).filter(Boolean))) as string[],
    [drafts],
  );
  const strategies = useMemo(
    () => Array.from(new Set(drafts.map((d) => d.strategy).filter(Boolean))) as string[],
    [drafts],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const now = Date.now();
    return drafts.filter((d) => {
      if (q && !(d.clients?.name ?? "").toLowerCase().includes(q)) return false;
      if (toneFilter !== "all" && d.tone !== toneFilter) return false;
      if (strategyFilter !== "all" && d.strategy !== strategyFilter) return false;
      if (dateFilter !== "all" && d.archived_at) {
        const days = (now - new Date(d.archived_at).getTime()) / 86400000;
        if (dateFilter === "7" && days > 7) return false;
        if (dateFilter === "30" && days > 30) return false;
        if (dateFilter === "90" && days > 90) return false;
      }
      return true;
    });
  }, [drafts, search, toneFilter, strategyFilter, dateFilter]);

  const restore = async (d: Draft) => {
    if (!user) return;
    setBusyId(d.id);
    const { error } = await supabase
      .from("outreach_drafts")
      .update({ archived: false, archived_at: null })
      .eq("id", d.id);
    setBusyId(null);
    if (error) return toast.error(error.message);
    toast.success("Draft restored");
    await logActivity({
      user_id: user.id,
      client_id: d.client_id,
      client_name: d.clients?.name ?? null,
      action_type: "draft_restored",
      action_source: "outreach_page",
      details: `Restored archived draft for ${d.clients?.name ?? "client"}`,
    });
  };

  const permanentDelete = async (d: Draft) => {
    if (!user) return;
    setBusyId(d.id);
    const { error } = await supabase.from("outreach_drafts").delete().eq("id", d.id);
    setBusyId(null);
    setConfirmDelete(null);
    if (error) return toast.error(error.message);
    toast.success("Draft deleted permanently");
    await logActivity({
      user_id: user.id,
      client_id: d.client_id,
      client_name: d.clients?.name ?? null,
      action_type: "draft_deleted",
      action_source: "outreach_page",
      details: `Permanently deleted archived draft for ${d.clients?.name ?? "client"}`,
    });
  };

  return (
    <div className="mx-auto max-w-7xl space-y-6 animate-fade-in">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Archived Drafts</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Drafts you've set aside. Restore them anytime or permanently delete to clean up.
        </p>
      </div>

      <Card className="border-border/60">
        <CardContent className="flex flex-wrap items-center gap-2 p-3">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by client name…"
              className="h-9 pl-8"
            />
          </div>
          <Select value={toneFilter} onValueChange={setToneFilter}>
            <SelectTrigger className="h-9 w-[140px]"><SelectValue placeholder="Tone" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All tones</SelectItem>
              {tones.map((t) => <SelectItem key={t} value={t} className="capitalize">{t}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={strategyFilter} onValueChange={setStrategyFilter}>
            <SelectTrigger className="h-9 w-[160px]"><SelectValue placeholder="Strategy" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All strategies</SelectItem>
              {strategies.map((s) => <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={dateFilter} onValueChange={setDateFilter}>
            <SelectTrigger className="h-9 w-[160px]"><SelectValue placeholder="Archived" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any time</SelectItem>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
              <SelectItem value="90">Last 90 days</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <div className="grid gap-4">
        {loading && (
          <div className="space-y-3">
            {[0, 1].map((i) => <div key={i} className="h-36 rounded-lg bg-muted animate-pulse" />)}
          </div>
        )}

        {!loading && filtered.map((d) => {
          const busy = busyId === d.id;
          const pct = normalizeConfidence(d.confidence);
          const conf = pct == null
            ? null
            : pct >= 90
              ? "bg-emerald-50 text-emerald-700 border-emerald-200"
              : pct >= 70
                ? "bg-amber-50 text-amber-800 border-amber-200"
                : "bg-rose-50 text-rose-700 border-rose-200";
          return (
            <Card
              key={d.id}
              className="border-border/60 shadow-[var(--shadow-soft)] transition-all hover:shadow-[var(--shadow-elevated)] animate-fade-in"
            >
              <CardHeader className="space-y-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="outline" className="gap-1 bg-slate-50 text-slate-700 border-slate-200 text-[10.5px] font-medium">
                    <Archive className="h-3 w-3" /> Archived
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
                  {pct != null && (
                    <Badge variant="outline" className={cn("text-[10.5px]", conf ?? "")}>
                      <Sparkles className="mr-1 h-3 w-3" /> AI Confidence: {pct}%
                    </Badge>
                  )}
                  <span className="ml-auto text-[11px] text-muted-foreground">
                    Archived {timeAgo(d.archived_at)} · Created {timeAgo(d.created_at)}
                  </span>
                </div>
                <div>
                  <CardTitle className="text-base">{d.subject}</CardTitle>
                  <CardDescription>To {d.clients?.name ?? "—"}</CardDescription>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm leading-relaxed text-foreground/75 whitespace-pre-wrap line-clamp-4">{d.body}</p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    className="gap-1.5 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white"
                    disabled={busy}
                    onClick={() => restore(d)}
                  >
                    {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                    Restore
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5 text-rose-700 hover:text-rose-700 hover:bg-rose-50 border-rose-200"
                    disabled={busy}
                    onClick={() => setConfirmDelete(d)}
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Delete Permanently
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}

        {!loading && filtered.length === 0 && (
          <Card className="border-dashed border-border/60">
            <CardContent className="py-12 text-center text-sm text-muted-foreground">
              {drafts.length === 0
                ? "No archived drafts. Drafts you archive will land here."
                : "No archived drafts match the current filters."}
            </CardContent>
          </Card>
        )}
      </div>

      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this outreach draft permanently?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove the draft for{" "}
              <span className="font-medium text-foreground">{confirmDelete?.clients?.name ?? "this client"}</span>.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 hover:bg-rose-500"
              onClick={() => confirmDelete && permanentDelete(confirmDelete)}
            >
              Delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
