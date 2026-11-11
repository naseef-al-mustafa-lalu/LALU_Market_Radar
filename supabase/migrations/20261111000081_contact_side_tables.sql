-- APPLIED 2026-11-11. contact_sides_check(): 55,973 contacts, 0 missing, 0 differing.
-- Step 2a of docs/contacts-rethink.md: side tables per writer, mirrored from contacts by trigger while writers are moved one at a time; contacts_full reads them.

create table if not exists public.contact_hubspot (
  contact_urn bigint primary key references public.contacts(contact_urn) on delete cascade,
  hubspot_status text,
  hubspot_imported_at timestamptz,
  hubspot_contact_id text,
  hs_lifecycle text,
  hs_in_sequence boolean,
  hs_bounced boolean,
  hs_bounce_reason text,
  hs_last_sent timestamptz,
  hs_mkt_optout boolean,
  hs_optout_all boolean,
  hs_owner text,
  hs_neverbounce text,
  hs_state_at timestamptz,
  hs_dq_reason text,
  hs_dq_note text,
  hs_dq_at timestamptz,
  hs_reengage_date date,
  hs_seq_id text,
  hs_seq_enrolled_at timestamptz,
  hs_seq_ended_at timestamptz,
  hs_seq_exit text,
  hs_lost_reason text,
  hs_lost_at timestamptz,
  hs_lost_deal text,
  hs_lost_kind text);
alter table public.contact_hubspot enable row level security;
create policy read_contact_hubspot on public.contact_hubspot for select to authenticated using ((select private.is_allowed()));

create table if not exists public.contact_nb (
  contact_urn bigint primary key references public.contacts(contact_urn) on delete cascade,
  nb_state text,
  nb_result text,
  nb_checked_at timestamptz,
  nb_approved_by text,
  nb_approved_at timestamptz);
alter table public.contact_nb enable row level security;
create policy read_contact_nb on public.contact_nb for select to authenticated using ((select private.is_allowed()));

create table if not exists public.contact_review (
  contact_urn bigint primary key references public.contacts(contact_urn) on delete cascade,
  reviewed_by text,
  reviewed_at timestamptz);
alter table public.contact_review enable row level security;
create policy read_contact_review on public.contact_review for select to authenticated using ((select private.is_allowed()));

insert into public.contact_hubspot (contact_urn,hubspot_status,hubspot_imported_at,hubspot_contact_id,hs_lifecycle,hs_in_sequence,hs_bounced,hs_bounce_reason,hs_last_sent,hs_mkt_optout,hs_optout_all,hs_owner,hs_neverbounce,hs_state_at,hs_dq_reason,hs_dq_note,hs_dq_at,hs_reengage_date,hs_seq_id,hs_seq_enrolled_at,hs_seq_ended_at,hs_seq_exit,hs_lost_reason,hs_lost_at,hs_lost_deal,hs_lost_kind) select contact_urn,hubspot_status,hubspot_imported_at,hubspot_contact_id,hs_lifecycle,hs_in_sequence,hs_bounced,hs_bounce_reason,hs_last_sent,hs_mkt_optout,hs_optout_all,hs_owner,hs_neverbounce,hs_state_at,hs_dq_reason,hs_dq_note,hs_dq_at,hs_reengage_date,hs_seq_id,hs_seq_enrolled_at,hs_seq_ended_at,hs_seq_exit,hs_lost_reason,hs_lost_at,hs_lost_deal,hs_lost_kind from public.contacts on conflict (contact_urn) do nothing;
insert into public.contact_nb (contact_urn,nb_state,nb_result,nb_checked_at,nb_approved_by,nb_approved_at) select contact_urn,nb_state,nb_result,nb_checked_at,nb_approved_by,nb_approved_at from public.contacts on conflict (contact_urn) do nothing;
insert into public.contact_review (contact_urn,reviewed_by,reviewed_at) select contact_urn,reviewed_by,reviewed_at from public.contacts on conflict (contact_urn) do nothing;

