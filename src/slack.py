"""Post to Slack: an incoming webhook (the channel is fixed when the webhook is created) or a bot token + channel."""
import os
import sys
import time

import requests

DEFAULT_CHANNEL = "lalu_market_radar"


def configured():
    return bool(os.environ.get("SLACK_BOT_TOKEN") or os.environ.get("SLACK_WEBHOOK_URL"))


def mrkdwn(s):
    """Slack treats & < > as control characters in message text."""
    return str(s if s is not None else "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def link(url, label):
    """<url|label> for a safe http(s) url, else just the label."""
    url = url or ""
    ok = url.startswith(("http://", "https://")) and not any(c in url for c in "<>| \n")
    return f"<{url}|{mrkdwn(label)}>" if ok else mrkdwn(label)


ATLAS_CHANNEL = "lalu_atlas"


def atlas_configured():
    """Atlas's own alerts (new contacts in an audience, NeverBounce batches and results) go to #lalu_atlas: a bot token reaches it by channel name, a webhook is tied to its channel (SLACK_ATLAS_WEBHOOK_URL)."""
    return bool(os.environ.get("SLACK_BOT_TOKEN") or os.environ.get("SLACK_ATLAS_WEBHOOK_URL"))


def post_atlas(text, blocks=None):
    """Post to #lalu_atlas. Raises on failure."""
    post(text, blocks, channel=os.environ.get("SLACK_ATLAS_CHANNEL") or ATLAS_CHANNEL, hook=os.environ.get("SLACK_ATLAS_WEBHOOK_URL"))


def post(text, blocks=None, channel=None, hook=None):
    """Raises on failure so the caller can leave signals unsent and try again next run. channel / hook override the signals channel (used by post_atlas)."""
    token, hook = os.environ.get("SLACK_BOT_TOKEN"), hook or os.environ.get("SLACK_WEBHOOK_URL")   # a bot token wins over a webhook, as before
    payload = {"text": text, "unfurl_links": False, "unfurl_media": False}
    if blocks:
        payload["blocks"] = blocks
    if token:
        payload["channel"] = channel or os.environ.get("SLACK_CHANNEL") or DEFAULT_CHANNEL
        r = requests.post("https://slack.com/api/chat.postMessage", json=payload, timeout=30, headers={"Authorization": f"Bearer {token}"})
        data = r.json() if r.ok else {}
        if not r.ok or not data.get("ok"):
            raise RuntimeError(f"Slack rejected the message: {data.get('error') or r.status_code}")
    elif hook:
        r = requests.post(hook, json=payload, timeout=30)
        if r.status_code != 200 or r.text.strip() != "ok":
            raise RuntimeError(f"Slack rejected the message: {r.status_code} {r.text[:200]}")
    else:
        raise RuntimeError("Slack is not configured: set SLACK_WEBHOOK_URL (or SLACK_BOT_TOKEN and SLACK_CHANNEL)")
    time.sleep(1.1)   # webhooks allow about one message a second


def alert(title, body):
    """Best-effort failure notice; never raises."""
    if not configured():
        print(f"{title}\n{body}", file=sys.stderr)
        return
    try:
        post(f":warning: *{mrkdwn(title)}*\n```{mrkdwn(body)[:2500]}```")
    except Exception as e:  # noqa: BLE001
        print(f"Slack alert failed: {e}", file=sys.stderr)


def list_channels(get=requests.get, token=None):
    """The channels the bot is a member of (it can post there): [{id, name, is_private}]. Needs the channels:read and groups:read scopes; raises with Slack's reason when it cannot list."""
    token = token or os.environ.get("SLACK_BOT_TOKEN")
    if not token:
        raise RuntimeError("SLACK_BOT_TOKEN is not set: channels can only be listed with a bot token")
    out, cursor = [], None
    while True:
        d = get("https://slack.com/api/conversations.list", params={"types": "public_channel,private_channel", "exclude_archived": "true", "limit": 200, **({"cursor": cursor} if cursor else {})},
                headers={"Authorization": f"Bearer {token}"}, timeout=30).json()
        if not d.get("ok"):
            raise RuntimeError(f"Slack could not list channels: {d.get('error')}")
        out += [{"id": c["id"], "name": c["name"], "is_private": bool(c.get("is_private"))} for c in d.get("channels", []) if c.get("is_member")]
        cursor = (d.get("response_metadata") or {}).get("next_cursor")
        if not cursor:
            return out


def sync_channels(rest, get=requests.get, token=None):
    """Keep public.slack_channels equal to the channels the bot is in now (new connections appear, removed ones go). Returns the count."""
    rows = list_channels(get, token)
    if rows:
        rest.upsert("slack_channels", rows, "id")
    have = {r["id"] for r in rest.select_all("slack_channels", "id", order="id")}
    stale = sorted(have - {r["id"] for r in rows})
    if stale:
        rest.delete_in("slack_channels", "id", stale)
    return len(rows)
