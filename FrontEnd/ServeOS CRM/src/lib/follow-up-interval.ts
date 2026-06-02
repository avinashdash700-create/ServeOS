import { supabase } from "@/integrations/supabase/client";

export type FollowUpIntervalKey =
  | "5_minutes"
  | "15_minutes"
  | "1_day"
  | "3_days"
  | "7_days"
  | "15_days"
  | "30_days";

export const FOLLOW_UP_INTERVAL_OPTIONS: { value: FollowUpIntervalKey; label: string; ms: number; demo?: boolean; recommended?: boolean }[] = [
  { value: "5_minutes",  label: "5 Minutes (Demo)",  ms: 5 * 60 * 1000, demo: true },
  { value: "15_minutes", label: "15 Minutes (Demo)", ms: 15 * 60 * 1000, demo: true },
  { value: "1_day",      label: "1 Day",             ms: 1 * 24 * 60 * 60 * 1000 },
  { value: "3_days",     label: "3 Days",            ms: 3 * 24 * 60 * 60 * 1000 },
  { value: "7_days",     label: "7 Days",            ms: 7 * 24 * 60 * 60 * 1000 },
  { value: "15_days",    label: "15 Days (Recommended Production)", ms: 15 * 24 * 60 * 60 * 1000, recommended: true },
  { value: "30_days",    label: "30 Days",           ms: 30 * 24 * 60 * 60 * 1000 },
];

export const DEFAULT_FOLLOW_UP_INTERVAL: FollowUpIntervalKey = "5_minutes";

export function getIntervalMs(key: string | null | undefined): number {
  const found = FOLLOW_UP_INTERVAL_OPTIONS.find((o) => o.value === key);
  return (found ?? FOLLOW_UP_INTERVAL_OPTIONS[0]).ms;
}

export function isDemoInterval(key: string | null | undefined): boolean {
  return key === "5_minutes" || key === "15_minutes";
}

export async function fetchFollowUpInterval(userId: string): Promise<FollowUpIntervalKey> {
  const { data } = await supabase
    .from("profiles")
    .select("follow_up_interval")
    .eq("id", userId)
    .maybeSingle();
  const v = (data as { follow_up_interval?: string } | null)?.follow_up_interval;
  return (FOLLOW_UP_INTERVAL_OPTIONS.find((o) => o.value === v)?.value ?? DEFAULT_FOLLOW_UP_INTERVAL);
}

/**
 * Schedule the next follow-up reminder for a client after a successful send.
 * Uses the user's configured interval. Implemented via the existing
 * `follow_ups.snoozed_until` field so `buildActiveReminders` automatically
 * surfaces the reminder once the timer elapses.
 *
 * If a non-completed reminder already exists for the client it is updated
 * in-place; otherwise a new pending row is inserted.
 */
export async function scheduleNextReminder(params: {
  userId: string;
  clientId: string;
  sentAtIso: string;
  intervalKey?: FollowUpIntervalKey | null;
}): Promise<void> {
  const { userId, clientId, sentAtIso } = params;
  const key = params.intervalKey ?? (await fetchFollowUpInterval(userId));
  const dueAt = new Date(new Date(sentAtIso).getTime() + getIntervalMs(key)).toISOString();

  const { data: existing } = await supabase
    .from("follow_ups")
    .select("id, status, done")
    .eq("user_id", userId)
    .eq("client_id", clientId)
    .neq("status", "completed")
    .eq("done", false)
    .order("created_at", { ascending: false })
    .limit(1);

  const row = (existing ?? [])[0] as { id: string } | undefined;
  const payload = {
    status: "pending",
    snoozed_until: dueAt,
    done: false,
    completed_at: null as string | null,
    sent_at: null as string | null,
    draft_id: null as string | null,
    reason: "Scheduled follow-up",
  };

  if (row) {
    await supabase.from("follow_ups").update(payload).eq("id", row.id);
  } else {
    await supabase.from("follow_ups").insert({
      user_id: userId,
      client_id: clientId,
      ...payload,
    });
  }
}