create or replace function private.mirror_contact_sides() returns trigger language plpgsql security definer set search_path = '' as $f$
begin
  insert into public.contact_hubspot (contact_urn,hubspot_status,hubspot_imported_at,hubspot_contact_id,hs_lifecycle,hs_in_sequence,hs_bounced,hs_bounce_reason,hs_last_sent,hs_mkt_optout,hs_optout_all,hs_owner,hs_neverbounce,hs_state_at,hs_dq_reason,hs_dq_note,hs_dq_at,hs_reengage_date,hs_seq_id,hs_seq_enrolled_at,hs_seq_ended_at,hs_seq_exit,hs_lost_reason,hs_lost_at,hs_lost_deal,hs_lost_kind) values (new.contact_urn,new.hubspot_status,new.hubspot_imported_at,new.hubspot_contact_id,new.hs_lifecycle,new.hs_in_sequence,new.hs_bounced,new.hs_bounce_reason,new.hs_last_sent,new.hs_mkt_optout,new.hs_optout_all,new.hs_owner,new.hs_neverbounce,new.hs_state_at,new.hs_dq_reason,new.hs_dq_note,new.hs_dq_at,new.hs_reengage_date,new.hs_seq_id,new.hs_seq_enrolled_at,new.hs_seq_ended_at,new.hs_seq_exit,new.hs_lost_reason,new.hs_lost_at,new.hs_lost_deal,new.hs_lost_kind)
    on conflict (contact_urn) do update set hubspot_status=excluded.hubspot_status, hubspot_imported_at=excluded.hubspot_imported_at, hubspot_contact_id=excluded.hubspot_contact_id, hs_lifecycle=excluded.hs_lifecycle, hs_in_sequence=excluded.hs_in_sequence, hs_bounced=excluded.hs_bounced, hs_bounce_reason=excluded.hs_bounce_reason, hs_last_sent=excluded.hs_last_sent, hs_mkt_optout=excluded.hs_mkt_optout, hs_optout_all=excluded.hs_optout_all, hs_owner=excluded.hs_owner, hs_neverbounce=excluded.hs_neverbounce, hs_state_at=excluded.hs_state_at, hs_dq_reason=excluded.hs_dq_reason, hs_dq_note=excluded.hs_dq_note, hs_dq_at=excluded.hs_dq_at, hs_reengage_date=excluded.hs_reengage_date, hs_seq_id=excluded.hs_seq_id, hs_seq_enrolled_at=excluded.hs_seq_enrolled_at, hs_seq_ended_at=excluded.hs_seq_ended_at, hs_seq_exit=excluded.hs_seq_exit, hs_lost_reason=excluded.hs_lost_reason, hs_lost_at=excluded.hs_lost_at, hs_lost_deal=excluded.hs_lost_deal, hs_lost_kind=excluded.hs_lost_kind;
  insert into public.contact_nb (contact_urn,nb_state,nb_result,nb_checked_at,nb_approved_by,nb_approved_at) values (new.contact_urn,new.nb_state,new.nb_result,new.nb_checked_at,new.nb_approved_by,new.nb_approved_at)
    on conflict (contact_urn) do update set nb_state=excluded.nb_state, nb_result=excluded.nb_result, nb_checked_at=excluded.nb_checked_at, nb_approved_by=excluded.nb_approved_by, nb_approved_at=excluded.nb_approved_at;
  insert into public.contact_review (contact_urn,reviewed_by,reviewed_at) values (new.contact_urn,new.reviewed_by,new.reviewed_at)
    on conflict (contact_urn) do update set reviewed_by=excluded.reviewed_by, reviewed_at=excluded.reviewed_at;
  return null;
end $f$;
drop trigger if exists contacts_mirror_sides on public.contacts;
create trigger contacts_mirror_sides after insert or update of hubspot_status,hubspot_imported_at,hubspot_contact_id,hs_lifecycle,hs_in_sequence,hs_bounced,hs_bounce_reason,hs_last_sent,hs_mkt_optout,hs_optout_all,hs_owner,hs_neverbounce,hs_state_at,hs_dq_reason,hs_dq_note,hs_dq_at,hs_reengage_date,hs_seq_id,hs_seq_enrolled_at,hs_seq_ended_at,hs_seq_exit,hs_lost_reason,hs_lost_at,hs_lost_deal,hs_lost_kind,nb_state,nb_result,nb_checked_at,nb_approved_by,nb_approved_at,reviewed_by,reviewed_at on public.contacts for each row execute function private.mirror_contact_sides();

create or replace view public.contacts_full with (security_invoker = true) as select c.contact_urn, c.ods_code, c.full_name, c.job_title, c.seniority, c.email, c.phone, c.email_opt_out, c.is_primary, c.updated_at, c.org_urn, c.title, c.first_name, c.last_name, c.quals, c.dept, c.categories, c.data_types, c.main_site, c.source, c.email_quality, c.role_tier, c.held_reason, h.hubspot_status, h.hubspot_imported_at, h.hubspot_contact_id, h.hs_lifecycle, h.hs_in_sequence, h.hs_bounced, h.hs_bounce_reason, h.hs_last_sent, h.hs_mkt_optout, h.hs_optout_all, h.hs_owner, h.hs_neverbounce, h.hs_state_at, h.hs_dq_reason, h.hs_dq_note, h.hs_dq_at, h.hs_reengage_date, h.hs_seq_id, h.hs_seq_enrolled_at, h.hs_seq_ended_at, h.hs_seq_exit, h.hs_lost_reason, h.hs_lost_at, h.hs_lost_deal, h.hs_lost_kind, n.nb_state, n.nb_result, n.nb_checked_at, n.nb_approved_by, n.nb_approved_at, r.reviewed_by, r.reviewed_at
 from public.contacts c left join public.contact_hubspot h using (contact_urn) left join public.contact_nb n using (contact_urn) left join public.contact_review r using (contact_urn);

create or replace function public.contact_sides_check() returns jsonb language sql stable security definer set search_path = '' as $f$
  select jsonb_build_object('contacts',(select count(*) from public.contacts),
    'missing_hubspot',(select count(*) from public.contacts c where not exists (select 1 from public.contact_hubspot x where x.contact_urn=c.contact_urn)),
    'missing_nb',(select count(*) from public.contacts c where not exists (select 1 from public.contact_nb x where x.contact_urn=c.contact_urn)),
    'missing_review',(select count(*) from public.contacts c where not exists (select 1 from public.contact_review x where x.contact_urn=c.contact_urn)),
    'differs',(select count(*) from public.contacts c join public.contact_nb n using (contact_urn) join public.contact_review r using (contact_urn) join public.contact_hubspot h using (contact_urn)
       where (c.nb_state,c.nb_result,c.reviewed_by,c.hubspot_status,c.hs_lifecycle,c.hs_in_sequence) is distinct from (n.nb_state,n.nb_result,r.reviewed_by,h.hubspot_status,h.hs_lifecycle,h.hs_in_sequence)));
$f$;
revoke all on function public.contact_sides_check() from public, anon;
grant execute on function public.contact_sides_check() to authenticated, service_role;
