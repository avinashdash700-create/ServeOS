ALTER TABLE public.history_logs
  ADD CONSTRAINT history_logs_client_id_fkey
  FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE SET NULL;

ALTER TABLE public.history_logs
  ADD CONSTRAINT history_logs_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS history_logs_user_created_idx
  ON public.history_logs (user_id, created_at DESC);