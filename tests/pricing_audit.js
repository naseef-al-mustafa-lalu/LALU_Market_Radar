const fs = require("fs"), vm = require("vm");
const src = fs.readFileSync(require("path").join(__dirname, "..", "js", "practices.js"), "utf8");
const a = src.indexOf("let speedOn"), b = src.indexOf("let routeCmpPractice");
const seg = src.slice(a, b);
const doc = { addEventListener() {}, querySelectorAll: () => [], querySelector: () => null };
const settings = { list_price_per_patient: .08, monthly_list_price_per_patient: .10, list_price_sar_per_patient: .05, monthly_list_price_sar_per_patient: .06, term_discount_2yr: .025, term_discount_3yr: .05, price_floor_per_patient: .052 };
const cfgSettings = Object.fromEntries(Object.entries(settings).map(([k, v]) => [k, { value: v }]));
const T = (route, rows) => rows.map(([tier, th, size, speed], i) => ({ route, tier, threshold: th, size_discount: size, speed_discount: speed, label: "L" + tier }));
const cfgTiers = [...T("practice", [[1,20000,.1,.05],[2,15000,.075,.05],[3,10000,.05,.05],[4,5000,0,.05],[5,0,0,.05]]),
  ...T("pcn", [[1,80000,.2,.05],[2,60000,.175,.05],[3,45000,.15,.05],[4,30000,.125,.05],[5,0,.1,.05]]),
  ...T("icb", [[1,3500000,.35,0],[2,2500000,.325,0],[3,1750000,.3,0],[4,1000000,.275,0],[5,0,.25,0]])];
const ctx = { document: doc, cfgSettings, cfgTiers, chip: (t) => t, rate3: x => { x = Number(x); const f4 = x.toFixed(4); return f4.endsWith("0") ? x.toFixed(3) : f4; }, TIER_CLS: {}, esc: x => String(x ?? ""), pct: x => (Math.round(x * 1000) / 10) + "%", gbpFull: x => "£" + Math.round(x).toLocaleString("en-GB"), console };
vm.createContext(ctx);
vm.runInContext(seg + "\n;this.api = { get: () => ({speedOn, termYrs, billing, product}), set: (s) => { speedOn = s.speedOn; termYrs = s.termYrs; billing = s.billing; product = s.product; }, priceCardBody, dealRate, baseRate, yearly };", ctx);
const api = ctx.api;
// independent reference (first principles, from the stated rules)
function ref(p, c, row) {
  const list = (c.billing === "monthly" ? { all: .10, sar: .06 } : { all: .08, sar: .05 })[c.product];
  if (c.billing === "monthly") return list;                       // monthly: no discounts
  const term = c.termYrs === 3 ? .05 : c.termYrs === 2 ? .025 : 0, speed = c.speedOn ? row.speed_discount : 0;
  let r = list * (1 - row.size_discount - term - speed);
  if (c.product === "all") r = Math.max(.052, r);                  // floor: All reports annual only
  return r;
}
const tierFor = (route, n) => cfgTiers.filter(t => t.route === route).sort((x, y) => y.threshold - x.threshold).find(t => n >= t.threshold);
const sample = [["practice", 1], ["practice", 4999], ["practice", 5000], ["practice", 9999], ["practice", 10000], ["practice", 14999], ["practice", 15000], ["practice", 19999], ["practice", 20000], ["practice", 123072],
  ["pcn", 20000], ["pcn", 30000], ["pcn", 59999], ["pcn", 80000], ["pcn", 128707], ["icb", 500000], ["icb", 1000000], ["icb", 1750000], ["icb", 2500000], ["icb", 3500000], ["icb", 5000000]];
let n = 0, bad = 0; const txt = h => h.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ");
for (const [route, pts] of sample) for (const product of ["all", "sar"]) for (const billing of ["annual", "monthly"]) for (const termYrs of [1, 2, 3]) for (const speedOn of [false, true]) {
  const c = { product, billing, termYrs, speedOn }; api.set(c);
  const row = tierFor(route, pts), want = ref(pts, c, row), wantYr = pts * want * 12;
  const got = api.dealRate(billing === "monthly" ? 0 : row.size_discount, billing === "monthly" ? 0 : (termYrs === 3 ? .05 : termYrs === 2 ? .025 : 0), billing === "monthly" ? 0 : (speedOn ? row.speed_discount : 0));
  const html = txt(api.priceCardBody({ patients: pts, tierRow: row, route, who: "x" }, "t"));
  n++;
  const headline = html.match(/Estimated annual revenue[^£]*£([\d,]+)/i);
  const hv = headline ? Number(headline[1].replace(/,/g, "")) : NaN;
  const perPt = html.match(/Price per patient per month[^£]*£([\d.]+)/i);
  const tot = html.match(/Total over (\d) years[^£]*£([\d,]+)/);
  const totOk = billing === "monthly" || termYrs === 1 ? !tot : tot && Number(tot[1]) === termYrs && Math.abs(Number(tot[2].replace(/,/g, "")) - Math.round(wantYr) * termYrs) <= termYrs;
  const btn = [...html.matchAll(/(\d) years?[^£]*£([\d,]+) \/yr/g)];
  const btnOk = billing === "monthly" || btn.every(m => { const y = Number(m[1]); const t = y === 3 ? .05 : y === 2 ? .025 : 0; const r = ref(pts, { ...c, termYrs: y }, row); return Math.abs(Number(m[2].replace(/,/g, "")) - Math.round(pts * r * 12)) <= 1; });
  const ok = totOk && btnOk && Math.abs(got - want) < 1e-9 && Math.abs(hv - Math.round(wantYr)) <= 1 && perPt && Math.abs(Number(perPt[1]) - want) < 5e-4;
  if (!ok) { bad++; if (bad < 15) console.log("MISMATCH", route, pts, JSON.stringify(c), "want", want.toFixed(5), "got", got.toFixed(5), "headline", hv, "want", Math.round(wantYr), "perPt", perPt && perPt[1]); }
}
console.log("combinations checked:", n, "mismatches:", bad);
// sheet cross-check: published rates (additive from list) for the practice/PCN/ICB tier tables
const sheetBase = { practice: [.072,.074,.076,.08,.08], pcn: [.064,.066,.068,.07,.072], icb: [.052,.054,.056,.058,.06] };
let sb = 0; for (const [route, arr] of Object.entries(sheetBase)) arr.forEach((v, i) => { api.set({ speedOn: false, termYrs: 1, billing: "annual", product: "all" }); const r = cfgTiers.find(t => t.route === route && t.tier === i + 1); const g = api.dealRate(r.size_discount, 0, 0); if (Math.abs(g - v) > 5e-4) { sb++; console.log("SHEET BASE MISMATCH", route, i + 1, g, v); } });
console.log("sheet 1-year base mismatches:", sb);
