"""Read-only: repeat the HubSpot reads the practice profile makes for its linked deal (the edge function's 'read' action) and print the result or error of each, so a 'Could not read the linked deal' can be explained."""
import json
import os
import sys

from .hubspot_sync import Hub

COMPANY_READ = ["name", "partner_organisation_code", "patient_list_size", "domain"]
DEAL_READ = ["dealname", "dealstage", "amount", "size_tier", "size_discount", "speed_discount", "term_length_discount", "term_length_years", "total_discount", "referral_discount", "value_per_patient",
             "actual_value_per_patient_calculated", "patient_list_size", "commercial_model", "contracted_patient_list_size"]
LINE_READ = ["name", "hs_product_id", "quantity", "price", "discount", "hs_discount_percentage", "amount", "hs_recurring_billing_period", "recurringbillingfrequency", "hs_recurring_billing_terms",
             "hs_recurring_billing_number_of_payments"]


def step(name, fn):
    try:
        r = fn()
        return {name: "ok", "detail": r}
    except Exception as e:  # noqa: BLE001
        return {name: "ERROR", "detail": str(e)[:400]}


def run(hub, company, deal):
    out = []
    out.append(step("company", lambda: hub.call("GET", f"/crm/v3/objects/companies/{company}?properties={','.join(COMPANY_READ)}").get("properties", {}).get("name")))
    out.append(step("deal", lambda: {k: v for k, v in hub.call("GET", f"/crm/v3/objects/deals/{deal}?properties={','.join(DEAL_READ)}").get("properties", {}).items() if k in ("dealname", "dealstage")}))
    out.append(step("deal_companies", lambda: [str(x["toObjectId"]) for x in hub.call("GET", f"/crm/v4/objects/deals/{deal}/associations/companies?limit=100").get("results", [])]))
    def lines():
        a = hub.call("GET", f"/crm/v4/objects/deals/{deal}/associations/line_items?limit=100")
        ids = [str(x["toObjectId"]) for x in a.get("results", [])]
        if not ids:
            return "no line items"
        d = hub.call("POST", "/crm/v3/objects/line_items/batch/read", json={"properties": LINE_READ, "inputs": [{"id": i} for i in ids]})
        return [{"id": x["id"], "product": x["properties"].get("hs_product_id"), "qty": x["properties"].get("quantity")} for x in d.get("results", [])]
    out.append(step("line_items", lines))
    return out


def main():
    token = os.environ.get("HUBSPOT_TOKEN")
    if not token:
        print("HUBSPOT_TOKEN is not set", file=sys.stderr)
        sys.exit(2)
    print("RESULT " + json.dumps(run(Hub(token), os.environ["COMPANY"], os.environ["DEAL"]), default=str))


if __name__ == "__main__":
    main()
