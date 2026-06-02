
-- Profiles
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  business_name text,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
create policy "Users can view own profile" on public.profiles for select using (auth.uid() = id);
create policy "Users can insert own profile" on public.profiles for insert with check (auth.uid() = id);
create policy "Users can update own profile" on public.profiles for update using (auth.uid() = id);

-- Clients
create table public.clients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  email text,
  phone text,
  tags text[] not null default '{}',
  notes text,
  last_contacted date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.clients enable row level security;
create policy "Users can view own clients" on public.clients for select using (auth.uid() = user_id);
create policy "Users can insert own clients" on public.clients for insert with check (auth.uid() = user_id);
create policy "Users can update own clients" on public.clients for update using (auth.uid() = user_id);
create policy "Users can delete own clients" on public.clients for delete using (auth.uid() = user_id);
create index clients_user_id_idx on public.clients(user_id);

-- Follow ups
create table public.follow_ups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id uuid references public.clients(id) on delete cascade,
  reason text not null,
  due_date date,
  done boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.follow_ups enable row level security;
create policy "Users can view own follow_ups" on public.follow_ups for select using (auth.uid() = user_id);
create policy "Users can insert own follow_ups" on public.follow_ups for insert with check (auth.uid() = user_id);
create policy "Users can update own follow_ups" on public.follow_ups for update using (auth.uid() = user_id);
create policy "Users can delete own follow_ups" on public.follow_ups for delete using (auth.uid() = user_id);
create index follow_ups_user_id_idx on public.follow_ups(user_id);

-- Outreach drafts
create table public.outreach_drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id uuid references public.clients(id) on delete cascade,
  subject text not null,
  tone text,
  body text,
  sent boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.outreach_drafts enable row level security;
create policy "Users can view own outreach_drafts" on public.outreach_drafts for select using (auth.uid() = user_id);
create policy "Users can insert own outreach_drafts" on public.outreach_drafts for insert with check (auth.uid() = user_id);
create policy "Users can update own outreach_drafts" on public.outreach_drafts for update using (auth.uid() = user_id);
create policy "Users can delete own outreach_drafts" on public.outreach_drafts for delete using (auth.uid() = user_id);
create index outreach_drafts_user_id_idx on public.outreach_drafts(user_id);

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, email)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', ''), new.email);
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();
