-- A waterfall that is not ready when the job has to move on keeps its Apollo request id here; every later run polls it (free) and finishes the contact when the email arrives.
alter table public.apollo_queue add column if not exists waterfall_request_id text;
alter table public.apollo_queue add column if not exists waterfall_requested_at timestamptz;
