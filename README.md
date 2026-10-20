# Lalu Market Radar

Daily pipeline: NHS public data + Oscar contacts -> Supabase -> Slack posts (#lalu_market_radar) + login-protected dashboard (`index.html`).

## One-off setup
1. **Supabase** (project `qvdnpvouqecfsinsvvwf`, London): schema, triggers and RLS are already applied (`supabase/migrations`).
   - Dashboard -> Authentication -> Providers -> Email: **disable "Allow new users to sign up"**.
   - Authentication -> Users -> **Add user** (email + password) for each person. Then add their email (lower-case) to `allowed_users` via SQL editor: `insert into allowed_users values ('name@lalu.co.uk');`. Access needs both an account and an allowlist row.
2. **GitHub secrets** (Settings -> Secrets and variables -> Actions): `SUPABASE_URL` (https://qvdnpvouqecfsinsvvwf.supabase.co), `SUPABASE_SERVICE_ROLE_KEY` (Supabase -> Settings -> API; never put this in the repo or index.html), `OSCAR_API_URL`, `SLACK_WEBHOOK_URL` (see step 3).
   (`OSCAR_API_URL` is optional: without it practices load with no contact data; add it later and the next run fills contacts in.) **Variables**: `DASHBOARD_URL`, optional `SLACK_MODE` (ON|DISABLED), `MIN_TIER_ALERT` (Tier 1|2|3).
3. **Slack** (new signals are posted to `#lalu_market_radar`): at api.slack.com/apps create an app (from scratch) > *Incoming Webhooks* > turn on > *Add New Webhook to Workspace* > choose `#lalu_market_radar` > copy the URL into the GitHub secret `SLACK_WEBHOOK_URL`. (Alternative: a bot token with `chat:write` in the secret `SLACK_BOT_TOKEN`, invited to the channel, and the variable `SLACK_CHANNEL`.) Until a secret is set the run still succeeds, shows a warning, and leaves signals unsent so they post once Slack is set up. Variables: `SLACK_MODE` (`ON` or `DISABLED`), `MIN_TIER_ALERT` (default `Tier 3`), `DASHBOARD_URL` (used for the links).
4. **GitHub Pages**: Settings -> Pages -> deploy from `main` / root. (Private repos need a paid GitHub plan for Pages.)
5. Run the **Daily market radar** workflow manually once. The first successful run is a silent *baseline*: it loads everything but raises no triggers and sends no email. From the second run, changes generate signals.

## Signals workflow and shareable views
Each signal has a status (New, In progress, Done, Dismissed) and a note, set in the Signals feed (the feed shows open signals by default). The web address carries the tab, filters, sort, selected network and open practice, so any view can be bookmarked or shared. Rows, headers and the side panel work from the keyboard (Tab, Enter / Space, Esc).

## Front end (for maintainers)
Plain HTML and JavaScript, no framework: `index.html` (markup), `js/*.js` (loaded in order: core, data-load, practices, networks, signals, data-tab, export, main) and `assets/tailwind.css` (built).
After adding or changing Tailwind classes run `npm ci && npm run build:css` and commit `assets/tailwind.css`; the `Tests` workflow fails if the committed file is stale and also drives the page in a real browser against a fake Supabase (`tests/dashboard_smoke.py`; run it locally with `pip install playwright && playwright install chromium`).
Database changes live in `supabase/migrations/` (applied in filename order). Dropping the superseded `load_devolved(text, text, jsonb)` and `review_job_employer(text, text, text)` functions is still to do.

## Inviting users
1. Supabase > Authentication > URL Configuration: set **Site URL** to the dashboard URL and add it under **Redirect URLs** (invite and reset links return there).
2. Supabase > Authentication > Users > **Invite user**, then allow them: `insert into allowed_users (email) values ('them@lalu.co.uk');` (emails must be lower case).
3. They open the link, land on **Choose your password**, set one (10+ characters) and go straight into the dashboard. "Forgot your password?" on the login page uses the same screen.
Supabase's built-in email sender is for testing only (heavily rate-limited, and I believe restricted to your own team's addresses). For real invites configure custom SMTP (Authentication > SMTP Settings, e.g. Resend) once the sending domain is verified.

## Dashboard layout
Five tabs (the Data tab has four sub-tabs: Overview, Data sources, Signal settings, Pricing & rate card): **Practices** (search, tier and HubSpot filters, "More filters", removable filter chips, sortable columns; click a row for the profile side panel),
**Networks** (PCN / group / federation / ICB with linked practices, aggregated ARR, engaged and customer status; "View →" jumps to the filtered practice list with a back link),
**Revenue** (route totals and route x tier matrix), **Signals** (change-detection feed, live updates) and **Data** (freshness, recent pipeline runs, patient-count upload/runner, rate card).
`tests/dashboard_smoke.py` exercises all of them against a fake Supabase client.

## Scotland and Wales
Upload the Public Health Scotland *practice contact details* CSV or the NHS Wales practice data CSV in the Data tab ("Scotland and Wales"); the type is detected from the columns.
Scotland rows are stored as `S` + the 5-digit practice code with list sizes, GP cluster (PCN equivalent) and health board (ICB equivalent). Wales rows match the ODS
`W` codes, add the cluster, and have **no list sizes** in this file, so they carry no ARR until Welsh counts are supplied. Uploaded groupings are locked (`network_locked`) so the daily sync keeps them,
and bulk loads do not raise NEW_PRACTICE signals. Each file has its own box in the Data tab; to support another file add an entry to the `UPLOADS` registry in `index.html` (title, source link, `parse`, `load`, `status`) plus a database load function if needed. Clicking a network row opens its profile: price build-up, discounts, and each linked practice priced singly vs in the network.
 (two ways, both in the dashboard's "Patient counts" card)
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

## Pricing, tiers and estimated ARR
Tiers and ARR follow Lalu's pricing model (the "Patient Size Threshold Analysis For Discounts" sheet) and are driven by two editable tables
in Supabase, so nothing is hard-coded:
- `pricing_tiers`: per route (`practice`, `pcn`, `icb`; `group` / `federation` allowed when you define them) the patient threshold, size discount and optional speed discount for tiers 1-5.
- `pricing_settings`: list prices per patient per month (All reports and SAR only, annual and monthly), term discounts, price floor (All reports), VAT.
Rates are per patient per **month**; Est. ARR = patients x price x 12. Two products: **All reports** (annual 0.08 / monthly 0.10) and **SAR only** (annual 0.05 / monthly 0.06). Discounts apply to **annual plans only** (monthly has none): price = list x (1 - size - term - speed), with the price floor protecting All reports only. The optional speed discount (off by default) applies to every year of the term and ends at renewal. The practice and network tables carry a "SAR ARR" column; the Revenue tab has an All reports / SAR only / Mix scenario with an editable SAR-only share.
The views `practice_pricing` and `org_pricing` calculate it live, so editing a row (Supabase -> Table Editor) updates the dashboard immediately.
The dashboard shows it per practice, per network (Networks tab) and in the **Revenue** tab (route totals, tier breakdown, pipeline by lead status, rate card).
Provider groups and federations are priced on the aggregate patients of their linked practices (seeded from the PCN schedule; edit the `group` / `federation` rows in `pricing_tiers`). The routes are alternative ways to sell to the same patients: do not add them together. `MIN_TIER_ALERT` (Tier 1-5) uses the single-practice tiers.

## HubSpot status (for the future integration)
No HubSpot connection exists yet; the tables are ready for one. Fields the integration should write:
- `contacts.hubspot_status` (`Not imported` / `Imported`), `hubspot_imported_at`, `hubspot_contact_id`: has this contact been imported into HubSpot, and when.
- `gp_practices.hubspot_company_id`, `hubspot_company_imported_at`, `hubspot_stage` (raw lifecycle stage), `hubspot_engaged`, `hubspot_customer`, `hubspot_synced_at`.
The dashboard reads them: the practice table's **HubSpot** column (Customer / Engaged / In HubSpot / Not in HubSpot plus the import date), the Networks tab's **Engaged**
(x of N linked practices) and **Customers** status, and the Revenue tab's HubSpot position. Daily loads never overwrite these fields.
Example manual update: `update contacts set hubspot_status='Imported', hubspot_imported_at=now() where contact_urn=123;`

## Data model
`gp_practices` holds one row per practice with everything collected about it. `organisations` + `org_relationships` form a graph
(practice -> PCN / ICB / provider group / federation) where every link records its source (ods, cqc, oscar), a confidence and whether
it is confirmed. `refresh_org_graph()` rebuilds the links after each daily load; the view `org_summary` feeds the dashboard's **Networks**
tab. Oscar data is optional: PCN, ICB and groups come from NHS ODS and CQC; Oscar adds contacts, federation and notes.

## Operating notes
- NHS patient numbers are **monthly**, so list-size/closure signals move monthly; Oscar contact changes are picked up daily.
- A failed run posts a warning to the Slack channel and is recorded in `ingest_runs`. Rejected rows (bad ODS codes etc.) go to `ingest_rejects`.
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
| Signal notifications (was an email digest, now Slack) | Unescaped HTML, `.single()` crash, DNC ignored, filtered triggers re-queued forever | Escaped, tier + DNC filtering, filtered triggers marked handled, capped at 150 rows, only marked sent after Resend accepts |
| "Merger" = PCN change | Misleading | Closure of an active practice = MERGER_DETECTED; PCN moves are a separate PCN_CHANGE |
| Silent failures | Nobody knows pipeline is down | Run log, failure email, sanity guards (feed size, patient coverage, >50 closures) |

## Known limits
- Verified from GitHub runners: ODS API and ODS export respond; digital.nhs.uk and OpenPrescribing are blocked by Cloudflare.
- The GP registration file parser and the practice->PCN lookup (ODS `Rels`, role RO272) follow the published formats but have only been tested on fixtures. Check `ingest_runs.stats` after the first run (`ods_active`, `pcn_mapped`, `pcn_error`); PCN failures degrade gracefully.
- Oscar has no clinical-system field, so EMIS/SystmOne/Vision is a website-based hint only and mostly "Unknown".

## Security notes

- The Supabase client script is hosted in `assets/vendor/` (version in the file name) rather than loaded from a CDN, so a compromised CDN cannot inject code. To upgrade it, `npm pack @supabase/supabase-js@<version>` and copy `dist/umd/supabase.js` there.
- The Supabase advisor flags four `SECURITY DEFINER` functions and three tables with RLS but no policy. All are intentional and documented in migration `20261017000018`.
- Turn on leaked-password protection in the Supabase dashboard (Authentication) so breached passwords are rejected.

## Updating prices from the pricing spreadsheet

Data > Pricing > "Update rates from the pricing spreadsheet". Download the `Pricing-Discount-Model` tab (and `Multi-Year-Matrix` for the 2/3-year term discounts and price floor; add cells labelled "SAR Only Annual List Price" and "SAR Only Monthly List Price" to sync the SAR rates) as CSV, choose the file(s), review the list of differences and press Apply. It updates existing rates only (`sync_pricing` in Supabase): annual and monthly plan list prices (both per patient per **month**: 0.08 and 0.10; annual revenue is patients × rate × 12), VAT, price floor, term discounts, and the practice / PCN / ICB tier thresholds and discounts. Provider-group and federation tiers are not touched.

## Closures and mergers

- **ODS closed:** a practice that drops off the ODS active GP list is marked `Closed` by the daily pipeline (with a "closed" signal).
- **Closed or merged but still Active on ODS:** ODS has no successor links and closes practices late, so such a practice usually shows no NHS list size. The database suggests likely cases and a person decides in **Signals > Closures & mergers** or on the practice profile (nothing is automatic):
  - `practice_merge_suggestions`: no list size and a practice with a list size at the same postcode (ODS "Y" codes are low confidence). Buttons: *Merged*, *Closed*, *Neither*, or mark a different practice manually.
  - `practice_closure_candidates`: no list size, CQC *Deregistered*, no absorber at its postcode.
- **Confirm merger** (`set_practice_merge`): records `merged_into`, who and when; raises `MERGER_DETECTED` if a customer or engaged practice is involved.
- **Confirm closed** (`set_practice_closed`): records `closure_confirmed_at`; raises one `PRACTICE_CLOSED` signal on the practice's **PCN** listing its nearest practices (the signal can be turned off in Data > Signal settings).
- Closed and merged practices are hidden from the main list (Status filter shows them). CQC *Deregistered* on its own only raises a signal for practices with no list size (978 practices with patients show Deregistered, which is mostly re-registrations).
- Network counts still include merged and closed practices as members (they have no patients, so revenue is unaffected).

## Push pricing to HubSpot

On a practice profile, **Push to HubSpot…** (Pricing section) sends the selected product, billing, term and speed options to the practice's HubSpot deal.
1. First time: search is pre-filled with the practice name and ODS code. Pick the company, then its deal. The link is saved in `hubspot_links` after the first successful write.
2. Preview: shows the deal's Size Discount %, Speed Discount %, Term Length Discount % and Term Length (Years) that will be written, and warns when the company list size, deal Size Tier or Value per Patient differ from the tool. Ticked fields are updated on write.
3. After the write the tool waits (up to 20 seconds) for HubSpot to recalculate **Total Discount %** and **Actual Value per Patient (Calculated)** and compares both with the tool.

Setup: create a HubSpot private app with companies and deals read/write scopes and add its token as the Supabase edge function secret `HUBSPOT_TOKEN`. The function `hubspot-push` only accepts signed-in allowlisted users and can only write the fields listed in its source. `HS_PCT` in `js/hubspot.js` is 100 (HubSpot stores 5% as 5); set it to 1 if a test write shows fractions.
