# n8n: keep line items in step with deal discounts

HubSpot workflows cannot edit line items, so this n8n workflow does it. Every 15 minutes it finds Sales and Conversion deals changed in the last 20 minutes, reads their Lalu Care line item, works out the unit discount from the deal's `size_discount`, `speed_discount`, `term_length_discount` and `referral_discount`, and PATCHes the line item when it differs. Setting `referral_discount` to 0 when a group condition fails reprices the line item on the next run.

The maths lives in `line-item-discount.js` (same rules as the dashboard: annual plans only, floor £0.052 per patient per month on All reports only) and is embedded in the "Work out discount" node. Keep both in step; `tests/test_units.py` checks they match.

## Set up
1. n8n: Workflows > Import from file > `line-item-sync.workflow.json`.
2. Create a Header Auth credential: name `Authorization`, value `Bearer <HubSpot private app token>`, and pick it on the four HTTP nodes. The token needs `crm.objects.deals.read`, `crm.objects.line_items.read` and `crm.objects.line_items.write`.
3. Run once by hand on a test deal, check the line item, then activate.

## Before relying on it
- The deal `Total Discount %` calculation property must include `referral_discount`, and the dashboard's `HS_REFERRAL_WRITES` flag stays false until it does.
- The deal amount follows the line items in HubSpot only if it is not set manually; check that on a test deal. If it does not, add a PATCH of the deal `amount` after the line item step.
- The workflow was written without access to an n8n instance, so it has not been run.
