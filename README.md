# Lalu Market Radar

Daily pipeline: NHS public data + Oscar contacts -> Supabase -> email digest + login-protected dashboard (`index.html`).

## One-off setup
1. **Supabase** (project `qvdnpvouqecfsinsvvwf`, London): schema, triggers and RLS are already applied (`supabase/migrations`).
   - Dashboard -> Authentication -> Providers -> Email: **disable "Allow new users to sign up"**.
   - Authentication -> Users -> **Add user** (email + password) for each person. Then add their email (lower-case) to `allowed_users` via SQL editor: `insert into allowed_users values ('name@lalu.co.uk');`. Access needs both an account and an allowlist row.
2. **GitHub secrets** (Settings -> Secrets and variables -> Actions): `SUPABASE_URL` (https://qvdnpvouqecfsinsvvwf.supabase.co), `SUPABASE_SERVICE_ROLE_KEY` (Supabase -> Settings -> API; never put this in the repo or index.html), `OSCAR_API_URL`, `RESEND_API_KEY`.
   (`OSCAR_API_URL` is optional: without it practices load with no contact data; add it later and the next run fills contacts in.) **Variables**: `DASHBOARD_URL`, `DIGEST_TO` (comma-separated), optional `EMAIL_MODE` (DIGEST|DISABLED), `MIN_TIER_ALERT` (Tier 1|2|3).
3. **Resend**: verify the `lalu.co.uk` sending domain (SPF/DKIM), or set `DIGEST_FROM` to a verified sender.
4. **GitHub Pages**: Settings -> Pages -> deploy from `main` / root. (Private repos need a paid GitHub plan for Pages.)
5. Run the **Daily market radar** workflow manually once. The first successful run is a silent *baseline*: it loads everything but raises no triggers and sends no email. From the second run, changes generate signals.

## Monthly patient counts (two ways, both in the dashboard's "Patient counts" card)
NHS Digital (the only source of GP list sizes) blocks cloud datacentres, so GitHub's servers cannot fetch it.

**Option B: upload (works anywhere, nothing to install).** Open the NHS "Patients Registered at a GP Practice" page in your browser,
open the latest month, download `gp-reg-pat-prac-all.csv`, choose it in the dashboard card and press **Load**. The page reads the file
in your browser and stores the counts in Supabase (function `load_patient_counts`; allowlisted users only). Do this once a month.

**Option A: automatic button (needs an office PC with Python and the GitHub runner).** **Update from NHS now** starts the
*Monthly patient counts* workflow on a self-hosted runner on an ordinary office PC, which downloads the file itself.
Flow: dashboard -> Supabase function `trigger-patient-load` (checks you are signed in and on `allowed_users`) -> GitHub API -> runner.
One-off setup:
1. **GitHub token**: profile -> Settings -> Developer settings -> Personal access tokens -> *Fine-grained tokens*. Only this repo; under
   Repository permissions set **Actions** to *Read and write* (leave everything else *No access*).
2. **Save it in Supabase**: Edge Functions -> Secrets -> `GITHUB_TOKEN`.
3. **Runner**: repo -> Settings -> Actions -> Runners -> New self-hosted runner (Windows: follow GitHub's steps in `C:\actions-runner`,
   then `.\run.cmd`). Install Python 3.12 on that PC for the current user (Microsoft Store or python.org "Install Now"; no admin needed
   if installs are allowed) and make sure `python --version` works in PowerShell.
Until counts are loaded practices show 0 patients (Tier 3); no false growth alerts fire when counts arrive.

## Data sources (what feeds the central database)
| Source | Gives | Cadence |
|---|---|---|
| NHS ODS API + ODS export | Active GP practices, names, postcodes, closures, PCN and ICB | Daily, automatic |
| NHS Digital patient register | Patient counts (tiers, growth) | Monthly, upload in the dashboard (or runner) |
| Oscar Research file | Contacts (name, title, dept, email/phone, opt-outs) and practice details (address, federation, GP numbers, employees, spend, notes, Oscar IDs) | Daily, when `OSCAR_API_URL` is set |
| CQC public API | Registration status, overall rating, last inspection, registered-manager absence | Daily via the changes feed (first run backfills over one or more days) |
| CQC providers | Group name and size (e.g. Modality) for providers running 2+ practices | Daily |
| Practice websites | Cautious clinical-system hint | Daily, capped |

Signals: new practice, practice closed (merger), rapid growth, PCN move, new manager, plus CQC: registration ended, rating changed,
new inspection, registered manager absent, practice changed operator (likely takeover). CQC signals only fire after a first CQC value is stored, so the initial load is silent.
Requires the `CQC_API_KEY` secret (free key from the CQC API portal).

## Operating notes
- NHS patient numbers are **monthly**, so list-size/closure signals move monthly; Oscar contact changes are picked up daily.
- A failed run emails `DIGEST_TO` and is recorded in `ingest_runs`. Rejected rows (bad ODS codes etc.) go to `ingest_rejects`.
- Free-tier Supabase pauses after ~7 days of inactivity; the daily run keeps it awake. Scheduled GitHub workflows stop after 60 days without repo activity: re-enable from the Actions tab.
- Tests: `pip install -r requirements-dev.txt && python -m pytest`.

## Audit: changes from the original brief
| Brief | Problem | Fix |
|---|---|---|
| `alter pubsub.publications add_current_table` | Invalid SQL | `alter publication supabase_realtime add table` |
| Log triggers in a BEFORE INSERT trigger | FK violation (parent row not yet inserted); generated `sales_segment` is NULL in BEFORE | Cleaning stays BEFORE; logging is a separate AFTER trigger |
| First run | ~6,500 NEW_PRACTICE alerts + giant email | Baseline mode: triggers suppressed until one run has succeeded |
| `initcap()` on names | "St Mary'S", "Nhs" | Python title-casing with acronym handling |
| Mock NHS URL / invented columns | Would fail on day one | Practices + PCNs from the NHS ODS API; patient counts from the NHS GP registration file via a self-hosted runner (NHS blocks cloud IPs) |
| One manager per practice from Oscar | Oscar is one row per *contact*; opt-outs/Suppress ignored | `contacts` table, deterministic primary-contact choice, Suppress excluded, opt-out emails masked/exported blank |
| Per-row upsert, 6,500 HTTP calls | Slow, noisy writes | Diffed, batched upserts: only changed rows written |
| `"emis" in html` scraping | Matches "pr**emis**es" | Vendor-domain markers only, conflict -> Unknown, capped 400/day, rechecked every 90 days |
| Anon key + no RLS, contact data on public page | Personal data exposed | Email/password login, allowlist RLS, anon has no access, users may only edit `lead_status` |
| Dashboard loads default 1,000 rows | 85% of practices missing | Paged fetch; paged rendering |
| CSV export | Broken date/newlines, formula injection, ignores opt-outs | Rewritten; excludes Do-Not-Contact, blanks opted-out emails, neutralises `=`/`+`/`-`/`@` |
| `innerHTML` with raw data | XSS | All values escaped |
| Digest | Unescaped HTML, `.single()` crash, DNC ignored, filtered triggers re-queued forever | Escaped, tier + DNC filtering, filtered triggers marked handled, capped at 150 rows, only marked sent after Resend accepts |
| "Merger" = PCN change | Misleading | Closure of an active practice = MERGER_DETECTED; PCN moves are a separate PCN_CHANGE |
| Silent failures | Nobody knows pipeline is down | Run log, failure email, sanity guards (feed size, patient coverage, >50 closures) |

## Known limits
- Verified from GitHub runners: ODS API and ODS export respond; digital.nhs.uk and OpenPrescribing are blocked by Cloudflare.
- The GP registration file parser and the practice->PCN lookup (ODS `Rels`, role RO272) follow the published formats but have only been tested on fixtures. Check `ingest_runs.stats` after the first run (`ods_active`, `pcn_mapped`, `pcn_error`); PCN failures degrade gracefully.
- Oscar has no clinical-system field, so EMIS/SystmOne/Vision is a website-based hint only and mostly "Unknown".
