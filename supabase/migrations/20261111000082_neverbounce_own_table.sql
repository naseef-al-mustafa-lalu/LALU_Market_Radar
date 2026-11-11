-- APPLIED 2026-11-11.
-- Step 2b-1 of docs/contacts-rethink.md: the NeverBounce state is written only to contact_nb. The mirror from contacts stops carrying it; the approval and review functions write contact_nb.
create or replace function private.mirror_contact_sides() returns trigger language plpgsql security definer set search_path = '' as $f$
begin
  insert into public.contact_hubspot (contact_urn,hubspot_status,hubspot_imported_at,hubspot_contact_id,hs_lifecycle,hs_in_sequence,hs_bounced,hs_bounce_reason,hs_last_sent,hs_mkt_optout,hs_optout_all,hs_owner,hs_neverbounce,hs_state_at,hs_dq_reason,hs_dq_note,hs_dq_at,hs_reengage_date,hs_seq_id,hs_seq_enrolled_at,hs_seq_ended_at,hs_seq_exit,hs_lost_reason,hs_lost_at,hs_lost_deal,hs_lost_kind) values (new.contact_urn,new.hubspot_status,new.hubspot_imported_at,new.hubspot_contact_id,new.hs_lifecycle,new.hs_in_sequence,new.hs_bounced,new.hs_bounce_reason,new.hs_last_sent,new.hs_mkt_optout,new.hs_optout_all,new.hs_owner,new.hs_neverbounce,new.hs_state_at,new.hs_dq_reason,new.hs_dq_note,new.hs_dq_at,new.hs_reengage_date,new.hs_seq_id,new.hs_seq_enrolled_at,new.hs_seq_ended_at,new.hs_seq_exit,new.hs_lost_reason,new.hs_lost_at,new.hs_lost_deal,new.hs_lost_kind)
    on conflict (contact_urn) do update set hubspot_status=excluded.hubspot_status, hubspot_imported_at=excluded.hubspot_imported_at, hubspot_contact_id=excluded.hubspot_contact_id, hs_lifecycle=excluded.hs_lifecycle, hs_in_sequence=excluded.hs_in_sequence, hs_bounced=excluded.hs_bounced, hs_bounce_reason=excluded.hs_bounce_reason, hs_last_sent=excluded.hs_last_sent, hs_mkt_optout=excluded.hs_mkt_optout, hs_optout_all=excluded.hs_optout_all, hs_owner=excluded.hs_owner, hs_neverbounce=excluded.hs_neverbounce, hs_state_at=excluded.hs_state_at, hs_dq_reason=excluded.hs_dq_reason, hs_dq_note=excluded.hs_dq_note, hs_dq_at=excluded.hs_dq_at, hs_reengage_date=excluded.hs_reengage_date, hs_seq_id=excluded.hs_seq_id, hs_seq_enrolled_at=excluded.hs_seq_enrolled_at, hs_seq_ended_at=excluded.hs_seq_ended_at, hs_seq_exit=excluded.hs_seq_exit, hs_lost_reason=excluded.hs_lost_reason, hs_lost_at=excluded.hs_lost_at, hs_lost_deal=excluded.hs_lost_deal, hs_lost_kind=excluded.hs_lost_kind;
  insert into public.contact_review (contact_urn,reviewed_by,reviewed_at) values (new.contact_urn,new.reviewed_by,new.reviewed_at)
    on conflict (contact_urn) do update set reviewed_by=excluded.reviewed_by, reviewed_at=excluded.reviewed_at;
  return null;
end $f$;
drop trigger if exists contacts_mirror_sides on public.contacts;
create trigger contacts_mirror_sides after insert or update of hubspot_status,hubspot_imported_at,hubspot_contact_id,hs_lifecycle,hs_in_sequence,hs_bounced,hs_bounce_reason,hs_last_sent,hs_mkt_optout,hs_optout_all,hs_owner,hs_neverbounce,hs_state_at,hs_dq_reason,hs_dq_note,hs_dq_at,hs_reengage_date,hs_seq_id,hs_seq_enrolled_at,hs_seq_ended_at,hs_seq_exit,hs_lost_reason,hs_lost_at,hs_lost_deal,hs_lost_kind,reviewed_by,reviewed_at on public.contacts for each row execute function private.mirror_contact_sides();

create or replace function public.set_neverbounce_approval(p_urns bigint[], p_approve boolean) returns integer language plpgsql security definer set search_path = public as $$
declare n integer; who text := coalesce((select email from auth.users where id = auth.uid()), 'unknown');
begin
  if not private.is_allowed() then raise exception 'not allowed'; end if;
  update public.contact_nb set nb_state = case when p_approve then 'approved' else 'pending' end, nb_approved_by = case when p_approve then who else null end, nb_approved_at = case when p_approve then now() else null end
    where contact_urn = any(p_urns) and nb_state in ('pending', 'approved'); get diagnostics n = row_count; return n;
end $$;

create or replace function public.review_contact(p_urns bigint[], p_action text) returns integer language plpgsql security definer set search_path = public as $$
declare n integer; who text := coalesce((select email from auth.users where id = auth.uid()), 'unknown');
begin
  if not private.is_allowed() then raise exception 'not allowed'; end if;
  if p_action = 'accept' then
    update public.contacts set email_quality = 'direct', held_reason = null, reviewed_by = who, reviewed_at = now() where contact_urn = any(p_urns);
    get diagnostics n = row_count;
    insert into public.contact_nb (contact_urn, nb_state)
      select c.contact_urn, 'pending' from public.contacts c where c.contact_urn = any(p_urns) and c.source = 'oscar' and c.hubspot_contact_id is null and coalesce(c.email_opt_out, false) = false and c.role_tier in ('A', 'B')
      on conflict (contact_urn) do update set nb_state = 'pending' where public.contact_nb.nb_state is null;
  elsif p_action = 'reject' then
    update public.contacts set held_reason = 'rejected in review', reviewed_by = who, reviewed_at = now() where contact_urn = any(p_urns);
    get diagnostics n = row_count;
    update public.contact_nb set nb_state = 'skipped' where contact_urn = any(p_urns) and nb_state in ('pending', 'approved');
  else raise exception 'unknown action'; end if;
  return n;
end $$;
