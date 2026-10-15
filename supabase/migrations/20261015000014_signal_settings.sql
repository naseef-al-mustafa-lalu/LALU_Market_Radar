-- Signal catalogue and on/off switches. Disabled types are not recorded (existing rows stay visible).
create table public.signal_settings (
  trigger_type text primary key,
  label text not null,
  source text not null,
  rule text not null,
  why text not null,
  sort_order int not null default 0,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);
-- seed rows: see the signal_settings migration applied in Supabase (ten signal types: NEW_PRACTICE ... CQC_PROVIDER_CHANGE)
alter table public.signal_settings enable row level security;
create policy read_signal_settings on public.signal_settings for select to authenticated using (private.is_allowed());
create policy update_signal_settings on public.signal_settings for update to authenticated using (private.is_allowed()) with check (private.is_allowed());
grant select on public.signal_settings to authenticated;
grant update (enabled, updated_at) on public.signal_settings to authenticated;
create function public.skip_disabled_signal() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.signal_settings where trigger_type = new.trigger_type and not enabled) then return null; end if;
  return new;
end $$;
revoke all on function public.skip_disabled_signal() from public, anon, authenticated;
create trigger tr_skip_disabled before insert on public.sales_triggers for each row execute function public.skip_disabled_signal();
