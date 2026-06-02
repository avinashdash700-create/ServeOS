
-- 1. activity_history table
CREATE TABLE public.activity_history (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  client_id UUID,
  client_name TEXT,
  action_type TEXT NOT NULL,
  action_source TEXT,
  details TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.activity_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own activity"
  ON public.activity_history FOR SELECT
  USING (auth.uid() = user_id);
CREATE POLICY "Users insert own activity"
  ON public.activity_history FOR INSERT
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own activity"
  ON public.activity_history FOR UPDATE
  USING (auth.uid() = user_id);
CREATE POLICY "Users delete own activity"
  ON public.activity_history FOR DELETE
  USING (auth.uid() = user_id);

CREATE INDEX idx_activity_history_user_created
  ON public.activity_history (user_id, created_at DESC);

-- 2. outreach_drafts extra columns
ALTER TABLE public.outreach_drafts
  ADD COLUMN IF NOT EXISTS strategy TEXT,
  ADD COLUMN IF NOT EXISTS urgency TEXT,
  ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false;

-- 3. Tighten RLS: drop public-read/insert policies
DROP POLICY IF EXISTS "Allow public read" ON public.clients;
DROP POLICY IF EXISTS "Allow public read followups" ON public.follow_ups;
DROP POLICY IF EXISTS "Allow public insert followups" ON public.follow_ups;
DROP POLICY IF EXISTS "Allow public read outreach drafts" ON public.outreach_drafts;
DROP POLICY IF EXISTS "Allow public insert outreach drafts" ON public.outreach_drafts;

-- Ensure SELECT policy exists on clients (was only public-read before)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='clients' AND policyname='Users can view own clients'
  ) THEN
    CREATE POLICY "Users can view own clients"
      ON public.clients FOR SELECT
      USING (auth.uid() = user_id);
  END IF;
END $$;

-- 4. Realtime
ALTER TABLE public.outreach_drafts REPLICA IDENTITY FULL;
ALTER TABLE public.follow_ups REPLICA IDENTITY FULL;
ALTER TABLE public.activity_history REPLICA IDENTITY FULL;

DO $$ BEGIN
  PERFORM 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='outreach_drafts';
  IF NOT FOUND THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.outreach_drafts';
  END IF;
  PERFORM 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='follow_ups';
  IF NOT FOUND THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.follow_ups';
  END IF;
  PERFORM 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='activity_history';
  IF NOT FOUND THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.activity_history';
  END IF;
END $$;
