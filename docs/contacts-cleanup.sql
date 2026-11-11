-- Final cleanup of the contacts rethink (docs/contacts-rethink.md). Run in the Supabase SQL editor AFTER tomorrow's Oscar load, HubSpot sync and a Contacts page check have all worked:
-- it removes the old copies of data that now live in contact_hubspot, contact_nb, contact_review and contact_status, and the old HubSpot-export import. Nothing here is needed by the live code.
-- The staged HubSpot-export candidates are copied to private.contact_candidates_backup first. One transaction: it either all applies or none of it.
begin;

create table if not exists private.contact_candidates_backup as select * from public.contact_candidates;

-- the copy from contacts into the side tables
drop trigger if exists contacts_mirror_sides on public.contacts;
drop function if exists private.mirror_contact_sides();

-- the consistency check no longer compares against the old columns
create or replace function public.contact_sides_check() returns jsonb language sql stable security definer set search_path = '' as $f$
  select jsonb_build_object('contacts', (select count(*) from public.contacts), 'with_hubspot_state', (select count(*) from public.contact_hubspot),
    'with_nb', (select count(*) from public.contact_nb), 'with_review', (select count(*) from public.contact_review), 'with_status', (select count(*) from public.contact_status),
    'without_status', (select count(*) from public.contacts c where not exists (select 1 from public.contact_status s where s.contact_urn = c.contact_urn)));
$f$;

-- superseded functions and the old HubSpot-export import
drop function if exists public.contacts_list(jsonb, integer, integer);
drop function if exists private.contact_status_rows(jsonb);
drop function if exists public.load_contact_candidates(jsonb, boolean);
drop function if exists public.review_contact_candidates(text[], text);
drop table if exists public.contact_candidates;

-- unused columns
alter table public.contact_hubspot drop column if exists hubspot_status, drop column if exists hubspot_imported_at, drop column if exists hubspot_contact_id;
alter table public.contacts
  drop column if exists nb_state, drop column if exists nb_result, drop column if exists nb_checked_at, drop column if exists nb_approved_by, drop column if exists nb_approved_at,
  drop column if exists reviewed_by, drop column if exists reviewed_at,
  drop column if exists hs_lifecycle, drop column if exists hs_in_sequence, drop column if exists hs_bounced, drop column if exists hs_bounce_reason, drop column if exists hs_last_sent,
  drop column if exists hs_mkt_optout, drop column if exists hs_optout_all, drop column if exists hs_owner, drop column if exists hs_neverbounce, drop column if exists hs_state_at,
  drop column if exists hs_dq_reason, drop column if exists hs_dq_note, drop column if exists hs_dq_at, drop column if exists hs_reengage_date,
  drop column if exists hs_seq_id, drop column if exists hs_seq_enrolled_at, drop column if exists hs_seq_ended_at, drop column if exists hs_seq_exit,
  drop column if exists hs_lost_reason, drop column if exists hs_lost_at, drop column if exists hs_lost_deal, drop column if exists hs_lost_kind;

commit;

-- afterwards: select public.contact_sides_check(); select public.contact_integrity();   (without_status and contacts_with_email_unlinked should both be 0)
