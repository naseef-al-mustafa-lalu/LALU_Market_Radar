// Sub tabs as a second row under the main bar. To go back to the old pills inside each page, set SUBNAV_DEFAULT to "inline" (one word), or open the app with ?subnav=inline
// (and ?subnav=bar to return); the last ?subnav= choice is remembered in this browser. Loaded after main.js; moves the existing elements, so nothing else needs to know.
const SUBNAV_DEFAULT = "bar";
const SUBNAVS = { signals: "sig-sub", data: "data-sub" };      // tab -> the sub-tab strip that belongs to it
const subnavHome = new Map();                                    // id -> where the strip lives in "inline" mode
function subnavMode() {
  const q = new URLSearchParams(location.search).get("subnav");
  try { if (q === "bar" || q === "inline") { localStorage.setItem("lalu.subnav", q); return q; } return localStorage.getItem("lalu.subnav") || SUBNAV_DEFAULT; } catch (e) { return q === "inline" ? "inline" : SUBNAV_DEFAULT; }
}
function placeSubnav() {
  const bar = $("subnav"), mode = subnavMode(); let used = false;
  for (const [tab, id] of Object.entries(SUBNAVS)) {
    const el = $(id); if (!el) continue;
    if (!subnavHome.has(id)) subnavHome.set(id, { parent: el.parentNode, next: el.nextSibling });
    if (mode === "bar" && tab === currentTab) { bar.appendChild(el); used = true; }
    else { const h = subnavHome.get(id); if (el.parentNode !== h.parent) h.parent.insertBefore(el, h.next && h.next.parentNode === h.parent ? h.next : null); }
  }
  bar.classList.toggle("hidden", !used);
  if (used) bar.style.top = document.querySelector("#app > nav").offsetHeight + "px";
}
const showTabBeforeSubnav = showTab;
showTab = function (which, fromUrl) { showTabBeforeSubnav(which, fromUrl); placeSubnav(); };      // eslint-disable-line no-func-assign
window.addEventListener("resize", () => { if (!$("subnav").classList.contains("hidden")) placeSubnav(); });
