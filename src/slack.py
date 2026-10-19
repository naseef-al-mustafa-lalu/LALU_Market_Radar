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


def post(text, blocks=None):
    """Raises on failure so the caller can leave signals unsent and try again next run."""
    token, hook = os.environ.get("SLACK_BOT_TOKEN"), os.environ.get("SLACK_WEBHOOK_URL")
    payload = {"text": text, "unfurl_links": False, "unfurl_media": False}
    if blocks:
        payload["blocks"] = blocks
    if token:
        payload["channel"] = os.environ.get("SLACK_CHANNEL") or DEFAULT_CHANNEL
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
