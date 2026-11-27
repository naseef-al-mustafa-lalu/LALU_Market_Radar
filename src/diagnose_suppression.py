"""Read-only: for a HubSpot contact segment, check that everything HubSpot's own suppression rules would keep out is also kept out by Atlas, and say why Atlas holds back the rest.
Prints one RESULT line of counts and a few HubSpot contact ids (no names or addresses)."""
import json
import os
import sys
from collections import Counter

from .common import Rest
from .diagnose_segment import members
from .hubspot_sync import Hub, read_objects

EXCLUSION_LISTS = {"campaign_exclusion_3428": "3428", "data_hygiene_4570": "4570", "owner_exclusion_3796": "3796"}
OWNERS = {"8768100", "29755472", "78343211", "9112363"}
BAD_BOUNCE = {"OTHER", "SPAM", "UNKNOWN_USER"}
PROPS = ["atlas_contact_eligibility", "email", "lifecyclestage", "neverbounce_status", "hs_email_optout", "hs_email_optout_621322507", "hs_email_bounce", "hs_email_hard_bounce_reason_enum",
         "hubspot_owner_id", "hs_sequences_is_enrolled", "hs_email_last_send_date", "contacturn"]


def hubspot_flags(p, in_lists):
    """Which of HubSpot's own suppression rules (the three lists and what they test) apply to this contact."""
    f = [k for k, v in in_lists.items() if v]
    if str(p.get("hs_email_optout") or "").lower() == "true": f.append("unsubscribed_from_all")
    if str(p.get("hs_email_optout_621322507") or "").lower() == "true": f.append("marketing_information_opt_out")
    try:
        if float(p.get("hs_email_bounce") or 0) >= 3: f.append("3_or_more_bounces")
    except ValueError:
        pass
    if p.get("hs_email_hard_bounce_reason_enum") in BAD_BOUNCE: f.append("bad_hard_bounce")
    if str(p.get("hubspot_owner_id") or "") in OWNERS: f.append("owner_exclusion")
    if str(p.get("hs_sequences_is_enrolled") or "").lower() == "true": f.append("in_sequence")
    if not (p.get("email") or "").strip(): f.append("no_email")
    return sorted(set(f))


def atlas_why(rows):
    """The reasons Atlas holds a person back: the union over the person's Atlas rows (an excluded row gives its exclusion text)."""
    out = set()
    for r in rows:
        if r["status"] == "excluded":
            out.add(("held: " + (r.get("excluded") or "excluded"))[:80])
        else:
            out.update(r.get("reasons") or [])
    return sorted(out)


def run(hub, rest, list_id):
    ids = members(hub, list_id)
    props = read_objects(hub, "contacts", ids, PROPS)
    lists = {k: set(members(hub, v)) for k, v in EXCLUSION_LISTS.items()}
    status = {r["contact_urn"]: r for r in rest.select_all("contact_status", "contact_urn,status,excluded,reasons", order="contact_urn")}
    by_hid = {}
    for c in rest.select_all("contacts", "contact_urn,hubspot_contact_id", order="contact_urn", params={"hubspot_contact_id": "not.is.null"}):
        if c["contact_urn"] in status:
            by_hid.setdefault(str(c["hubspot_contact_id"]), []).append(status[c["contact_urn"]])
    elig, slipping, slip_ids = Counter(), Counter(), {}
    atlas_only, both, not_in_atlas, mismatch = Counter(), Counter(), 0, Counter()
    for i in ids:
        p = props.get(i, {})
        e = p.get("atlas_contact_eligibility") or "blank"
        elig[e] += 1
        flags = hubspot_flags(p, {k: i in s for k, s in lists.items()})
        rows = by_hid.get(i, [])
        if e in ("main", "other"):
            if rows and all(r["status"] == "eligible" for r in rows) is False:
                mismatch["property says eligible but an Atlas row is not"] += 1
            for f in flags:
                slipping[f] += 1
                slip_ids.setdefault(f, []).append(i)
            continue
        if not rows:
            not_in_atlas += 1
            continue
        why = atlas_why([r for r in rows if r["status"] != "eligible"]) or ["(no reason: every row eligible)"]
        for w in why:
            (both if flags else atlas_only)[w] += 1
    return {"segment_members": len(ids), "atlas_eligibility": dict(elig), "ATLAS_ELIGIBLE_BUT_HUBSPOT_WOULD_SUPPRESS": dict(slipping), "slipping_sample_ids": {k: v[:5] for k, v in slip_ids.items()},
            "eligible_property_vs_rows": dict(mismatch), "not_eligible_not_held_in_atlas": not_in_atlas, "not_eligible_reasons_where_hubspot_also_suppresses": dict(both),
            "not_eligible_reasons_atlas_only": dict(atlas_only)}


def main():
    env = os.environ
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "HUBSPOT_TOKEN"):
        if not env.get(k):
            print(f"{k} is not set", file=sys.stderr)
            sys.exit(2)
    print("RESULT " + json.dumps(run(Hub(env["HUBSPOT_TOKEN"]), Rest(env["SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"]), env["LIST_ID"].strip()), default=str))


if __name__ == "__main__":
    main()
