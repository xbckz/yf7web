"""Fetch the latest tweets for YF7_TWITTER_HANDLE from Twitter's public
syndication endpoint and POST them to the YF7 server.

Run from GitHub Actions (see tweets.yml). Env vars:
    YF7_TWITTER_HANDLE     handle without @ (default: YF7Tournaments)
    YF7_TWEETS_ENDPOINT    https://your-domain/api/tweets/refresh
    YF7_TWEETS_TOKEN       shared secret matching the server's env var
"""
import json
import os
import re
import sys
from html import unescape

import requests

HANDLE   = os.environ.get("YF7_TWITTER_HANDLE", "YF7Tournaments")
ENDPOINT = os.environ["YF7_TWEETS_ENDPOINT"]
TOKEN    = os.environ["YF7_TWEETS_TOKEN"]

SYND_URL = (
    "https://syndication.twitter.com/srv/timeline-profile/screen-name/"
    f"{HANDLE}?showReplies=false"
)

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")


def fetch_syndication() -> dict:
    r = requests.get(SYND_URL, headers={"User-Agent": UA}, timeout=20)
    r.raise_for_status()
    m = re.search(
        r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>',
        r.text, flags=re.DOTALL,
    )
    if not m:
        raise RuntimeError("could not find __NEXT_DATA__ in response")
    return json.loads(m.group(1))


def extract_tweets(next_data: dict) -> list[dict]:
    page = (next_data.get("props") or {}).get("pageProps") or {}
    entries = (
        (page.get("timeline") or {}).get("entries")
        or page.get("contextProvider", {}).get("contextHydrator", {}).get(
            "hydrationData", {}).get("tweets")
        or []
    )

    raw_tweets = []
    if isinstance(entries, dict):
        raw_tweets = list(entries.values())
    elif entries and isinstance(entries[0], dict) and "tweet" in entries[0]:
        raw_tweets = [e["tweet"] for e in entries if e.get("tweet")]
    else:
        raw_tweets = entries

    items = []
    for t in raw_tweets:
        if not isinstance(t, dict):
            continue
        tid    = str(t.get("id_str") or t.get("id") or "")
        text   = t.get("full_text") or t.get("text") or ""
        author = (t.get("user") or {}).get("screen_name") or HANDLE
        date   = t.get("created_at") or ""
        is_rt  = bool(t.get("retweeted_status") or t.get("retweeted_status_result"))

        images = []
        for m in ((t.get("entities") or {}).get("media") or []):
            u = m.get("media_url_https") or m.get("media_url")
            if u:
                images.append(u)
        for m in ((t.get("extended_entities") or {}).get("media") or []):
            u = m.get("media_url_https") or m.get("media_url")
            if u and u not in images:
                images.append(u)

        # Strip t.co media URLs from the visible text (they're junk).
        urls = (t.get("entities") or {}).get("urls") or []
        for u in urls:
            short = u.get("url")
            expanded = u.get("expanded_url") or ""
            if short and expanded:
                text = text.replace(short, expanded)

        link = f"https://x.com/{author}/status/{tid}" if tid else f"https://x.com/{author}"
        items.append({
            "id":         tid,
            "text":       unescape(text).strip(),
            "html":       "",
            "link":       link,
            "date":       date,
            "author":     f"@{author}",
            "is_retweet": is_rt,
            "images":     images,
        })
    return items


def main() -> int:
    data = fetch_syndication()
    items = extract_tweets(data)
    if not items:
        print("no tweets parsed — aborting (refusing to wipe cache)", file=sys.stderr)
        return 1
    print(f"parsed {len(items)} tweets, posting to {ENDPOINT}")
    r = requests.post(
        ENDPOINT,
        headers={"Authorization": f"Bearer {TOKEN}"},
        json={"items": items, "source": "syndication.twitter.com"},
        timeout=20,
    )
    print(f"server replied {r.status_code}: {r.text[:200]}")
    r.raise_for_status()
    return 0


if __name__ == "__main__":
    sys.exit(main())
