"""Is a contact's email a direct address for a decision-maker? Used for the HubSpot contact export (js/contact-import.js is the browser twin of this file: keep them in step)
and for new Oscar contacts, which are added only after the same check."""
import re

GEN_START = re.compile(r"^(enquir|info|admin|reception|contact|office|practice|manager|secretar|appointment|hello|test|noreply|no-reply|team|general|help|booking|dispensary|prescription|referral|complaint|feedback|patient|surgery|medical|health|clinic|nursing|front|desk|hr|finance|accounts|pcn|gp|enq|mail|post|duty|triage|admissions|records|wecare|care)", re.I)
GEN_ANY = re.compile(r"(surgery|medical|practice|centre|center|health|clinic|reception|admin|enquir|team|office|partnership|dispens|appointment|secretar|manager|pcn|nhs|icb|ccg|group|mailbox|shared)", re.I)
ODS_IN_ADDRESS = re.compile(r"(^|[._-])[a-z]\d{5}($|[._-])", re.I)
MAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
EXCLUDE_ROLE = re.compile(r"nurse|anp\b|practitioner|paramedic|pharmac|physio|health ?care assistant|hca|phlebot|receptionist|reception(?!\s*manager)|secretar|clerk|summar|coder|dispens|care coordinator|salaried|locum|registrar|trainee|student|apprentice|dropped on|gp staff|other practice staff|administrator$|^admin$|^administrator", re.I)
TIER_A = re.compile(r"practice\s*/?\s*(business\s*)?manager|business\s*/?\s*practice\s*manager|general\s*(practice\s*)?manager|business manager|operations? manager|operational manager|practice director|managing director|executive manager|office manager|^manager$|group practice manager|joint practice manager|senior partner|managing partner|management partner|gp partner|partner|^practice\s*manager", re.I)
TIER_B = re.compile(r"deputy|assistant (practice )?manager|assistant manager|finance|hr manager|human resources|pcn (clinical )?director|pcn manager|clinical director|digital|transformation|patient services manager|administration manager|reception manager|business partner|head of|lead$", re.I)
ROLE_FIELD_A = {"Practice Manager", "Senior Partner / Managing Partner", "GP Partner", "Business Manager", "Operations Manager", "PCN Clinical Director"}
SUPPRESSING_BOUNCES = {"Unknown user", "Other", "Policy"}


def _letters(s):
    return re.sub(r"[^a-z]", "", (s or "").lower())


def email_quality(email, first="", last=""):
    """(quality, reason). quality: direct | likely_direct | shared | check | reject | invalid | no_email."""
    e = (email or "").strip().lower()
    if not e:
        return "no_email", "no email"
    if not MAIL.match(e):
        return "invalid", "bad syntax"
    loc = e.split("@")[0]
    f, l, ll = _letters(first), _letters(last), _letters(re.sub(r"\d+", "", loc))
    if ll == "test":
        return "reject", "test address"
    f_in, l_in = bool(f) and len(f) > 1 and f in ll, bool(l) and len(l) > 2 and l in ll
    if (f_in and l_in) or (f and l and ll.startswith(f[0]) and l in ll):
        return "direct", "name in address"
    if ODS_IN_ADDRESS.search(loc) or GEN_START.match(loc) or GEN_ANY.search(re.sub(r"\d+", "", loc)):
        return "shared", "generic or shared mailbox pattern"
    if f_in or l_in:
        return "likely_direct", "part of the name is in the address"
    plain = re.sub(r"\d+", "", loc)
    if re.fullmatch(r"[a-z]+[._][a-z]+", plain):
        return ("check", "personal-style address, name differs") if f and l else ("likely_direct", "personal-style address, no name on record")
    return "check", "unclear"


def role_tier(title, role=""):
    """(tier, reason). A: decision-maker; B: secondary decision-maker; ?: unclear (usually a blank title); x: not a decision-maker."""
    t, r = (title or "").strip(), (role or "").strip()
    if "dropped on" in t.lower():
        return "x", "dropped"
    if re.search(r"deputy|assistant", t, re.I) and TIER_B.search(t):
        return "B", "secondary decision-maker"
    if (TIER_A.search(t) or (not t and TIER_A.search(r))) and not re.search(r"nurse|anp|practitioner", t, re.I):
        return "A", "decision-maker"
    if TIER_B.search(t) or (not t and TIER_B.search(r)):
        return "B", "secondary decision-maker"
    if EXCLUDE_ROLE.search(f"{t} | {r}"):
        return "x", "not a decision-maker"
    if not t and r in ROLE_FIELD_A:
        return "A", "role field"
    return "?", "unclear role"


def suggest(quality, tier, has_practice=True, opted_out=False, bounce=""):
    """(status, reason) for the staging table: approved | review | generic | rejected | suppressed."""
    if opted_out or bounce in SUPPRESSING_BOUNCES:
        return "suppressed", "opted out" if opted_out else "email bounced"
    if not has_practice:
        return "rejected", "no matching practice in Atlas"
    if quality in ("no_email", "invalid", "reject"):
        return "rejected", {"no_email": "no email", "invalid": "bad email syntax", "reject": "test address"}[quality]
    if quality == "shared":
        return "generic", "shared mailbox: kept as the practice's generic address"
    if tier == "x":
        return "rejected", "not a decision-maker"
    if quality == "direct" and tier == "A":
        return "approved", "direct address, decision-maker"
    return "review", "needs a person to check " + ("the role" if quality == "direct" else "the address" if tier in ("A", "B") else "address and role")
