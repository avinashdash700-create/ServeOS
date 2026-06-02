import { supabase } from "@/integrations/supabase/client";

export type FollowUpStatus =
  | "Active Conversation"
  | "Active"
  | "Warm"
  | "Follow Up Needed"
  | "Cold"
  | "New";

export function daysSince(date: string | null | undefined): number | null {
  if (!date) return null;
  const then = new Date(date).getTime();
  if (Number.isNaN(then)) return null;
  return Math.floor((Date.now() - then) / (1000 * 60 * 60 * 24));
}

/**
 * Dynamic relationship-status engine. Single source of truth used by Dashboard,
 * Clients, Outreach and Engagement Centre. No status is read from the DB —
 * everything is derived from `last_contacted` and the most recent successful
 * send timestamp (`lastSentAt`, from outreach_drafts.sent_at or
 * follow_ups.sent_at, whichever is newer).
 *
 * Priority order:
 *   1. Active Conversation  — sent within 7 days (overrides everything)
 *   2. Active               — last_contacted ≤ 14 days
 *   3. Warm                 — last_contacted 15–30 days
 *   4. Follow Up Needed     — last_contacted 31–45 days
 *   5. Cold                 — last_contacted > 45 days
 *   6. New                  — never contacted
 */
export function getFollowUpStatus(
  lastContacted: string | null | undefined,
  _dbStatus?: string | null,
  lastSentAt?: string | null,
): FollowUpStatus {
  const sentDays = daysSince(lastSentAt ?? null);
  if (sentDays !== null && sentDays <= 7) return "Active Conversation";
  const d = daysSince(lastContacted);
  if (d === null) return "New";
  if (d <= 14) return "Active";
  if (d <= 30) return "Warm";
  if (d <= 45) return "Follow Up Needed";
  return "Cold";
}

// Sorting weight for "needs attention" lists.
export const ATTENTION_RANK: Record<FollowUpStatus, number> = {
  Cold: 0,
  "Follow Up Needed": 1,
  Warm: 2,
  New: 3,
  Active: 4,
  "Active Conversation": 5,
};

