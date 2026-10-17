"""Housekeeping that runs with the daily load. Each step is narrow, bounded and idempotent."""
MAX_DELETE = 1000


def purge_never_loaded_closed(rest):
    """Delete closed Welsh rows that never carried any data (created when a cluster file listed branch sites that are not practices).
    Narrow on purpose: closed + Wales + no list size + no data month. Their graph nodes go with them."""
    junk = [r["ods_code"] for r in rest.select_all("gp_practices", "ods_code", order="ods_code",
                                                    params={"status": "eq.Closed", "country": "eq.Wales", "total_patients": "eq.0", "data_month": "is.null"})]
    if not junk:
        return 0
    if len(junk) > MAX_DELETE:
        raise RuntimeError(f"refusing to delete {len(junk)} rows in one run")
    rest.delete_in("organisations", "ods_code", junk)       # graph nodes (their links cascade)
    rest.delete_in("gp_practices", "ods_code", junk)        # contacts and signals cascade
    return len(junk)


def prune_closed_practice_nodes(rest):
    """Graph nodes of practices that are closed or gone. refresh_org_graph() only creates nodes for active practices;
    this removes the ones left behind when a practice closes (their links go with them)."""
    active = {r["ods_code"] for r in rest.select_all("gp_practices", "ods_code", order="ods_code", params={"status": "eq.Active"})}
    stale = [o["id"] for o in rest.select_all("organisations", "id,ods_code", order="id", params={"kind": "eq.practice"}) if o["ods_code"] not in active]
    if len(stale) > MAX_DELETE:
        raise RuntimeError(f"refusing to delete {len(stale)} graph nodes in one run")
    rest.delete_in("organisations", "id", stale, extra={"kind": "eq.practice"})
    return len(stale)
