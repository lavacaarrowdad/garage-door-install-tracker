-- Garage Door Install Tracker - Supabase schema
-- Run this entire file once in Supabase > SQL Editor.

create table if not exists public.installations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  customer_name text,
  address_line1 text not null,
  city text not null,
  state text not null,
  postal_code text,
  latitude double precision,
  longitude double precision,
  manufacturer text,
  model_number text,
  door_size text,
  spring_size text,
  spring_count integer,
  door_type text,
  color text,
  lift_type text,
  install_date date not null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists installations_user_id_idx
  on public.installations(user_id);

create index if not exists installations_install_date_idx
  on public.installations(install_date desc);

alter table public.installations enable row level security;

drop policy if exists "Users read own installations" on public.installations;
create policy "Users read own installations"
  on public.installations
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users insert own installations" on public.installations;
create policy "Users insert own installations"
  on public.installations
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users update own installations" on public.installations;
create policy "Users update own installations"
  on public.installations
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users delete own installations" on public.installations;
create policy "Users delete own installations"
  on public.installations
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists installations_set_updated_at on public.installations;
create trigger installations_set_updated_at
before update on public.installations
for each row
execute function public.set_updated_at();
