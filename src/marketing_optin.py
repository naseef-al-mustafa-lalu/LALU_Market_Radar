"""Opt contacts that Atlas added to HubSpot (enriched by Apollo; Oscar ones only when asked for) into the Marketing Information subscription, as the team decided.
Left alone: anyone with an opt-out (unsubscribed from all email, or opted out of Marketing Information), and anyone already subscribed. HubSpot-origin contacts are not touched.
The write is HubSpot's subscribe call with a legal basis and an explanation, so each contact carries the reason. Dry run unless APPLY=1; prints counts only (no names or addresses)."""
import json
import os
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

from .common import Rest
from .hubspot_sync import Hub, read_objects
from .subscription_status import MARKETING_INFORMATION, statuses

SOURCES = ("apollo",)   # Oscar is on hold until the team says go: pass OPTIN_SOURCES=oscar,apollo to include it
LEGAL_BASIS = "LEGITIMATE_INTEREST_OTHER"
# The earlier wording ("... by team decision, Nov 2026"), kept so the contacts that carry it can be found and rewritten.
OLD_EXPLANATIONS = {
    "B2B contact at an NHS practice (from Oscar or enriched by Apollo): opted in to Marketing Information by team decision, Nov 2026. Unsubscribes are honoured.",
    "B2B contact at an NHS practice or network, added from Atlas: opted in to Marketing Information by team decision, Nov 2026. Unsubscribes are honoured.",
}
SOURCE_TEXT = {"oscar": "Source: Oscar data.", "apollo": "Source: Apollo.", "profile": "Added from Atlas."}


def explanation(source=None):
    """Why the contact can be emailed: legitimate interest, who they are, where their details came from, and that they can unsubscribe."""
    return ("Legitimate interest: B2B contact at an NHS practice or network, contacted in their professional role about services relevant to that role. "
            + SOURCE_TEXT.get(source or "", "Source: Oscar data or Apollo.") + " They can unsubscribe at any time.")


def truthy(v):
    return str(v or "").strip().lower() == "true"


def opted_out(props):
    """An opt-out of any kind: unsubscribed from all email, or from the Marketing Information subscription."""
    return truthy(props.get("hs_email_optout")) or truthy(props.get("hs_email_optout_" + MARKETING_INFORMATION))


def plan(people, props, current):
    """Sort the candidates: {hubspot id: email} -> (to subscribe, opted out, already subscribed, unreadable). `current` is {email: (status, basis)} from HubSpot."""
    todo, out, have, bad = {}, [], [], []
    for hid, email in people.items():
        if opted_out(props.get(hid, {})):
            out.append(hid)
            continue
        st = (current.get(email) or ("MISSING", ""))[0]
        if st == "SUBSCRIBED":
            have.append(hid)
        elif st in ("NOT_SUBSCRIBED", "MISSING"):
            todo[hid] = email
        else:
            bad.append(hid)
    return todo, out, have, bad


def subscribe(hub, email, source=None):
    hub.call("POST", "/communication-preferences/v3/subscribe", json={"emailAddress": email, "subscriptionId": MARKETING_INFORMATION, "legalBasis": LEGAL_BASIS, "legalBasisExplanation": explanation(source)})


def held_explanation(hub, email):
    """The explanation HubSpot holds on this person's Marketing Information subscription, or None (not subscribed, no record, or unreadable)."""
    from urllib.parse import quote
    try:
        d = hub.call("GET", "/communication-preferences/v3/status/email/" + quote(email, safe=""))
    except RuntimeError:
        return None
    hit = next((x for x in d.get("subscriptionStatuses", []) if str(x.get("id")) == MARKETING_INFORMATION and x.get("status") == "SUBSCRIBED"), None)
    return (hit or {}).get("legalBasisExplanation")


def rewrite_old(hub, targets, apply=False):
    """Contacts Atlas opted in with the earlier wording get the new one. Only a subscription whose explanation is exactly one of the old texts is touched, so anything set by someone else stays.
    targets: {email: source}. Returns counts."""
    def one(item):
        email, src = item
        if held_explanation(hub, email) not in OLD_EXPLANATIONS:
            return "other"
        if not apply:
            return "would_rewrite"
        try:
            subscribe(hub, email, src)
            return "rewritten"
        except RuntimeError as e:
            return "failed: " + str(e)[:100]
    out = Counter()
    with ThreadPoolExecutor(8) as ex:
        for r in ex.map(one, sorted(targets.items())):
            out[r] += 1
    return dict(out)


