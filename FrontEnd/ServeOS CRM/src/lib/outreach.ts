import { supabase } from "@/integrations/supabase/client";

export const OUTREACH_WEBHOOK_KEY = "serveos_outreach_webhook";
export const FOLLOWUP_WEBHOOK_KEY = "serveos_followup_webhook";
export const GMAIL_SEND_WEBHOOK_KEY = "serveos_gmail_send_webhook";

export type AIOutreach = {
  subject: string;
  body: string;
  tone: string;
  strategy?: string;
  action_label?: string;
  urgency?: string;
  reasoning?: string[];
  confidence?: number; // 0..1
  cta?: string;
};

export type OutreachContext = {
  client_id: string;
  user_id: string;
  client_name: string;
  client_email?: string | null;
  tags?: string[];
  notes?: string | null;
  last_contacted?: string | null;
  relationship_status?: string;
  intent?: string;
  /** User-selected tone (e.g. "friendly", "professional"). For "same tone" pass undefined and set mode="same_tone". */
  tone?: string;
  /** "same_tone" = preserve emotional style but rewrite wording. */
  mode?: "same_tone" | "new_tone";
  /** Previous draft contents — used by n8n for "same tone" rewrites and to avoid repetition. */
  previous_subject?: string;
  previous_body?: string;
  previous_tone?: string;
};

export function getOutreachWebhook(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(OUTREACH_WEBHOOK_KEY) || "";
}
export function setOutreachWebhook(url: string) {
  localStorage.setItem(OUTREACH_WEBHOOK_KEY, url);
}
export function getFollowupWebhook(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(FOLLOWUP_WEBHOOK_KEY) || "";
}
export function setFollowupWebhook(url: string) {
  localStorage.setItem(FOLLOWUP_WEBHOOK_KEY, url);
}
export function getGmailSendWebhook(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(GMAIL_SEND_WEBHOOK_KEY) || "";
}
export function setGmailSendWebhook(url: string) {
  localStorage.setItem(GMAIL_SEND_WEBHOOK_KEY, url);
}

/** Strip markdown code fences, JSON wrappers, and any unresolved
 *  handlebars/template placeholders (e.g. "{{ $json.client_name }}") from
 *  AI-generated draft text before rendering. If the payload is (or contains)
 *  a JSON blob with a `body`/`subject` field, extract that string. Falls
 *  back to a regex for truncated/malformed JSON so the user never sees raw
 *  `{ "subject": ..., "body": ... }` blobs. */
export function sanitizeDraftText(
  input: string | null | undefined,
  field: "body" | "subject" = "body",
): string {
  if (!input) return "";
  let s = String(input).trim();
  // Strip ```json ... ``` or ``` ... ``` fences (anywhere)
  s = s.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();

  const looksLikeJson = s.startsWith("{") || /"\s*(?:subject|body|cta|confidence_score)\s*"\s*:/i.test(s);
  if (looksLikeJson) {
    // Try whole-string parse first
    let extracted: string | null = null;
    try {
      const obj = JSON.parse(s);
      if (obj && typeof obj === "object") {
        const o = obj as Record<string, unknown>;
        const cand =
          (field === "subject" ? o.subject : undefined) ??
          o.body ?? o.text ?? o.content ?? o.message ?? o.subject;
        if (typeof cand === "string") extracted = cand;
      }
    } catch {
      // Try to extract a JSON object substring
      const start = s.indexOf("{");
      const end = s.lastIndexOf("}");
      if (start !== -1 && end > start) {
        try {
          const obj = JSON.parse(s.slice(start, end + 1));
          if (obj && typeof obj === "object") {
            const o = obj as Record<string, unknown>;
            const cand =
              (field === "subject" ? o.subject : undefined) ??
              o.body ?? o.text ?? o.content ?? o.message ?? o.subject;
            if (typeof cand === "string") extracted = cand;
          }
        } catch { /* fall through */ }
      }
    }
    // Last-resort regex for truncated JSON like  ..."body": "Hello\nThere"...
    if (extracted === null) {
      const key = field === "subject" ? "subject" : "body";
      const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "i");
      const m = s.match(re);
      if (m && typeof m[1] === "string") extracted = m[1];
    }
    if (extracted !== null) s = extracted;
  }

  // Normalize escaped newlines/quotes from JSON-extracted strings
  s = s.replace(/\\n/g, "\n").replace(/\\r/g, "").replace(/\\"/g, '"').replace(/\\t/g, "\t");
  // Remove unresolved handlebars placeholders like {{ $json.foo }} or {{ notes.x }}
  s = s.replace(/\{\{[\s\S]*?\}\}/g, "").trim();
  // Strip stray leading/trailing braces left over from malformed JSON
  s = s.replace(/^[{\s,]+/, "").replace(/[}\s,]+$/, "").trim();
  // Collapse 3+ blank lines
  s = s.replace(/\n{3,}/g, "\n\n");
  return s;
}

