-- The functions behind the contact import (migration 52 holds the tables). load_contact_candidates stages and promotes the HubSpot export; review_contact_candidates records review decisions.
-- One HubSpot export row per element: {id, company_id, first, last, email, phone, title, role, quality, tier, status, reason, opted_out, bounced, hash}.
-- New contacts take the suggested status; known ones keep their status and have changed details applied (a changed email goes back to review; an opt-out suppresses at once).
create or replace function public.load_contact_candidates(p_rows jsonb, p_first boolean default false)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare n_new int := 0; n_chg int := 0; n_sup int := 0; n_prom int := 0; n_gen int := 0; me text := coalesce(auth.jwt() ->> 'email', 'unknown');
begin
  if not private.is_allowed() then raise exception 'not authorised'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 1000 then raise exception 'send at most 1000 rows per call'; end if;
  if p_first then update public.contact_candidates set in_latest = false; end if;   -- the first chunk of an upload: everything is "missing" until it shows up again

  create temp table if not exists _cc (id text primary key, company_id text, ods varchar(6), first text, last text, email text, phone text, title text, role text, quality text, tier text, status text, reason text, opted_out boolean, bounced boolean, hash text) on commit drop;
  truncate _cc;
  insert into _cc
  select distinct on (r ->> 'id') r ->> 'id', nullif(r ->> 'company_id', ''), g.ods_code, nullif(btrim(r ->> 'first'), ''), nullif(btrim(r ->> 'last'), ''), nullif(lower(btrim(r ->> 'email')), ''),
         nullif(btrim(r ->> 'phone'), ''), nullif(btrim(r ->> 'title'), ''), nullif(btrim(r ->> 'role'), ''), nullif(r ->> 'quality', ''), nullif(r ->> 'tier', ''), r ->> 'status', nullif(r ->> 'reason', ''),
         coalesce((r ->> 'opted_out')::boolean, false), coalesce((r ->> 'bounced')::boolean, false), r ->> 'hash'
    from jsonb_array_elements(p_rows) r left join public.gp_practices g on g.hubspot_company_id = nullif(r ->> 'company_id', '')
   where (r ->> 'id') ~ '^[0-9]{1,20}$' and (r ->> 'status') in ('approved', 'review', 'generic', 'rejected', 'suppressed')
   order by r ->> 'id', g.ods_code;
  update _cc set status = 'rejected', reason = 'no matching practice in Atlas' where ods is null and status <> 'suppressed';

  -- known contacts: refresh details, flag an email change, apply an opt-out
  with chg as (
    select c.hubspot_contact_id, x.*, (c.email is distinct from x.email) as email_changed
      from public.contact_candidates c join _cc x on x.id = c.hubspot_contact_id where c.row_hash is distinct from x.hash)
  update public.contact_candidates c set first_name = chg.first, last_name = chg.last, job_title = chg.title, job_role = chg.role, phone = chg.phone, ods_code = coalesce(chg.ods, c.ods_code), hubspot_company_id = chg.company_id,
         opted_out = chg.opted_out, bounced = chg.bounced, row_hash = chg.hash, changed_at = now(),
         change_note = case when chg.email_changed then 'Email changed in HubSpot from ' || coalesce(c.email, 'blank') || '; needs a fresh quality check' else 'Details updated from the HubSpot export' end,
         email = case when chg.email_changed then chg.email else c.email end,
         status = case when chg.opted_out or chg.bounced then 'suppressed' when chg.email_changed and c.status in ('approved', 'generic') then 'review' else c.status end
    from chg where c.hubspot_contact_id = chg.hubspot_contact_id;
  get diagnostics n_chg = row_count;
  update public.contact_candidates c set in_latest = true, last_seen = now() from _cc x where c.hubspot_contact_id = x.id;

  -- new contacts
  insert into public.contact_candidates (hubspot_contact_id, email, ods_code, hubspot_company_id, first_name, last_name, job_title, job_role, phone, email_quality, role_tier, status, reason, opted_out, bounced, row_hash)
  select id, email, ods, company_id, first, last, title, role, quality, tier, status, reason, opted_out, bounced, hash from _cc x
   where not exists (select 1 from public.contact_candidates c where c.hubspot_contact_id = x.id);
  get diagnostics n_new = row_count;

  -- promote approved candidates into contacts (never overwriting an Oscar contact with the same email at the practice); keep contacts in step for ones already promoted
  perform set_config('lalu.bulk_load', '1', true);
  update public.contacts k set full_name = nullif(btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''), first_name = c.first_name, last_name = c.last_name,
         job_title = coalesce(c.job_title, c.job_role), phone = coalesce(c.phone, k.phone), email_opt_out = k.email_opt_out or c.opted_out or c.bounced, updated_at = now()
    from public.contact_candidates c join _cc x on x.id = c.hubspot_contact_id
   where k.contact_urn = c.contact_urn and k.source = 'hubspot' and c.status in ('approved', 'suppressed');
  update public.contacts k set email_opt_out = true from public.contact_candidates c join _cc x on x.id = c.hubspot_contact_id where k.contact_urn = c.contact_urn and c.status = 'suppressed';
  get diagnostics n_sup = row_count;
  with ins as (
    insert into public.contacts (ods_code, full_name, first_name, last_name, job_title, email, phone, email_opt_out, is_primary, source, email_quality, role_tier, hubspot_status, hubspot_contact_id, hubspot_imported_at)
    select c.ods_code, nullif(btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''), c.first_name, c.last_name, coalesce(c.job_title, c.job_role), c.email, c.phone, false, false, 'hubspot', c.email_quality, c.role_tier, 'Imported', c.hubspot_contact_id, now()
      from public.contact_candidates c join _cc x on x.id = c.hubspot_contact_id
     where c.status = 'approved' and c.contact_urn is null and c.email is not null and c.ods_code is not null
       and not exists (select 1 from public.contacts o where o.ods_code = c.ods_code and lower(o.email) = c.email)
    returning contact_urn, hubspot_contact_id)
  update public.contact_candidates c set contact_urn = ins.contact_urn from ins where c.hubspot_contact_id = ins.hubspot_contact_id;
  get diagnostics n_prom = row_count;

  -- one generic address per practice, never when the practice already has one (from Oscar or an earlier load), and never beside an Oscar shared-mailbox contact
  with pick as (
    select distinct on (c.ods_code) c.ods_code, c.email, c.hubspot_contact_id
      from public.contact_candidates c join _cc x on x.id = c.hubspot_contact_id
     where c.status = 'generic' and c.email is not null and c.ods_code is not null
       and not exists (select 1 from public.practice_generic_emails g where g.ods_code = c.ods_code)
       and not exists (select 1 from public.contacts o where o.ods_code = c.ods_code and o.source = 'oscar' and o.email_quality = 'shared')
     order by c.ods_code, (c.role_tier = 'A') desc, length(split_part(c.email, '@', 1)), c.email)
  insert into public.practice_generic_emails (ods_code, email, source, hubspot_contact_id) select ods_code, email, 'hubspot', hubspot_contact_id from pick on conflict (ods_code) do nothing;
  get diagnostics n_gen = row_count;
  return jsonb_build_object('new', n_new, 'changed', n_chg, 'suppressed', n_sup, 'promoted', n_prom, 'generic', n_gen, 'by', me);
