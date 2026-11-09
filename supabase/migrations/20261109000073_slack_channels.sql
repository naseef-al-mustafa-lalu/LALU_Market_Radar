-- The Slack channels Atlas's bot is actually a member of (refreshed by the daily jobs), for the per-audience alert channel.
create table if not exists public.slack_channels (id text primary key, name text not null, is_private boolean not null default false, synced_at timestamptz not null default now());
alter table public.slack_channels enable row level security;
create policy read_slack_channels on public.slack_channels for select to authenticated using (private.is_allowed());
alter table public.audiences add column if not exists slack_channel text;
