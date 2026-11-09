-- Oscar contacts the daily load used to drop (shared mailboxes, partial or unclear addresses) are now stored, flagged with why, so Atlas can review and use them later.
alter table public.contacts add column if not exists held_reason text;
create index if not exists contacts_held_idx on public.contacts (held_reason) where held_reason is not null;
