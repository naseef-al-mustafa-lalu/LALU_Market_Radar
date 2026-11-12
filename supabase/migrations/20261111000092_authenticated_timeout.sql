-- APPLIED 2026-11-12 (via execute_sql). Signed-in users' requests were cancelled at 8 s when the database was busy (the page load failed with "canceling statement due to statement timeout"); raised to 30 s. Anonymous requests keep their 3 s limit.
alter role authenticated set statement_timeout = '30s';
notify pgrst, 'reload config';
