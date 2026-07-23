-- Legacy hardening migration.
-- API credentials now live in the server's environment, not in Supabase.
-- This preserves an existing table for manual recovery while removing client access.

DO $$
BEGIN
  IF to_regclass('public.user_settings') IS NOT NULL THEN
    ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "allow anon read" ON public.user_settings;
    DROP POLICY IF EXISTS "allow service role write" ON public.user_settings;
    DROP POLICY IF EXISTS "Allow anonymous read and write" ON public.user_settings;
    REVOKE ALL ON TABLE public.user_settings FROM anon, authenticated;
  END IF;
END $$;
