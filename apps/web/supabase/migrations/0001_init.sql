-- LemonLime control plane schema.
--
-- The web app's server code talks to the database with the service role and
-- checks workspace membership itself. Row-level security below is the second
-- line of defence: signed-in users reading the database directly (anon key +
-- session) only ever see rows from workspaces they belong to, and can only
-- write where noted.

create extension if not exists pgcrypto;

-- ─── Workspaces ──────────────────────────────────────────────────────────────

create table public.workspaces (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 200),
  personal    boolean not null default false,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  role         text not null default 'member' check (role in ('owner', 'member')),
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index workspace_members_user_idx on public.workspace_members (user_id);

-- Membership check used by every policy. SECURITY DEFINER so policies on
-- workspace_members itself do not recurse.
create or replace function public.is_workspace_member(ws uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = auth.uid()
  );
$$;

revoke all on function public.is_workspace_member(uuid) from public;
grant execute on function public.is_workspace_member(uuid) to authenticated, service_role;

-- ─── Threads ─────────────────────────────────────────────────────────────────

create table public.threads (
  id                text primary key check (id ~ '^[a-z0-9][a-z0-9-]{5,63}$'),
  workspace_id      uuid not null references public.workspaces (id) on delete cascade,
  created_by        uuid references auth.users (id) on delete set null,
  title             text not null default '' check (char_length(title) <= 200),
  agent             jsonb not null,
  repo              jsonb not null,
  branch            text not null,
  mode              text not null check (mode in ('local', 'cloud')),
  status            text not null check (status in ('provisioning', 'idle', 'running', 'paused', 'stopped', 'failed')),
  sandbox_size      text not null default 'small' check (sandbox_size in ('small', 'large')),
  sandbox_provider  text,
  sandbox_id        text,
  runner_url        text,
  latest_seq        integer not null default 0 check (latest_seq >= 0),
  -- When the agent last finished work (from heartbeats); null while it works.
  idle_since        timestamptz,
  -- Start of the current stretch of sandbox running time; null when not running.
  running_since     timestamptz,
  last_heartbeat_at timestamptz,
  -- First message, sent by the first client that connects to a fresh runner.
  initial_prompt    text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index threads_workspace_updated_idx on public.threads (workspace_id, updated_at desc);
create index threads_running_idx on public.threads (running_since) where running_since is not null;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger threads_touch_updated_at
before update on public.threads
for each row execute function public.touch_updated_at();

-- ─── Sandbox runs (neutral audit log of running time) ───────────────────────

create table public.sandbox_runs (
  id              bigint generated always as identity primary key,
  thread_id       text not null references public.threads (id) on delete cascade,
  workspace_id    uuid not null references public.workspaces (id) on delete cascade,
  sandbox_id      text not null,
  size            text not null check (size in ('small', 'large')),
  started_at      timestamptz not null,
  ended_at        timestamptz not null,
  runtime_seconds integer not null check (runtime_seconds >= 0),
  end_reason      text not null check (end_reason in ('idle', 'user', 'policy', 'error', 'replaced'))
);

create index sandbox_runs_thread_idx on public.sandbox_runs (thread_id, started_at desc);
create index sandbox_runs_workspace_idx on public.sandbox_runs (workspace_id, started_at desc);

-- ─── Personal access tokens (desktop app) ────────────────────────────────────

create table public.access_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 100),
  -- SHA-256 of the raw token, hex. The raw token is shown once and never stored.
  token_hash   text not null unique,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);

create index access_tokens_user_idx on public.access_tokens (user_id, created_at desc);

-- ─── Row-level security ──────────────────────────────────────────────────────

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.threads enable row level security;
alter table public.sandbox_runs enable row level security;
alter table public.access_tokens enable row level security;

create policy "members read their workspaces" on public.workspaces
  for select to authenticated using (public.is_workspace_member(id));

create policy "members read their workspace's members" on public.workspace_members
  for select to authenticated using (public.is_workspace_member(workspace_id));

-- Threads are created, paused and resumed through the control plane so that
-- every sandbox start goes through the usage policy. Members may only read.
create policy "members read their workspace's threads" on public.threads
  for select to authenticated using (public.is_workspace_member(workspace_id));

create policy "members read their workspace's sandbox runs" on public.sandbox_runs
  for select to authenticated using (public.is_workspace_member(workspace_id));

create policy "users read their own tokens" on public.access_tokens
  for select to authenticated using (user_id = auth.uid());

create policy "users delete their own tokens" on public.access_tokens
  for delete to authenticated using (user_id = auth.uid());

-- New tables are not exposed to the API roles by default, so grant explicitly.
grant usage on schema public to authenticated, service_role;
grant select on public.workspaces, public.workspace_members, public.threads, public.sandbox_runs to authenticated;
-- Token hashes stay server-side even for their owner.
grant select (id, user_id, name, created_at, last_used_at) on public.access_tokens to authenticated;
grant delete on public.access_tokens to authenticated;
grant all on public.workspaces, public.workspace_members, public.threads, public.sandbox_runs, public.access_tokens to service_role;
grant usage, select on all sequences in schema public to service_role;

-- ─── Personal workspace for every new user ───────────────────────────────────

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  ws_id uuid;
begin
  insert into public.workspaces (name, personal, created_by)
  values (coalesce(nullif(split_part(new.email, '@', 1), ''), 'Personal'), true, new.id)
  returning id into ws_id;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (ws_id, new.id, 'owner');

  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();
