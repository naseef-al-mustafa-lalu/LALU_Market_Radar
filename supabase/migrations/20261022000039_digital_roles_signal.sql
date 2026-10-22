-- NHS Jobs signal also covers digital transformation roles.
update public.signal_settings set
  label = 'Hiring for report / records / digital role',
  rule = 'A practice (or PCN / federation / group) advertises a role on NHS Jobs whose TITLE mentions medical secretary, records, summariser, workflow, document management, medico-legal, SAR / subject access, information governance, or a digital transformation role (digital lead / manager / programme, transformation lead, informatics, IT lead / manager / project, clinical systems). Adverts from employers not yet linked appear as unlinked signals. First load only signals adverts from the last 7 days.',
  why = 'A practice hiring for reports and records work is feeling the workload Lalu removes; one hiring for digital change is open to new tooling.'
where trigger_type = 'JOB_REPORT_ROLE';