def activity_created(rest):
    """{hubspot id: email} for contacts people created from a practice or network profile in Atlas (the activity log records each as not existing before), whatever their source."""
    out = {}
    try:
        for r in rest.select_all("hubspot_activity", "kind,detail", order="id", params={"kind": "eq.add_contacts"}):
            d = r.get("detail") or {}
            for c in (d.get("contacts") or d.get("done") or []):   # the network wizard logs "contacts", the practice profile logs "done"
                if c.get("id") and c.get("email") and c.get("existed") is False:
                    out[str(c["id"])] = str(c["email"]).strip().lower()
    except Exception:  # noqa: BLE001  the sweep still covers the Oscar and Apollo contacts
        pass
    return out


def remainder_report(hub, others):
    """What HubSpot holds for the Oscar contacts that were not created by Atlas (left untouched): opted out, subscribed, not subscribed, or no status at all (MISSING)."""
    props = read_objects(hub, "contacts", list(others), ["hs_email_optout", "hs_email_optout_" + MARKETING_INFORMATION])
    cur, _ = statuses(hub, {e for h, e in others.items() if not opted_out(props.get(h, {}))})
    out = Counter()
    for h, e in others.items():
        out["OPTED_OUT"] += 1 if opted_out(props.get(h, {})) else 0
        if not opted_out(props.get(h, {})):
            out[(cur.get(e) or ("ERROR", ""))[0]] += 1
    return dict(out)


def run(rest, hub, apply=False, sources=SOURCES, created_only=True, report=True, rewrite=False):
    """Oscar contacts are only the ones Atlas created in HubSpot (checked and pushed through NeverBounce, so no HubSpot record existed before); Apollo contacts are all of them."""
    rows = rest.select_all("contacts", "contact_urn,email,hubspot_contact_id,source", order="contact_urn", params={"hubspot_contact_id": "not.is.null"})
    created = {r["contact_urn"] for r in rest.select_all("contact_nb", "contact_urn,nb_state", order="contact_urn", params={"nb_state": "eq.checked"})}
    people, others, src_of = activity_created(rest) if created_only else {}, {}, {}
    for r in rows:
        src = r.get("source") or "oscar"
        if src not in sources or not (r.get("email") or "").strip():
            continue
        if src == "oscar" and created_only and r["contact_urn"] not in created:
            others[str(r["hubspot_contact_id"])] = r["email"].strip().lower()
            continue
        people[str(r["hubspot_contact_id"])] = r["email"].strip().lower()
        src_of[r["email"].strip().lower()] = src
    props = read_objects(hub, "contacts", list(people), ["email", "hs_email_optout", "hs_email_optout_" + MARKETING_INFORMATION])
    current, errs = statuses(hub, {e for h, e in people.items() if not opted_out(props.get(h, {}))})
    todo, out, have, bad = plan(people, props, current)
    result = {"oscar_not_created_by_atlas": len(others), "candidates": len(people), "left_alone_opted_out": len(out), "already_subscribed": len(have), "to_subscribe": len(todo), "unreadable": len(bad), "first_read_errors": errs, "apply": apply}
    if rewrite:
        result["explanation_rewrite"] = rewrite_old(hub, {e: src_of.get(e) for e in people.values()}, apply=apply)
    if others and report:
        result["remainder_oscar_status"] = remainder_report(hub, others)
    if apply:
        done, failed, first = 0, 0, []

        def one(email):
            try:
                subscribe(hub, email, src_of.get(email))
                return None
            except RuntimeError as e:
                return str(e)[:160]
        with ThreadPoolExecutor(8) as ex:
            for err in ex.map(one, sorted(set(todo.values()))):
                if err:
                    failed += 1
                    if err not in first and len(first) < 3:
                        first.append(err)
                else:
                    done += 1
        result.update({"subscribed_now": done, "failed": failed, "first_write_errors": first})
    return result


def main():
    env = os.environ
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "HUBSPOT_TOKEN"):
        if not env.get(k):
            print(f"{k} is not set", file=sys.stderr)
            sys.exit(2)
    print("RESULT " + json.dumps(run(Rest(env["SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"]), Hub(env["HUBSPOT_TOKEN"]), apply=env.get("APPLY", "0") == "1", sources=tuple(x.strip() for x in env.get("OPTIN_SOURCES", "apollo").split(",") if x.strip()), created_only=env.get("OPTIN_SCOPE", "created") == "created", report=env.get("OPTIN_REPORT", "1") != "0", rewrite=env.get("OPTIN_REWRITE", "0") == "1"), default=str))


if __name__ == "__main__":
    main()
