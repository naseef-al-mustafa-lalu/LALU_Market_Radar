"""Which GP practice does an ODS branch-surgery record (role RO96) belong to?

ODS records who operates each branch (relationship RE6). When that is a GP practice we hold, the record is a real branch of it: a 9-character code is that
practice's own code plus a 3-digit suffix (M85624001 belongs to M85624), and a 5-character code can be one too. When the operator is not a GP practice
we hold (South Doc Virtual Services, an urgent-care provider, a PCN), the record is a listing that often repeats a practice or real branch we already
hold, or is a building or a non-GP site.
`resolve` sorts every record into one of: branch, duplicate_branch, duplicate_practice, hosted, shared, other, and says how sure it is.
Pure functions: no I/O. A person's confirm / reject decision is kept while the situation it was made about is unchanged.
"""
import re

from .matching import best_name

RESOLUTIONS = ("branch", "duplicate_branch", "duplicate_practice", "hosted", "shared", "other")


def norm_postcode(s):
    return re.sub(r"\s+", "", str(s or "").upper())


EAS = re.compile(r"\bpcn\b.*\beas\b|enhanced access", re.I)     # a PCN's Enhanced Access Service listing a site


def _res(resolution, practice_code=None, matched=None, status="auto", note=""):
    return {"resolution": resolution, "practice_code": practice_code, "matched_branch_code": matched, "match_status": status, "match_note": note}


def resolve(rows, pool, prior=None):
    """rows {branch code: row}; pool {ods: {name, postcode}} of the active practices we hold; prior {branch code: stored row} (for kept decisions).
    Returns {branch code: {resolution, practice_code, matched_branch_code, match_status, match_note}}."""
    prior = prior or {}
    practices_at = {}
    for ods, p in pool.items():
        practices_at.setdefault(norm_postcode(p.get("postcode")), []).append({"code": ods, "name": p.get("name") or p.get("practice_name") or ""})
    real = {}                                                   # postcode -> real branches (operated by a practice we hold)
    for c, r in rows.items():
        if r.get("parent_code") in pool and r.get("status", "Active") == "Active":
            real.setdefault(norm_postcode(r.get("postcode")), []).append({"code": c, "name": r.get("branch_name") or "", "parent": r["parent_code"]})
    out = {}
    for c, r in rows.items():
        name, post, parent = r.get("branch_name") or "", norm_postcode(r.get("postcode")), r.get("parent_code")
        if parent in pool:
            res = _res("branch", parent, None, "auto", "A branch of the practice that ODS says operates it")
        else:
            twins = [t for t in real.get(post, []) if t["code"] != c]
            how, hit = best_name(twins, name)
            if hit:
                res = _res("duplicate_branch", hit["parent"], hit["code"], "auto" if how == "exact" else "probable", f"Same site as branch {hit['code']} ({hit['name']})")
            elif len(twins) == 1 and post:
                res = _res("duplicate_branch", twins[0]["parent"], twins[0]["code"], "probable", f"Same address as branch {twins[0]['code']} ({twins[0]['name']})")
            else:
                cands = practices_at.get(post, []) if post else []
                how, hit = best_name(cands, name)
                if hit:
                    res = _res("duplicate_practice", hit["code"], None, "auto" if how == "exact" else "probable", f"Same practice as {hit['code']} ({hit['name']})")
                elif len(cands) == 1:
                    res = _res("hosted", cands[0]["code"], None, "review", f"A different name at the address of {cands[0]['code']} ({cands[0]['name']}): a building it uses, or a rename")
                elif cands:
                    res = _res("shared", None, None, "auto", "A building shared by " + ", ".join(sorted(x["name"] for x in cands)[:4]) + (" and others" if len(cands) > 4 else ""))
                else:
                    res = _res("other", None, None, "auto", "No GP practice at this address")
        if EAS.search(r.get("parent_name") or "") and res["resolution"] in ("duplicate_practice", "duplicate_branch", "hosted"):
            res["match_note"] = f"{r.get('parent_name')} is a PCN enhanced-access service: this is its listing of a site at the address of " + res["match_note"].split(" as ")[-1].replace("Same practice as ", "")
        old = prior.get(c) or {}
        if old.get("match_status") in ("confirmed", "rejected") and old.get("resolution") == res["resolution"] and old.get("practice_code") == res["practice_code"]:
            res["match_status"] = old["match_status"]          # a decision made about this very match stands
        out[c] = res
    return out
