"""Post new signals to the Slack channel. Respects the tier filter and Do-Not-Contact; marks each signal sent only after Slack accepts it."""
import os
import sys

from . import slack
from .common import Rest, need_env

TIER_RANK = {f"Tier {i}": i for i in range(1, 6)}  # Tier 1 = largest (20,000+ patients) ... Tier 5 = smallest
MAX_SIGNALS = 40      # per run: the rest are in the dashboard
PER_MESSAGE = 8       # signals per Slack message (50-block limit)
COLS = ("id,trigger_type,headline,description,action,url,employer_code,organisations(name,kind),gp_practices(ods_code,practice_name,pcn_name,icb_name,total_patients,"
        "clinical_software,manager_name,manager_title,manager_email,manager_phone,"
        "manager_email_opt_out,lead_status,status)")


def tier_of(patients, tiers):
    """Tier number (1 = largest) from the editable pricing_tiers table (single-practice route)."""
    for t in sorted(tiers, key=lambda t: -t["threshold"]):
        if (patients or 0) >= t["threshold"]:
            return t["tier"]
    return max((t["tier"] for t in tiers), default=5)


def select(triggers, min_tier, tiers):
    """Split triggers into (to_send, to_skip) by tier threshold and Do-Not-Contact."""
    limit = TIER_RANK[min_tier]
    send, skip = [], []
    for t in triggers:
        p = t.get("gp_practices")
        ok = p and p["lead_status"] != "Do-Not-Contact" and tier_of(p["total_patients"], tiers) <= limit
        (send if ok else skip).append(t)
    send.sort(key=lambda t: (tier_of(t["gp_practices"]["total_patients"], tiers), -t["gp_practices"]["total_patients"]))
    return send, skip


def signal_text(t, tiers, dashboard_url=""):
    """One signal as Slack mrkdwn: who, what happened, the next step, the contact and links."""
    m = slack.mrkdwn
    kind = m(t["trigger_type"].replace("_", " ").title())
    p = t.get("gp_practices")
    if p:
        base = (dashboard_url or "").split("?")[0].rstrip("/")
        name = slack.link(f"{base}/?open={p['ods_code']}" if base else "", p["practice_name"])
        who = f"*{name}*  `{m(p['ods_code'])}` · Tier {tier_of(p['total_patients'], tiers)} · {p['total_patients']:,} patients" + (f" · {m(p['pcn_name'])}" if p.get("pcn_name") else "")
        bits = [x for x in (p.get("manager_name"), p.get("manager_title")) if x]
        contact = m(" · ".join(bits)) if bits else "No contact on file"
        if p.get("manager_phone"):
            contact += f" · {m(p['manager_phone'])}"
        if p.get("manager_email") and not p.get("manager_email_opt_out"):
            contact += f" · {m(p['manager_email'])}"
        elif p.get("manager_email"):
            contact += " · email opt-out: do not email"
    else:
        org = t.get("organisations") or {}
        base = (dashboard_url or "").split("?")[0].rstrip("/")
        label = org.get("name") or "Unlinked employer " + str(t.get("employer_code") or "")
        who = f"*{slack.link(f'{base}/?tab=signals' if base else '', label)}*  _{m(org.get('kind') or 'link it in Signals > Job matches')}_"
        contact = ""
    lines = [who, f"*{kind}*: {m(t['headline'])}", m(t.get("description") or "")]
    if t.get("action"):
        lines.append(f":arrow_right: *Next step:* {m(t['action'])}")
    if contact:
        lines.append(f":bust_in_silhouette: {contact}")
    src = slack.link(t.get("url"), "Open source")
    if src.startswith("<"):
        lines.append(f":link: {src}")
    return "\n".join(x for x in lines if x)[:2900]


def messages(send, others, tiers, dashboard_url=""):
    """Slack messages (text, blocks): a header, then the signals PER_MESSAGE at a time."""
    items = [signal_text(t, tiers, dashboard_url) for t in (send + others)[:MAX_SIGNALS]]
    total = len(send) + len(others)
    head = f"*{total} new signal{'s' if total != 1 else ''}* in Lalu Atlas" + (f" (showing the first {MAX_SIGNALS}: the rest are in the dashboard)" if total > MAX_SIGNALS else "")
    out = []
    for i in range(0, len(items), PER_MESSAGE):
        blocks = []
        if i == 0:
            blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": head}})
            if dashboard_url:
                blocks.append({"type": "actions", "elements": [{"type": "button", "text": {"type": "plain_text", "text": "Open dashboard"}, "url": dashboard_url}]})
        for j, txt in enumerate(items[i:i + PER_MESSAGE]):
            blocks += [{"type": "divider"}, {"type": "section", "text": {"type": "mrkdwn", "text": txt}}]
        out.append((head if i == 0 else "More new signals", blocks))
    return out


def main():
    need_env("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY")
    if os.environ.get("SLACK_MODE", "ON") == "DISABLED":
        print("Slack posting disabled."); return
    if not slack.configured():
        print("::warning::Slack is not set up (add the SLACK_WEBHOOK_URL secret): new signals stay unsent until it is.")
        return
    min_tier = os.environ.get("MIN_TIER_ALERT", "Tier 3")  # Tier 3 = 10,000+ patients
    if min_tier not in TIER_RANK:
        sys.exit(f"MIN_TIER_ALERT must be one of {list(TIER_RANK)}")
    rest = Rest(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
    triggers = rest.select_all("sales_triggers", COLS, order="detected_at", params={"email_dispatched": "eq.false"})   # column name predates Slack: it means "sent"
    if not triggers:
        print("No new signals."); return
    tiers = [t for t in rest.select_all("pricing_tiers", "route,tier,threshold", order="tier") if t["route"] == "practice"]
    others = [t for t in triggers if not t.get("gp_practices")]
    send, skip = select([t for t in triggers if t.get("gp_practices")], min_tier, tiers)
    for text, blocks in messages(send, others, tiers, os.environ.get("DASHBOARD_URL", "")):
        slack.post(text, blocks)    # raises on failure: nothing is marked sent, so the next run tries again
    done = [t["id"] for t in send + skip + others]
    for i in range(0, len(done), 100):
        rest.patch("sales_triggers", {"id": f"in.({','.join(done[i:i + 100])})"}, {"email_dispatched": True})
    print(f"Posted {len(send)} practice + {len(others)} network/unlinked signals, filtered {len(skip)}.")


if __name__ == "__main__":
    main()
