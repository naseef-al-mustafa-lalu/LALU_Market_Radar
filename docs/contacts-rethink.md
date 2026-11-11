# Contacts: audit and rethink

Status: proposal for approval. Nothing here is built yet; the fixes made during the audit are listed at the end.

## 1. What contacts are today

**One table, `public.contacts`, about 56,000 rows and about 60 columns**, written by six programs with different rules:

| Writer | What it does to contacts |
|---|---|
| Oscar load (`src/ingest.py`, daily 08:30 UTC) | inserts and updates Oscar rows by Oscar ContactURN; grades the address; sets held reasons; adopts a HubSpot row with the same email and deletes it; deletes rows Oscar no longer lists; queues contacts for NeverBounce |
| HubSpot sync, import (`import_hubspot_contacts`) | inserts HubSpot contacts Atlas does not hold (email, practice company, not made by Atlas) |
| HubSpot sync, link step (`contact_link_updates`) | sets or clears `hubspot_contact_id` and status by matching email per practice |
| HubSpot sync, state (`apply_contact_state`) | copies lifecycle, sequence, bounce, opt-out, owner, NeverBounce, disqualification, closed-lost into `hs_*` columns |
| NeverBounce run (`src/neverbounce.py`) | verifies approved contacts, creates them in HubSpot, writes the result and the HubSpot id |
| Browser and edge function | Review accept/reject, names, NeverBounce approval, the Import tab (`load_contact_candidates`), "add contacts" on a practice profile |

**Readers:** Contacts page, Audiences, practice profile, HubSpot company page, group deal form. The Contacts page downloads every contact (about 56,000 rows) and works out status in the browser each time.

**Overlapping ideas about "may we contact this person":** email-quality grade, `held_reason`, review decision (`reviewed_by`), NeverBounce state, 10 suppression rules, role group, per-title mode, lifecycle. The browser combines them in `ctEvaluate`; nothing in the database says what the answer is.

## 2. Why it keeps breaking

Every bug this week was two writers disagreeing about one row:

1. The sync cleared the HubSpot link of email-less contacts, so the next import stored them again (about 13,800 duplicate rows).
2. The Oscar load rewrote `held_reason` to nothing for rows it had just stored (about 36,800 rows a day), putting held contacts back in profiles and Review.
3. Oscar lists one person under several ContactURNs; deleting the copies only made the next load re-insert them.
4. A raised import cap loaded thousands of HubSpot contacts into the Review queue the owner had just cleared.
5. Identity is by URN for Oscar, by HubSpot id for HubSpot and by (practice, email) for matching: three keys for one person.

## 3. Proposal

### A. One person per email, linked to the practices they work at (DECIDED)
- **A person is one row, keyed by lowercase email.** The practices they work at are rows in a link table (`contact_practices`: person, practice, job title at that practice, Oscar URN, primary flag). This matches HubSpot, where one contact is one record associated with several companies.
- Why not one row per (practice, email): opt-out, bounce, lifecycle, sequence, NeverBounce result and the review decision belong to the **person**, not the practice. Held once per practice they drift apart (an opt-out recorded on one row and not another), NeverBounce would check the same address twice, and an audience could list one person twice.
- A partial unique index on the email enforces it, so a duplicate fails loudly instead of accumulating.
- **Contacts with no email are counted, not stored (DECIDED, built).** A ledger table `contact_noemail` remembers each one by Oscar URN or HubSpot id, so it is never re-imported, and the Contacts page shows the count.
- `contact_urn` stays as the stable internal id of the person so audiences, candidates and segments keep working.

### B. Each writer owns its own table
`contacts` keeps identity and Oscar facts only. Side tables, each written by exactly one program:
- `contact_hubspot` (the `hs_*` state): HubSpot sync only
- `contact_nb` (NeverBounce state and approval): NeverBounce and the approval functions only
- `contact_review` (accept, reject, reviewer, name edits): Review functions only
A view `contacts_full` joins them for reading. A writer can no longer overwrite another's columns, which removes the whole class of bug in section 2.

### C. One status, decided in the database
A SQL function `contact_status(...)` (and a stored result, refreshed after every load, sync, review and rules change) returns **eligible / held (reason) / excluded (reason)** and the section (Main or Other). It reads the rules from tables (`contact_rules`, `job_title_modes`), not from a JSON blob in `app_flags`. The browser only shows the answer; the rules exist in one place. The rule logic in `ctEvaluate` is ported once and then deleted from the browser.

### D. A server-side Contacts page
The page asks for one page at a time with filters, sort and tile counts computed by the database (`contacts_page`, `contacts_counts`). Segments store their filters (and any hand-picked members) in a table. The 56,000-row download goes away, along with the pause when the page opens.

### E. One Review queue
Merge the Import tab's candidate flow into Review. One queue, one list of reasons, three actions: Accept, Reject, Fix name. Job titles stay one-by-one (already built).

## 4. What stays as it is
Oscar import, NeverBounce, Audiences and their approval flow, HubSpot sequences, the re-engagement view, the duplicate guard, the suppression rules and their settings screen.

## 5. Order of work (each step ships and is tested on its own)
1. **No-email ledger (done) and dedupe:** stop storing contacts with no email (done: ledger, load change, count on the page); remove the remaining duplicates. *Small.*
1b. **Person and practice link:** introduce the person row keyed by email and the `contact_practices` link table, backfilled from today's rows, with a compatibility view; add the unique email index once the counts are clean. *Medium.*
2. **Split the side tables** (2a DONE: `contact_hubspot`, `contact_nb`, `contact_review`, view `contacts_full`, one-way mirror trigger from `contacts`, `contact_sides_check()`; 2b: move HubSpot sync, NeverBounce and review RPCs to write their own table, then stop the mirror and drop the columns from `contacts`) with a compatibility view so nothing in the browser changes; move each writer to its table. *Medium.*
3. **Status in the database:** port the rules, store the result, compare it against the browser's answer on all 56,000 contacts until they match exactly, then switch the browser to it. *Medium-large.*
4. **Server-side Contacts page** and server-side segments. *Medium.*
5. **Merge Import into Review** and remove the dead code (candidates table, old upload). *Small-medium.*

## 6. Risks and how they are contained
- **Behaviour drift when porting the rules:** step 3 runs both versions side by side and only switches when every contact agrees.
- **Unique index rejecting a load:** the Oscar load is changed first to keep one row per (practice, email) (done), and the index goes on only after a clean count.
- **Downtime:** none expected; the compatibility view keeps the current screens working between steps.
- **Rollback:** each step is a migration plus a code change; the previous table layout stays until the step after it is verified.

## 7. Decisions
1. Identity: one person per email, linked to one or more practices. **Decided.**
2. No-email contacts: kept as a count only, remembered so they are not re-imported. **Decided and built.**
3. Order of work: **approved**, starting with the no-email ledger (step 1 below), then the person/practice split.

## 8. Fixed during the audit (already live)
HubSpot link kept for email-less contacts; held reasons kept by the daily load; one row per email per practice in the Oscar load; contact import limited to contacts with an email; duplicate guard with Slack alert; Review source filter, name entry and one-by-one job titles; NeverBounce no longer adds to lists automatically.
