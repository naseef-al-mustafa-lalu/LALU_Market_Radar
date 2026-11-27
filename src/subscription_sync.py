"""Opt-in: copy each person's Marketing Information subscription status from HubSpot onto Atlas's contact (contact_hubspot.hs_mkt_subscription), so Atlas can hold back anyone HubSpot would not send a marketing email to.
Only people who could be eligible are read: the eligible ones, and the ones held back for this reason alone (so they come back when they opt in). A failed lookup is skipped, never recorded as a status."""
from .hubspot_sync import chunks
from .subscription_status import statuses

KNOWN = ("SUBSCRIBED", "NOT_SUBSCRIBED")


def sync_subscription(rest, hub, now):
    status = rest.select_all("contact_status", "contact_urn,status,reasons", order="contact_urn")
    cand = {s["contact_urn"] for s in status if s["status"] == "eligible" or (s["status"] == "suppressed" and list(s.get("reasons") or []) == ["not_subscribed"])}
    by_email = {}
    for c in rest.select_all("contacts", "contact_urn,email", order="contact_urn", params={"hubspot_contact_id": "not.is.null"}):
        if c["contact_urn"] in cand and (c.get("email") or "").strip():
            by_email.setdefault(c["email"].strip().lower(), []).append(c["contact_urn"])
    got, errors = statuses(hub, set(by_email))
    items = [{"contact_urn": urn, "status": st, "at": now} for email, (st, _basis) in got.items() if st in KNOWN for urn in by_email[email]]
    changed = 0
    for ch in chunks(items, 1000):
        changed += int(rest.rpc("apply_subscription_status", {"items": ch}) or 0)
    return {"subscription_checked": len(got), "subscription_not_subscribed": sum(1 for st, _ in got.values() if st == "NOT_SUBSCRIBED"), "subscription_unreadable": sum(1 for st, _ in got.values() if st not in KNOWN), "subscription_first_errors": errors, "subscription_changed": changed}
