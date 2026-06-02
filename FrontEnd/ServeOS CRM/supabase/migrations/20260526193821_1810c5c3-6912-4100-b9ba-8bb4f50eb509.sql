
ALTER TABLE public.outreach_drafts
  ADD COLUMN IF NOT EXISTS reasoning jsonb,
  ADD COLUMN IF NOT EXISTS confidence numeric,
  ADD COLUMN IF NOT EXISTS cta text;
