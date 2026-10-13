"""Monthly job: fetch NHS GP registered-patient counts and store them in Supabase.

digital.nhs.uk sits behind Cloudflare, which blocks cloud datacentres (including GitHub-hosted runners),
so this runs on a self-hosted runner on an ordinary office/home network. It is idempotent.
"""
import os
import sys
from datetime import datetime, timezone

from . import sources
from .common import Rest, need_env, send_alert


def main():
    need_env("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY")
    try:
        url = os.environ.get("GP_REG_URL") or sources.discover_gp_reg_url(sources.http_text)
        patients, month = sources.load_patients(sources.fetch(url))
        month = month or datetime.now(timezone.utc).strftime("%Y-%m")
        rows = [{"ods_code": c, "patients": n, "data_month": month} for c, n in patients.items()]
        rest = Rest(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
        rest.upsert("patient_counts", rows, "ods_code")
        updated = rest.rpc("apply_patient_counts")  # copy onto practices straight away so the dashboard refreshes
        print(f"OK {len(rows)} practices for {month} from {url}; {updated} practices updated")
    except Exception as e:  # noqa: BLE001
        msg = f"Monthly patient-count load failed: {e}"
        if os.environ.get("RESEND_API_KEY"):
            send_alert("Lalu Market Radar: patient-count load FAILED", msg)
        print(msg, file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
