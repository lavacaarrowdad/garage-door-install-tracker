-- Garage Door Install Tracker: multi-door jobs
-- Run once in Supabase > SQL Editor.

alter table public.installations
  add column if not exists extra_doors jsonb not null default '[]'::jsonb;