/** Normalize an AI confidence value into an integer 0..100.
 *  Accepts decimals (0.9 → 90) or already-normalized percentages (88 → 88).
 *  Returns null for null/undefined/NaN. */
export function normalizeConfidence(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const pct = n <= 1 ? Math.round(n * 100) : Math.round(n);
  return Math.min(100, Math.max(0, pct));
}

/** STRICT JSON parse + success-flag validation used by every n8n webhook call.
 *  A response is treated as successful ONLY when:
 *    - HTTP status is 2xx
 *    - body is non-empty
 *    - body parses as JSON
 *    - parsed payload contains { success: true }
 *  Everything else (timeout, network error, empty body, malformed JSON,
 *  missing `success`, `success: false`) is a failure. */
async function parseWebhookResponse(
  res: Response,
): Promise<{ ok: boolean; data: Record<string, unknown> | null; error?: string }> {
  if (!res.ok) return { ok: false, data: null, error: `Webhook returned ${res.status}` };
  const text = await res.text();
  if (!text) return { ok: false, data: null, error: "Empty webhook response" };
  let json: unknown;
  try { json = JSON.parse(text); } catch {
    return { ok: false, data: null, error: "Invalid webhook response" };
  }
  const d = (Array.isArray(json) ? json[0] : json) as Record<string, unknown> | null;
  if (!d || typeof d !== "object") {
    return { ok: false, data: null, error: "Webhook response missing payload" };
  }
  if (d.success !== true) {
    return { ok: false, data: d, error: (d.error as string) ?? "Webhook did not confirm success" };
  }
  return { ok: true, data: d };
}

/** Call the n8n Gmail Send webhook for an outreach draft.
 *  Only succeeds when the webhook explicitly returns { success: true }. */
export async function sendEmailViaWebhook(params: {
  webhookUrl: string;
  draft_id: string;
  recipient_email: string;
  subject: string;
  body: string;
  client_id: string;
  client_name: string;
}): Promise<{ success: boolean; error?: string }> {
  const payload = JSON.stringify({
    send_type: "outreach_draft",
    draft_id: params.draft_id,
    client_id: params.client_id,
    client_name: params.client_name,
    recipient_email: params.recipient_email,
    subject: params.subject,
    body: params.body,
    timestamp: new Date().toISOString(),
  });
  try {
    const res = await fetch(params.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });
    const parsed = await parseWebhookResponse(res);
    if (!parsed.ok) return { success: false, error: parsed.error };
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Network error",
    };
  }
}

/** STRICT follow-up send: only success if webhook returns
 *  { success: true, reminder_completed: true }. No no-cors fallback. */
export async function sendFollowupEmailViaWebhook(params: {
  webhookUrl: string;
  reminder_id: string | null;
  draft_id: string;
  client_id: string;
  user_id: string;
  recipient_email: string;
  subject: string;
  body: string;
  client_name: string;
}): Promise<{ success: boolean; reminder_completed: boolean; error?: string }> {
  const payload = JSON.stringify({
    send_type: "followup_reminder",
    reminder_id: params.reminder_id,
    draft_id: params.draft_id,
    client_id: params.client_id,
    user_id: params.user_id,
    recipient_email: params.recipient_email,
    subject: params.subject,
    body: params.body,
    client_name: params.client_name,
    timestamp: new Date().toISOString(),
  });
  try {
    const res = await fetch(params.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });
    const parsed = await parseWebhookResponse(res);
    if (!parsed.ok) return { success: false, reminder_completed: false, error: parsed.error };
    if (parsed.data?.reminder_completed !== true) {
      return { success: false, reminder_completed: false, error: "Reminder not confirmed by n8n" };
    }
    return { success: true, reminder_completed: true };
  } catch (err) {
    return { success: false, reminder_completed: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

/** Call the n8n outreach generation webhook.
 *  Requires { success: true } in the response. If n8n returns the draft
 *  inline alongside success, surface it as `ai`; otherwise n8n is generating
 *  asynchronously and the draft will arrive via Supabase realtime. */
export async function callOutreachWebhook(
  webhookUrl: string,
  ctx: OutreachContext,
): Promise<{ success: boolean; ai: AIOutreach | null; error?: string }> {
  const resolvedTone = ctx.mode === "same_tone" ? ctx.previous_tone ?? "professional" : ctx.tone ?? "professional";
  const payload = {
    ...ctx,
    tone_override: ctx.tone ?? null,
    mode: ctx.mode ?? "new_tone",
    timestamp: new Date().toISOString(),
  };

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const parsed = await parseWebhookResponse(res);
    if (!parsed.ok) return { success: false, ai: null, error: parsed.error };
    const d = parsed.data!;
    if (!d.subject && !d.body) {
      // success confirmed, draft will arrive async via Supabase realtime
      return { success: true, ai: null };
    }

    let confidence: number | undefined;
    if (typeof d.ai_confidence === "number") confidence = d.ai_confidence / 100;
    else if (typeof d.confidence === "number") confidence = d.confidence > 1 ? d.confidence / 100 : d.confidence;

    return {
      success: true,
      ai: {
        subject: (d.subject as string) ?? `Reaching out to ${ctx.client_name}`,
        body: (d.body as string) ?? "",
        tone: (d.tone as string) ?? resolvedTone,
        strategy: d.strategy as string | undefined,
        action_label: (d.action_label as string | undefined) ?? (d.actionLabel as string | undefined),
        urgency: d.urgency as string | undefined,
        reasoning: Array.isArray(d.reasoning)
          ? (d.reasoning as string[])
          : typeof d.reasoning === "string" && d.reasoning
            ? [d.reasoning as string]
            : undefined,
        confidence,
        cta: d.cta as string | undefined,
      },
    };
  } catch (err) {
    return {
      success: false,
      ai: null,
      error: err instanceof Error ? err.message : "Network error",
    };
  }
}


/** Call the n8n Follow-Up Generation webhook. Requires { success: true }. */
export async function callFollowupWebhook(
  webhookUrl: string,
  ctx: OutreachContext,
): Promise<{ success: boolean; error?: string }> {
  const payload = JSON.stringify({
    ...ctx,
    intent: ctx.intent ?? "follow_up",
    timestamp: new Date().toISOString(),
  });
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });
    const parsed = await parseWebhookResponse(res);
    if (!parsed.ok) return { success: false, error: parsed.error };
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Network error",
    };
  }
}


