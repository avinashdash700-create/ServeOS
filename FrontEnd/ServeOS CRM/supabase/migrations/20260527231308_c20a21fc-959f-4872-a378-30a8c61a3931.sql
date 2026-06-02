ALTER TABLE public.follow_ups
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;

UPDATE public.follow_ups
SET completed_at = COALESCE(completed_at, created_at)
WHERE status = 'completed' AND completed_at IS NULL;