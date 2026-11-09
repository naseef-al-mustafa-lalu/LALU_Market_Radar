// Start.
boot();

$("n-new").onclick = hsNewNetwork;

panelizeFilters("s-search", [["s-type", "Signal type"], ["s-status", "Status"]]);
panelizeFilters("n-search", [["n-sort", "Sort by"], ["n-multi", "3+ practices only"]]);
panelizeFilters("mg-search", [["mg-status", "Show"], ["mg-conf", "Match strength"]]);
