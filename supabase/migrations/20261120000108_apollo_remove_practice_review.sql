-- The "Apollo has them at a different practice" review list is gone (a same-name person elsewhere is almost always a namesake). Drop its two functions and close any rows still in it.
update public.apollo_queue set state = 'not_found', note = coalesce(note, 'same-name person at another organisation'), checked_at = now() where state = 'review' and review_reason = 'different_practice';
drop function if exists public.apollo_move_to_practice(bigint, text);
drop function if exists public.apollo_dismiss_review(bigint[]);