export function statusBadgeClasses(status: FollowUpStatus): string {
  switch (status) {
    case "Active Conversation":
      return "bg-emerald-100 text-emerald-800 border-emerald-300";
    case "Active":
      return "bg-green-50 text-green-700 border-green-200";
    case "Warm":
      return "bg-yellow-100 text-yellow-800 border-yellow-200";
    case "Follow Up Needed":
      return "bg-orange-100 text-orange-700 border-orange-200";
    case "Cold":
      return "bg-red-100 text-red-700 border-red-200";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

// ---------------------------------------------------------------------------
// Last-sent lookup. Builds a Map<client_id, ISO timestamp> of the most recent
// successful outreach OR follow-up send for the given user. Used to derive
// "Active Conversation" status across every surface.
// ---------------------------------------------------------------------------
export async function fetchLastSentMap(userId: string): Promise<Map<string, string>> {
  const [{ data: drafts }, { data: fus }] = await Promise.all([
    supabase
      .from("outreach_drafts")
      .select("client_id, sent_at")
      .eq("user_id", userId)
      .eq("sent", true)
      .not("sent_at", "is", null),
    supabase
      .from("follow_ups")
      .select("client_id, sent_at")
      .eq("user_id", userId)
      .not("sent_at", "is", null),
  ]);
  const map = new Map<string, string>();
  const consider = (cid: string | null, ts: string | null) => {
    if (!cid || !ts) return;
    const prev = map.get(cid);
    if (!prev || new Date(ts).getTime() > new Date(prev).getTime()) map.set(cid, ts);
  };
  for (const r of (drafts ?? []) as { client_id: string | null; sent_at: string | null }[]) consider(r.client_id, r.sent_at);
  for (const r of (fus ?? []) as { client_id: string | null; sent_at: string | null }[]) consider(r.client_id, r.sent_at);
  return map;
}

// ---------------------------------------------------------------------------
// Shared reminder computation. Used by Engagement Centre AND sidebar badge so
// the active-reminder count is always identical and DB-driven.
// ---------------------------------------------------------------------------

export type ReminderClient = {
  id: string;
  name: string;
  email: string | null;
  notes: string | null;
  tags: string[];
  last_contacted: string | null;
  status: string | null;
};

export type ReminderFollowUp = {
  id: string;
  client_id: string | null;
  done: boolean;
  status: string;
  snoozed_until: string | null;
  draft_id: string | null;
};

export type ActiveReminder = {
  client: ReminderClient;
  status: "Today" | "Upcoming" | "Overdue";
  workflowStatus: "pending" | "draft_ready";
  context: string;
  followUpId: string | null;
  snoozedUntil: string | null;
  draftId: string | null;
};

export function buildActiveReminders(
  clients: ReminderClient[],
  followUps: ReminderFollowUp[],
  lastSentMap?: Map<string, string>,
): ActiveReminder[] {
  const fuByClient = new Map<string, ReminderFollowUp>();
  for (const fu of followUps) {
    if (fu.client_id) fuByClient.set(fu.client_id, fu);
  }
  const now = Date.now();
  const out: ActiveReminder[] = [];
  for (const c of clients) {
    const fu = fuByClient.get(c.id) ?? null;
    if (fu?.status === "completed" || fu?.done) continue;
    if (fu?.snoozed_until && new Date(fu.snoozed_until).getTime() > now) continue;
    const isDraftReady = fu?.status === "draft_ready";
    const hasSentOutreach = !!lastSentMap?.get(c.id);
    // A pending reminder row whose configured timer has elapsed (snoozed_until
    // in the past, or absent) is an explicit scheduled follow-up — it should
    // surface regardless of recency-based status.
    const hasScheduledReminderDue = !!fu && fu.status === "pending" && !fu.done;
    // LIFECYCLE GATE — a client may NEVER appear in Follow-Up Reminders
    // until at least one outreach email has been successfully sent.
    // (A prepared follow-up draft or scheduled reminder is the only exception.)
    if (!hasSentOutreach && !isDraftReady && !hasScheduledReminderDue) continue;
    const status = getFollowUpStatus(c.last_contacted, c.status, lastSentMap?.get(c.id) ?? null);
    // Recency-based suppression only applies when there is no explicit pending
    // reminder. With a scheduled reminder, the user's configured interval is
    // the source of truth — not the 7-day "Active Conversation" rule.
    if (!isDraftReady && !hasScheduledReminderDue && (status === "Active Conversation" || status === "Active")) continue;

    const d = daysSince(c.last_contacted);
    let rStatus: ActiveReminder["status"];
    let context: string;
    if (isDraftReady) { rStatus = "Today"; context = "Follow-up draft ready — awaiting send"; }
    else if (status === "Cold") { rStatus = "Overdue"; context = d !== null ? `Last outreach ${d} days ago` : "No recent outreach"; }
    else if (status === "Follow Up Needed") { rStatus = "Today"; context = d !== null ? `Last outreach ${d} days ago` : "Follow-up due"; }
    else if (status === "Warm") { rStatus = "Upcoming"; context = d !== null ? `Last outreach ${d} days ago` : "Stay in touch soon"; }
    else { rStatus = "Upcoming"; context = "New relationship — reach out soon"; }

    out.push({
      client: c,
      status: rStatus,
      workflowStatus: isDraftReady ? "draft_ready" : "pending",
      context,
      followUpId: fu?.id ?? null,
      snoozedUntil: fu?.snoozed_until ?? null,
      draftId: fu?.draft_id ?? null,
    });
  }
  const rank = { Overdue: 0, Today: 1, Upcoming: 2 } as const;
  out.sort((a, b) => rank[a.status] - rank[b.status]);
  return out;
}