end $function$;
revoke all on function public.load_contact_candidates(jsonb, boolean) from public, anon;
grant execute on function public.load_contact_candidates(jsonb, boolean) to authenticated;

-- Review decisions from the dashboard: approve (promote into contacts) or reject, in bulk.
create or replace function public.review_contact_candidates(p_ids text[], p_decision text)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare n int := 0; me text := coalesce(auth.jwt() ->> 'email', 'unknown');
begin
  if not private.is_allowed() then raise exception 'not authorised'; end if;
  if p_decision not in ('approved', 'rejected') then raise exception 'decision must be approved or rejected'; end if;
  if coalesce(array_length(p_ids, 1), 0) > 1000 then raise exception 'at most 1000 at a time'; end if;
  perform set_config('lalu.bulk_load', '1', true);
  update public.contact_candidates set status = p_decision, reviewed_by = me, reviewed_at = now(), change_note = null where hubspot_contact_id = any(p_ids) and status in ('review', 'rejected', 'generic') and not (opted_out or bounced);
  get diagnostics n = row_count;
  if p_decision = 'approved' then
    with ins as (
      insert into public.contacts (ods_code, full_name, first_name, last_name, job_title, email, phone, email_opt_out, is_primary, source, email_quality, role_tier, hubspot_status, hubspot_contact_id, hubspot_imported_at)
      select c.ods_code, nullif(btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''), c.first_name, c.last_name, coalesce(c.job_title, c.job_role), c.email, c.phone, false, false, 'hubspot', c.email_quality, c.role_tier, 'Imported', c.hubspot_contact_id, now()
        from public.contact_candidates c where c.hubspot_contact_id = any(p_ids) and c.status = 'approved' and c.contact_urn is null and c.email is not null and c.ods_code is not null
         and not exists (select 1 from public.contacts o where o.ods_code = c.ods_code and lower(o.email) = c.email)
      returning contact_urn, hubspot_contact_id)
    update public.contact_candidates c set contact_urn = ins.contact_urn from ins where c.hubspot_contact_id = ins.hubspot_contact_id;
  else
    delete from public.contacts k using public.contact_candidates c where k.contact_urn = c.contact_urn and c.hubspot_contact_id = any(p_ids) and k.source = 'hubspot';
  end if;
  return jsonb_build_object('decided', n, 'by', me);
end $function$;
revoke all on function public.review_contact_candidates(text[], text) from public, anon;
grant execute on function public.review_contact_candidates(text[], text) to authenticated;
