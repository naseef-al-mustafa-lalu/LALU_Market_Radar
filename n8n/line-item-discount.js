// Expected unit discount for a deal's Lalu Care line item, mirroring the dashboard's dealRate (js/practices.js) and the hubspot-push edge function.
// Deal discounts are fractions (a whole percent such as 5 is tolerated). Monthly plans pay list; the 0.052 per patient per month floor protects All reports only.
const FLOOR_PM = 0.052;
const PRODUCTS = { "440423339237": "all", "440425147578": "all", "440434162881": "sar", "440498134244": "sar" };
const MONTHLY = new Set(["440425147578", "440498134244"]);
const fr = v => { const n = Number(v); return !isFinite(n) || n <= 0 ? 0 : n > 1 ? n / 100 : n; };
function expectedDiscount(deal, line) {
  const id = String(line.hs_product_id);
  if (!(id in PRODUCTS)) return null;
  const price = Number(line.price) || 0;
  if (MONTHLY.has(id) || price <= 0) return 0;
  let total = fr(deal.size_discount) + fr(deal.speed_discount) + fr(deal.term_length_discount) + fr(deal.referral_discount);
  if (PRODUCTS[id] === "all") total = Math.min(total, 1 - (FLOOR_PM * 12) / price);
  return Math.round(Math.max(0, Math.min(1, total)) * price * 10000) / 10000;
}
module.exports = { expectedDiscount };
