"""Name matching shared by the signal matchers (NHS Jobs employers -> practice or network, ODS branch records -> practice).

One place for the rules, so changing what counts as "the same name" changes it everywhere. (HubSpot's audit keeps its own, stricter
name-and-postcode test in hubspot_sync.py: it flags differences, where these rules decide links.)
  * exact: the names are identical once case, punctuation and "&"/"and" are ignored;
  * similar: the distinctive words of one name (ignoring GENERIC ones such as Medical, Centre, Surgery, Practice, Limited) are all in the other,
    e.g. "Tower Hill Partnership Medical Practice" / "Tower Hill Partnership", "Ash Grove Medical Centre" / "Ash Grove".
A match is only ever taken when exactly one candidate fits, and candidates are already limited to the same address.
"""
import re

GENERIC = {"the", "and", "of", "medical", "centre", "center", "centres", "practice", "surgery", "health", "group", "clinic", "care", "partnership", "gp", "general",
           "primary", "house", "services", "service", "surgeries", "practices", "limited", "ltd", "llp", "cic", "dr", "drs", "doctors", "family", "branch", "site", "street", "road"}
NETWORK_WORDS = {"pcn", "network", "federation", "collaborative", "alliance", "nhs", "company"}   # on top of GENERIC, ignored when comparing network names


def words(s):
    return re.findall(r"[a-z0-9]+", str(s or "").lower().replace("&", " and ").replace("'", "").replace("’", ""))


def squash(s):
    """The whole name as one lowercase run of letters and digits: the key for an exact match."""
    return "".join(words(s))


def distinct(s, extra=()):
    return {w for w in words(s) if w not in GENERIC and w not in extra}


def best_name(cands, name, extra=()):
    """The one candidate whose name matches `name`: ('exact'|'similar', candidate), or (None, None) when none or several do.
    Candidates are dicts with a "name". `extra` adds words to ignore (see NETWORK_WORDS)."""
    exact = [c for c in cands if squash(c["name"]) == squash(name)]
    if len(exact) == 1:
        return "exact", exact[0]
    if exact:
        return None, None
    mine = distinct(name, extra)
    similar = [c for c in cands if mine and distinct(c["name"], extra) and (mine <= distinct(c["name"], extra) or distinct(c["name"], extra) <= mine)]
    return ("similar", similar[0]) if len(similar) == 1 else (None, None)
