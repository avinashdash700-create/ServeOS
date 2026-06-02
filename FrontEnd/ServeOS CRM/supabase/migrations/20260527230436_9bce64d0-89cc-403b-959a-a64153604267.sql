ALTER TABLE public.follow_ups
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS draft_id UUID;

UPDATE public.follow_ups
SET status = CASE
  WHEN done = true THEN 'completed'
  WHEN snoozed_until IS NOT NULL AND snoozed_until > now() THEN 'snoozed'
  ELSE 'pending'
END;

CREATE INDEX IF NOT EXISTS idx_follow_ups_user_status ON public.follow_ups(user_id, status);