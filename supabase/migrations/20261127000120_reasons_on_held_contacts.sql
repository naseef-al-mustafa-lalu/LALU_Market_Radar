-- A contact held back for its address or role (status 'excluded') now also carries the suppression reasons that apply to it (opt-out, bounce, not subscribed and so on),
-- so Atlas can say Suppressed ahead of Held back, and a segment that includes held contacts (for example shared mailboxes) can be checked the same way. The status itself is unchanged.
do $$
declare d text;
begin
  select pg_get_functiondef(p.oid) into d from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname = 'contact_status_calc';
  if d not like '%case when ex.excluded is null then rs.reasons else ''{}''::text[] end%' then
    if d like '%    rs.reasons,%' or d not like '%ex.excluded is null then rs.reasons%' then return; end if;
    raise exception 'unexpected function text';
  end if;
  d := replace(d, 'case when ex.excluded is null then rs.reasons else ''{}''::text[] end', 'rs.reasons');
  execute d;
end $$;

-- Settings shows how many contacts each rule holds back; keep that count to contacts that are not already held for their address or role, as before.
do $$
declare d text;
begin
  select pg_get_functiondef(p.oid) into d from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'contacts_settings_stats';
  if d like '%unnest(s.reasons) r where s.status <> ''excluded'' group by r%' then return; end if;
  d := replace(d, 'unnest(s.reasons) r group by r', 'unnest(s.reasons) r where s.status <> ''excluded'' group by r');
  if d not like '%where s.status <> ''excluded'' group by r%' then raise exception 'settings stats patch did not apply'; end if;
  execute d;
end $$;
