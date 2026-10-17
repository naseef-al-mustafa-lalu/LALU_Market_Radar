-- Documents two Supabase security-advisor findings that are intentional. Comments only; no behaviour change.

-- "Signed-in users can execute SECURITY DEFINER function": these four run with elevated rights on purpose.
-- Each one starts with `if not private.is_allowed() then raise exception`, and the anon role has no EXECUTE.
comment on function public.am_i_allowed() is 'SECURITY DEFINER by design: reports whether the caller is on the allowlist. Anon cannot run it.';
comment on function public.link_job_employer(text, text, uuid, text) is 'SECURITY DEFINER by design: allowlist-checked inside; anon cannot run it. Advisor warning 0029 is expected.';
comment on function public.load_devolved(text, text, jsonb, boolean) is 'SECURITY DEFINER by design: allowlist-checked inside; anon cannot run it. Advisor warning 0029 is expected.';
comment on function public.load_patient_counts(text, jsonb) is 'SECURITY DEFINER by design: allowlist-checked inside; anon cannot run it. Advisor warning 0029 is expected.';

-- "RLS enabled, no policy": deliberate. With no policy nobody using the dashboard can read these; only the pipeline's service key can.
comment on table public.allowed_users is 'RLS on with no policy by design: only the service key and private.is_allowed() read it.';
comment on table public.ingest_rejects is 'RLS on with no policy by design: pipeline-only (service key).';
comment on table public.kv_state is 'RLS on with no policy by design: pipeline-only (service key).';
