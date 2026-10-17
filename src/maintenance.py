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
