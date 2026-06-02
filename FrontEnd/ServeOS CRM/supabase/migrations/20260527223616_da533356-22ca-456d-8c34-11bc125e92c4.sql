ALTER TABLE public.follow_ups ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_follow_ups_user_client ON public.follow_ups(user_id, client_id);