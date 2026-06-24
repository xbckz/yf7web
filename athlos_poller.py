"""
athlos_poller.py — bracket-only, local-disk-only.

Continuously fetches Athlos segment list + per-region bracket snapshots so the
YF7 site's Esports tab can render the live bracket even when the upstream API
is briefly unavailable.

Layout (under data/athlos_cache/):
    segments.json                 ← merged segment list (old entries kept)
    bracket_<segId>.json          ← latest bracket snapshot per region segment

NO match-detail files, NO roster files, NO GCS upload.
"""

import json
import logging
import os
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

log = logging.getLogger("athlos_poller")

# ── Config ────────────────────────────────────────────────────────────────────
BRACKET_INTERVAL  = 15   # seconds between bracket poll cycles
SEGMENT_INTERVAL  = 60   # seconds between segment list refreshes
WORKERS           = 4

ATHLOS_API = "https://bs-api.athlos.gg/api"
ATHLOS_HEADERS = {
    "x-origin":        "supercell/brawlstars/season6",
    "User-Agent":      ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/122.0.0.0 Safari/537.36"),
    "Accept":          "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin":          "https://bs.athlos.gg",
    "Referer":         "https://bs.athlos.gg/",
}

CACHE_DIR = os.path.join(os.path.dirname(__file__), "data", "athlos_cache")


# ── File helpers ──────────────────────────────────────────────────────────────

def _local_path(rel: str) -> str:
    return os.path.join(CACHE_DIR, rel)


def _atomic_write(path: str, data: bytes) -> None:
    os.makedirs(os.path.dirname(path) or CACHE_DIR, exist_ok=True)
    tmp_fd, tmp_path = tempfile.mkstemp(suffix=".tmp",
                                        dir=os.path.dirname(path) or CACHE_DIR)
    try:
        os.close(tmp_fd)
        with open(tmp_path, "wb") as f:
            f.write(data)
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def _save(rel: str, data) -> None:
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        _atomic_write(_local_path(rel),
                      json.dumps(data, ensure_ascii=False).encode("utf-8"))
    except Exception as exc:
        log.debug("save %s: %s", rel, exc)


