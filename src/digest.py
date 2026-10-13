"""Morning digest: unsent triggers -> one HTML email via Resend. Respects tier filter, Do-Not-Contact and opt-outs."""
import os
import re
import sys

from .common import Rest, esc, need_env, recipients, send_email

TIER_RANK = {"Tier 1": 1, "Tier 2": 2, "Tier 3": 3}
MAX_ROWS = 150
COLS = ("id,trigger_type,headline,description,gp_practices(ods_code,practice_name,pcn_name,icb_name,total_patients,"
        "sales_segment,clinical_software,manager_name,manager_title,manager_email,manager_phone,"
        "manager_email_opt_out,lead_status,status)")


def tier_of(segment):
    m = re.match(r"(Tier \d)", segment or "")
    return TIER_RANK.get(m.group(1), 3) if m else 3


def select(triggers, min_tier):
    """Split triggers into (to_send, to_skip) by tier threshold and Do-Not-Contact."""
    limit = TIER_RANK[min_tier]
    send, skip = [], []
    for t in triggers:
        p = t.get("gp_practices")
        ok = p and p["lead_status"] != "Do-Not-Contact" and tier_of(p["sales_segment"]) <= limit
        (send if ok else skip).append(t)
    send.sort(key=lambda t: (tier_of(t["gp_practices"]["sales_segment"]), -t["gp_practices"]["total_patients"]))
    return send, skip


def row_html(t):
    p = t["gp_practices"]
    contact = esc(p["manager_name"] or "No contact on file")
    if p["manager_title"]:
        contact += f"<br><span style='color:#64748b;font-size:12px'>{esc(p['manager_title'])}</span>"
    if p["manager_email"] and not p["manager_email_opt_out"]:
        contact += f"<br><span style='font-size:12px'>{esc(p['manager_email'])}</span>"
    elif p["manager_email"]:
        contact += "<br><span style='color:#b91c1c;font-size:12px'>Email opt-out: do not email</span>"
    if p["manager_phone"]:
        contact += f"<br><span style='font-size:12px;color:#2563eb'>{esc(p['manager_phone'])}</span>"
    return (f"<tr style='border-bottom:1px solid #e2e8f0'><td style='padding:10px;font-size:14px'><b>{esc(p['practice_name'])}</b>"
            f"<br><span style='font-family:monospace;color:#64748b;font-size:11px'>{esc(p['ods_code'])} · {esc(p['sales_segment'].split(' (')[0])} · {p['total_patients']:,} pts</span></td>"
            f"<td style='padding:10px;font-size:12px'><b>{esc(t['trigger_type'].replace('_', ' '))}</b><br>{esc(p['clinical_software'])}<br>{esc(p['pcn_name'])}</td>"
            f"<td style='padding:10px;font-size:13px'>{contact}</td>"
            f"<td style='padding:10px;font-size:12px;background:#f8fafc'><b>{esc(t['headline'])}</b><br>{esc(t['description'])}</td></tr>")


def render(send, dashboard_url):
    rows = "".join(row_html(t) for t in send[:MAX_ROWS])
    more = f"<p style='color:#64748b'>+{len(send) - MAX_ROWS} more in the dashboard.</p>" if len(send) > MAX_ROWS else ""
    link = (f"<p style='text-align:center'><a href='{esc(dashboard_url)}' style='background:#2563eb;color:#fff;padding:12px 28px;"
            f"border-radius:8px;text-decoration:none'>Open dashboard</a></p>") if dashboard_url else ""
    return ("<html><body style='font-family:Arial,sans-serif;background:#f8fafc;padding:20px'>"
            "<div style='max-width:860px;margin:auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:28px'>"
            "<h2 style='color:#2563eb;margin-top:0'>Lalu Market Radar: daily digest</h2>"
            "<table style='width:100%;border-collapse:collapse;text-align:left'><thead><tr style='background:#f1f5f9;font-size:12px;"
            "text-transform:uppercase;color:#475569'><th style='padding:10px'>Practice</th><th style='padding:10px'>Signal</th>"
            f"<th style='padding:10px'>Contact</th><th style='padding:10px'>Detail</th></tr></thead><tbody>{rows}</tbody></table>{more}{link}"
            "</div></body></html>")


def main():
    need_env("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "RESEND_API_KEY")
    mode = os.environ.get("EMAIL_MODE", "DIGEST")
    min_tier = os.environ.get("MIN_TIER_ALERT", "Tier 3")
    if mode == "DISABLED":
        print("Email disabled."); return
    if min_tier not in TIER_RANK:
        sys.exit(f"MIN_TIER_ALERT must be one of {list(TIER_RANK)}")
    rest = Rest(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
    triggers = rest.select_all("sales_triggers", COLS, order="detected_at", params={"email_dispatched": "eq.false"})
    if not triggers:
        print("No new triggers."); return
    send, skip = select(triggers, min_tier)
    if send:
        send_email(f"Market radar: {len(send)} new lead signal{'s' if len(send) != 1 else ''}",
                   render(send, os.environ.get("DASHBOARD_URL", "")), recipients())  # raises on failure: nothing marked sent
    done = [t["id"] for t in send + skip]
    for i in range(0, len(done), 100):
        rest.patch("sales_triggers", {"id": f"in.({','.join(done[i:i + 100])})"}, {"email_dispatched": True})
    print(f"Sent {len(send)}, filtered {len(skip)}.")


if __name__ == "__main__":
    main()
