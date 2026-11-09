-- Per audience, default off: tell #lalu_atlas when a new practice drops into it (a new signal of its type).
alter table public.audiences add column if not exists slack_alert boolean not null default false;