def _load(rel: str):
    try:
        lp = _local_path(rel)
        if os.path.isfile(lp):
            with open(lp, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception:
        pass
    return None


# ── HTTP ─────────────────────────────────────────────────────────────────────

_req_semaphore = threading.Semaphore(WORKERS)
_sess = requests.Session()
_sess.verify = False


def _athlos(path: str, timeout: int = 15):
    with _req_semaphore:
        r = _sess.get(f"{ATHLOS_API}{path}",
                      headers=ATHLOS_HEADERS, timeout=timeout)
        r.raise_for_status()
        return r.json()


# ── Segment helpers ───────────────────────────────────────────────────────────

def _region_ids(segments: list) -> list:
    """Return all leaf-region segment IDs from a flat segment list."""
    seen, ids = set(), []
    for seg in segments:
        if seg.get("level") == 0:
            for child in seg.get("children") or []:
                cid = child.get("id")
                if cid and cid not in seen:
                    seen.add(cid)
                    ids.append(cid)
    for seg in segments:
        if seg.get("level") == 1:
            sid = seg.get("id")
            if sid and sid not in seen:
                seen.add(sid)
                ids.append(sid)
    return ids


def _merge_segments(new_data: dict, old_data) -> dict:
    """Keep every segment ever seen — old ones survive API pruning."""
    if not (old_data and
            isinstance(old_data.get("data"), list) and
            isinstance(new_data.get("data"), list)):
        return new_data
    existing = {s["id"] for s in new_data["data"] if "id" in s}
    for seg in old_data["data"]:
        if seg.get("id") and seg["id"] not in existing:
            new_data["data"].append(seg)
    return new_data


def _active_region_ids(segments: list) -> tuple[list, list]:
    """Split region IDs into (active, inactive) by lifecycle status."""
    all_ids   = _region_ids(segments)
    seg_by_id = {s.get("id"): s for s in segments if s.get("id")}
    for s in segments:
        if s.get("level") == 0:
            for child in s.get("children") or []:
                cid = child.get("id")
                if cid and cid not in seg_by_id:
                    seg_by_id[cid] = child

    active, inactive = [], []
    for sid in all_ids:
        seg = seg_by_id.get(sid, {})
        lc  = seg.get("lifecycle") or {}
        status = (lc.get("status") or "").lower()
        if status in ("started", "live") and not lc.get("concludedAt"):
            active.append(sid)
        else:
            inactive.append(sid)
    return active, inactive


# ── Bracket fetch ─────────────────────────────────────────────────────────────

def _fetch_bracket(seg_id: str):
    try:
        data = _athlos(f"/matches/1.0/bracket/{seg_id}/match-series")
        _save(f"bracket_{seg_id}.json", data)
        return data
    except Exception as exc:
        log.debug("bracket %s: %s", seg_id, exc)
        return None


_executor = ThreadPoolExecutor(max_workers=WORKERS, thread_name_prefix="ap")

# Athlos uses JSON:API pagination and caps page[size] at 20. The legacy
# `?size=100` parameter is ignored, which leaves newer segments unfetched.
_SEG_PAGE_SIZE = 20
_SEG_MAX_PAGES = 20


def _fetch_all_segments() -> dict:
    """Fetch every segment page and return one merged JSON:API document."""
    first = _athlos(
        f"/events/1.0/segments?page[number]=1&page[size]={_SEG_PAGE_SIZE}"
    )
    data = list(first.get("data") or [])
    last = (((first.get("meta") or {}).get("page") or {}).get("last")) or 1

    for page in range(2, min(int(last), _SEG_MAX_PAGES) + 1):
        try:
            result = _athlos(
                f"/events/1.0/segments?page[number]={page}"
                f"&page[size]={_SEG_PAGE_SIZE}"
            )
            data.extend(result.get("data") or [])
        except Exception as exc:
            log.debug("segments page %d: %s", page, exc)

    merged = dict(first)
    merged["data"] = data
    return merged


INACTIVE_BRACKET_INTERVAL = 300  # 5 min — refresh concluded brackets occasionally

_cycle_state = {
    "segments":            [],
    "last_seg_fetch":      0.0,
    "last_inactive_fetch": 0.0,
}


def _poll_cycle() -> None:
    now = time.monotonic()

    if now - _cycle_state["last_seg_fetch"] >= SEGMENT_INTERVAL:
        try:
            fresh  = _fetch_all_segments()
            merged = _merge_segments(fresh, _load("segments.json"))
            _save("segments.json", merged)
            _cycle_state["segments"]       = merged.get("data") or []
            _cycle_state["last_seg_fetch"] = now
        except Exception as exc:
            log.debug("segments fetch: %s", exc)
            if not _cycle_state["segments"]:
                cached = _load("segments.json")
                _cycle_state["segments"] = (cached or {}).get("data") or []

    active_ids, inactive_ids = _active_region_ids(_cycle_state["segments"])
    if not active_ids and not inactive_ids:
        return

    poll_inactive = (now - _cycle_state["last_inactive_fetch"]
                     >= INACTIVE_BRACKET_INTERVAL)
    ids_to_fetch  = active_ids + (inactive_ids if poll_inactive else [])
    if poll_inactive:
        _cycle_state["last_inactive_fetch"] = now

    futures = {_executor.submit(_fetch_bracket, sid): sid for sid in ids_to_fetch}
    for fut in as_completed(futures, timeout=60):
        try:
            fut.result()
        except Exception as exc:
            log.debug("bracket future: %s", exc)


# ── Background thread ─────────────────────────────────────────────────────────

_stop = threading.Event()
_thread: threading.Thread | None = None


def _loop() -> None:
    log.info("Athlos poller started (bracket=%ss, segments=%ss)",
             BRACKET_INTERVAL, SEGMENT_INTERVAL)
    while not _stop.is_set():
        try:
            t0 = time.monotonic()
            _poll_cycle()
            elapsed = time.monotonic() - t0
        except Exception as exc:
            log.exception("Unhandled poller error: %s", exc)
            elapsed = 0
        wait = max(0, BRACKET_INTERVAL - elapsed) if elapsed < BRACKET_INTERVAL else BRACKET_INTERVAL
        _stop.wait(wait)
    log.info("Athlos poller stopped")


def start() -> None:
    """Start the background poller. Safe to call multiple times."""
    global _thread
    if _thread and _thread.is_alive():
        return
    _stop.clear()
    _thread = threading.Thread(target=_loop, daemon=True, name="athlos-poller")
    _thread.start()


def stop() -> None:
    _stop.set()
    if _thread:
        _thread.join(timeout=BRACKET_INTERVAL + 1)
