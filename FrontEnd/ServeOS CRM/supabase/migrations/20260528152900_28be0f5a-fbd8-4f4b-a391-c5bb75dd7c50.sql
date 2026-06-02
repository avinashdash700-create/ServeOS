ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'New';

UPDATE public.clients SET status = 'New' WHERE status IS NULL;