export type ActionType =
  | "outreach_generated"
  | "followup_generated"
  | "followup_draft_ready"
  | "draft_edited"
  | "draft_sent"
  | "followup_sent"
  | "draft_archived"
  | "draft_restored"
  | "draft_deleted"
  | "reminder_snoozed"
  | "followup_completed"
  | "client_added"
  | "client_updated"
  | "client_deleted";

export type ActionSource =
  | "dashboard"
  | "outreach_page"
  | "followups_page"
  | "clients_page"
  | "ai_workflow";

export async function logActivity(params: {
  user_id: string;
  client_id?: string | null;
  client_name?: string | null;
  action_type: ActionType;
  action_source: ActionSource;
  details: string;
}) {
  try {
    await supabase.from("activity_history").insert({
      user_id: params.user_id,
      client_id: params.client_id ?? null,
      client_name: params.client_name ?? null,
      action_type: params.action_type,
      action_source: params.action_source,
      details: params.details,
    });
  } catch (e) {
    console.warn("Failed to log activity", e);
  }
}

/** Upsert an outreach draft so we never create duplicates for the same (user, client). */
export async function upsertOutreachDraft(params: {
  user_id: string;
  client_id: string;
  subject: string;
  body: string;
  tone?: string | null;
  strategy?: string | null;
  action_label?: string | null;
  urgency?: string | null;
  reasoning?: string[] | null;
  confidence?: number | null;
  cta?: string | null;
}): Promise<{ error: string | null; id: string | null; created: boolean }> {
  // Find an existing non-archived draft for this (user, client)
  const { data: existing, error: findErr } = await supabase
    .from("outreach_drafts")
    .select("id")
    .eq("user_id", params.user_id)
    .eq("client_id", params.client_id)
    .eq("archived", false)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (findErr) return { error: findErr.message, id: null, created: false };

  // Only write fields that the webhook actually provided — never overwrite existing
  // webhook data with null/undefined just because the next call omitted a field.
  const payload: Record<string, unknown> = {
    subject: params.subject,
    body: params.body,
    updated_at: new Date().toISOString(),
  };
  if (params.tone !== undefined && params.tone !== null) payload.tone = params.tone;
  if (params.strategy !== undefined && params.strategy !== null) payload.strategy = params.strategy;
  if (params.action_label !== undefined && params.action_label !== null) payload.action_label = params.action_label;
  if (params.urgency !== undefined && params.urgency !== null) payload.urgency = params.urgency;
  if (params.reasoning !== undefined && params.reasoning !== null) payload.reasoning = params.reasoning;
  if (params.confidence !== undefined && params.confidence !== null) payload.confidence = params.confidence;
  if (params.cta !== undefined && params.cta !== null) payload.cta = params.cta;

  if (existing?.id) {
    payload.status = "draft";
    payload.sent = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await supabase.from("outreach_drafts").update(payload as any).eq("id", existing.id);
    return { error: error?.message ?? null, id: existing.id, created: false };
  }
  const { data: inserted, error } = await supabase
    .from("outreach_drafts")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .insert({ user_id: params.user_id, client_id: params.client_id, ...payload } as any)
    .select("id")
    .single();
  return { error: error?.message ?? null, id: inserted?.id ?? null, created: true };
}



/** A client is "actively engaged" if an unarchived outreach draft was created in the last N days. */
export async function getRecentlyEngagedClientIds(days = 7): Promise<Set<string>> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("outreach_drafts")
    .select("client_id, created_at, archived")
    .eq("archived", false)
    .gte("created_at", since);
  if (error || !data) return new Set();
  return new Set(data.map((r) => r.client_id).filter(Boolean) as string[]);
}
