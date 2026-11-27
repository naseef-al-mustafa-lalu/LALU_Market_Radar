"""Opt contacts that Atlas added to HubSpot (from Oscar, or enriched by Apollo) into the Marketing Information subscription, as the team decided.
Left alone: anyone with an opt-out (unsubscribed from all email, or opted out of Marketing Information), and anyone already subscribed. HubSpot-origin contacts are not touched.
The write is HubSpot's subscribe call with a legal basis and an explanation, so each contact carries the reason. Dry run unless APPLY=1; prints counts only (no names or addresses)."""
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor

from .common import Rest
from .hubspot_sync import Hub, read_objects
from .subscription_status import MARKETING_INFORMATION, statuses

SOURCES = ("oscar", "apollo")
LEGAL_BASIS = "LEGITIMATE_INTEREST_OTHER"
EXPLANATION = "B2B contact at an NHS practice (from Oscar or enriched by Apollo): opted in to Marketing Information by team decision, Nov 2026. Unsubscribes are honoured."


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


def subscribe(hub, email):
    hub.call("POST", "/communication-preferences/v3/subscribe", json={"emailAddress": email, "subscriptionId": MARKETING_INFORMATION, "legalBasis": LEGAL_BASIS, "legalBasisExplanation": EXPLANATION})


def run(rest, hub, apply=False):
    rows = rest.select_all("contacts", "contact_urn,email,hubspot_contact_id,source", order="contact_urn", params={"hubspot_contact_id": "not.is.null"})
    people = {}
    for r in rows:
        if (r.get("source") or "oscar") in SOURCES and (r.get("email") or "").strip():
            people[str(r["hubspot_contact_id"])] = r["email"].strip().lower()
    props = read_objects(hub, "contacts", list(people), ["email", "hs_email_optout", "hs_email_optout_" + MARKETING_INFORMATION])
    current, errs = statuses(hub, {e for h, e in people.items() if not opted_out(props.get(h, {}))})
    todo, out, have, bad = plan(people, props, current)
    result = {"candidates": len(people), "left_alone_opted_out": len(out), "already_subscribed": len(have), "to_subscribe": len(todo), "unreadable": len(bad), "first_read_errors": errs, "apply": apply}
    if apply:
        done, failed, first = 0, 0, []

        def one(email):
            try:
                subscribe(hub, email)
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
    print("RESULT " + json.dumps(run(Rest(env["SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"]), Hub(env["HUBSPOT_TOKEN"]), apply=env.get("APPLY", "0") == "1"), default=str))


if __name__ == "__main__":
    main()
