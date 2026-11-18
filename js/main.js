// Start.
boot();

$("n-new").onclick = hsNewNetwork;

panelizeFilters("s-search", [["s-type", "Signal type"], ["s-status", "Status"]]);
panelizeFilters("n-search", [["n-cust", "Customers"], ["n-tier", "Network price tier"], ["n-multi", "3+ practices only"]]);
panelizeFilters("mg-search", [["mg-status", "Show"], ["mg-conf", "Match strength"]]);
