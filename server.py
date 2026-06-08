"""
YF7 Tournaments — Python backend (Flask + SQLite).

Run:
    pip install -r requirements.txt
    python server.py

Then open: http://localhost:5000
Admin credentials are read from `admin.txt` (single line: username:password).
"""
import os
import re
import hmac
import html
import sqlite3
import secrets
import random
import json
import base64
import threading
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from functools import wraps
from pathlib import Path
from urllib.parse import urlparse

import requests
try:
    from curl_cffi import requests as cffi_requests  # browser TLS fingerprint
    HAS_CURL_CFFI = True
except ImportError:
    HAS_CURL_CFFI = False
from flask import (
    Flask, request, jsonify, send_from_directory, session, g, abort
)
from flask_cors import CORS

MATCHERINO_BOUNTY_URL = "https://api.matcherino.com/__api/bounties/findById"
MATCHERINO_TOTAL_SPENT_URL = "https://api.matcherino.com/__api/bounties/totalSpent"
MATCHERINO_PRIZE_POOL_SHARE = Decimal("0.75")
MATCHERINO_CACHE_TTL = 60 * 60
_matcherino_cache = {}
_matcherino_lock = threading.Lock()

# X (Twitter) handle to fetch tweets for. Settable via env var.
TWITTER_HANDLE = os.environ.get("YF7_TWITTER_HANDLE", "YF7Tournaments")

# Nitter mirrors. They go up and down constantly — we try them in order and
# cache the first success. Add more as you find them (see status.d420.de).
NITTER_INSTANCES = [
    "https://xcancel.com",
    "https://nitter.poast.org",
    "https://nitter.privacydev.net",
    "https://nitter.net",
    "https://nitter.tiekoetter.com",
    "https://nitter.kavin.rocks",
]
TWEETS_CACHE_TTL = 12 * 60 * 60  # 12 hours
_tweets_cache = {"items": [], "ts": 0.0, "source": None}
_tweets_lock = threading.Lock()

# Shared secret for /api/tweets/refresh — set in env on the VM AND as a GitHub
# Actions secret so the cron workflow can push fresh tweets.
TWEETS_REFRESH_TOKEN = os.environ.get("YF7_TWEETS_TOKEN", "")
TWEETS_CACHE_FILE = Path(__file__).parent / "data" / "tweets_cache.json"

BASE_DIR = Path(__file__).parent.resolve()
DB_PATH = BASE_DIR / "yf7.db"
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

# Admin credentials are read from a local file `admin.txt` next to server.py.
# Format: a single line "username:password" (no quotes, no spaces around the
# colon). The file is gitignored so it never leaves your machine.
ADMIN_FILE = Path(__file__).parent / "admin.txt"
try:
    _raw = ADMIN_FILE.read_text(encoding="utf-8").strip().splitlines()[0]
    ADMIN_EMAIL, ADMIN_PASSWORD = _raw.split(":", 1)
    ADMIN_EMAIL    = ADMIN_EMAIL.strip()
    ADMIN_PASSWORD = ADMIN_PASSWORD.strip()
    if not ADMIN_EMAIL or not ADMIN_PASSWORD:
        raise ValueError("empty username or password")
except FileNotFoundError:
    raise SystemExit(
        f"FATAL: missing admin credentials file at {ADMIN_FILE}. "
        f"Create it with one line: username:password"
    )
except Exception as _e:
    raise SystemExit(
        f"FATAL: could not parse {ADMIN_FILE} ({_e}). "
        f"Expected a single line in the form: username:password"
    )
TOURNAMENT_REGIONS = {"EMEA", "North America", "South America", "East Asia"}
BRACKET_REGIONS = {"emea", "northamerica", "southamerica", "eastasia"}

app = Flask(__name__, static_folder=None)
app.secret_key = os.environ.get("YF7_SECRET_KEY", secrets.token_hex(32))
app.config["MAX_CONTENT_LENGTH"] = 8 * 1024 * 1024  # 8 MB uploads
# Harden session cookie. SameSite=Lax blocks cross-site POSTs from carrying
# the cookie (CSRF mitigation); HttpOnly prevents JS access. Secure is set
# automatically when running behind HTTPS (assumed in production).
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("YF7_COOKIE_SECURE", "0") == "1",
    SESSION_COOKIE_NAME="yf7_sess",
)
# CORS without credentials by default; the admin SPA is same-origin so we
# don't need to allow cookies on cross-origin requests.
CORS(app, supports_credentials=False)

# ---------- DB ----------

def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(_):
    db = g.pop("db", None)
    if db is not None:
        db.close()


SCHEMA = """
CREATE TABLE IF NOT EXISTS tournaments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    date TEXT,
    prize TEXT,
    region TEXT,
    link TEXT,
    image TEXT,
    description TEXT,
    status TEXT DEFAULT 'auto',
    matcherino_id INTEGER UNIQUE,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS news (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    category TEXT,
    content TEXT,
    image TEXT,
    date TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS winning (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,            -- 'player' or 'team'
    name TEXT NOT NULL,
    wins INTEGER DEFAULT 0,
    earnings INTEGER DEFAULT 0,
    avatar TEXT,
    matcherino_id INTEGER
);
CREATE TABLE IF NOT EXISTS esports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    region TEXT NOT NULL,
    name TEXT NOT NULL,
    points INTEGER DEFAULT 0,
    flag TEXT
);
CREATE TABLE IF NOT EXISTS brackets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    region TEXT NOT NULL,
    type TEXT NOT NULL,            -- 'mq' or 'mf'
    image TEXT,
    link TEXT,
    label TEXT
);
CREATE TABLE IF NOT EXISTS staff (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    role TEXT,
    pfp TEXT,
    description TEXT,
    discord TEXT,
    x_url TEXT,
    sort_order INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS partners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT,
    logo TEXT
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);
CREATE TABLE IF NOT EXISTS tickets (
    code TEXT PRIMARY KEY,
    name TEXT,
    discord TEXT,
    subject TEXT,
    status TEXT DEFAULT 'open',
    date TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ticket_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_code TEXT NOT NULL,
    author TEXT NOT NULL,          -- 'user' or 'admin'
    author_name TEXT,
    text TEXT,
    date TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (ticket_code) REFERENCES tickets(code) ON DELETE CASCADE
);
"""


def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(SCHEMA)
    # lightweight migrations for existing DBs
    cols = [r[1] for r in conn.execute("PRAGMA table_info(tournaments)").fetchall()]
    if "matcherino_id" not in cols:
        conn.execute("ALTER TABLE tournaments ADD COLUMN matcherino_id INTEGER")
    winning_cols = [r[1] for r in conn.execute("PRAGMA table_info(winning)").fetchall()]
    if "matcherino_id" not in winning_cols:
        conn.execute("ALTER TABLE winning ADD COLUMN matcherino_id INTEGER")
    staff_cols = [r[1] for r in conn.execute("PRAGMA table_info(staff)").fetchall()]
    if "discord" not in staff_cols:
        conn.execute("ALTER TABLE staff ADD COLUMN discord TEXT")
    if "x_url" not in staff_cols:
        conn.execute("ALTER TABLE staff ADD COLUMN x_url TEXT")
    conn.execute(
        """UPDATE tournaments SET region='EMEA'
           WHERE region IS NULL
              OR region NOT IN ('EMEA','North America','South America','East Asia')"""
    )
    conn.execute(
        """UPDATE brackets
              SET region = CASE region
                  WHEN 'eu' THEN 'emea'
                  WHEN 'na' THEN 'northamerica'
                  WHEN 'latam' THEN 'southamerica'
                  WHEN 'asia' THEN 'eastasia'
                  WHEN 'mena' THEN 'emea'
                  ELSE region
              END"""
    )
    conn.execute(
        """UPDATE brackets SET region='emea'
           WHERE region IS NULL
              OR region NOT IN ('emea','northamerica','southamerica','eastasia')"""
    )
    conn.execute("UPDATE winning SET type='team' WHERE type='card'")
    # seed default about description if missing
    cur = conn.execute("SELECT value FROM settings WHERE key='about'")
    if cur.fetchone() is None:
        conn.execute(
            "INSERT INTO settings(key, value) VALUES(?, ?)",
            ("about",
             "YF7 Tournaments is a competitive Brawl Stars organization "
             "running regular tournaments across every region. Our mission: "
             "professional events, real prizes, and a community where players "
             "can prove their skill.")
        )
    cur = conn.execute("SELECT value FROM settings WHERE key='discord'")
    if cur.fetchone() is None:
        conn.execute("INSERT INTO settings(key, value) VALUES(?, ?)",
                     ("discord", "https://discord.gg/jWfZdcDftr"))
    conn.commit()
    conn.close()


init_db()


# ---------- helpers ----------

def row_to_dict(row):
    return {k: row[k] for k in row.keys()} if row else None


def require_admin(f):
    @wraps(f)
    def wrapper(*a, **kw):
        if not session.get("admin"):
            return jsonify({"error": "unauthorized"}), 401
        return f(*a, **kw)
    return wrapper


def parse_json():
    data = request.get_json(silent=True) or {}
    return data


# ---------- static / index ----------

@app.route("/")
@app.route("/admin")
def index():
    # Both / and /admin serve the SPA; JS reads window.location and shows
    # the right page on load (admin needs to log in regardless).
    return send_from_directory(BASE_DIR, "index.html")


@app.route("/<path:path>")
def static_files(path):
    # serve any file in project root (index.css, index.js, logo, etc.)
    # restrict to existing files to avoid path escapes
    candidate = (BASE_DIR / path).resolve()
    if not str(candidate).startswith(str(BASE_DIR)):
        abort(404)
    if candidate.is_file():
        resp = send_from_directory(BASE_DIR, path)
        if path in ("index.css", "index.js"):
            resp.headers["Cache-Control"] = "no-cache, must-revalidate"
        return resp
    abort(404)


@app.route("/uploads/<path:fname>")
def uploads(fname):
    return send_from_directory(UPLOAD_DIR, fname)


# ---------- auth ----------

# Brute-force throttle. Per-client (remote IP), in-memory.
# After LOGIN_MAX_TRIES failures in LOGIN_WINDOW seconds, lock out for
# LOGIN_LOCKOUT seconds. Counters reset on success.
LOGIN_MAX_TRIES = 5
LOGIN_WINDOW    = 5 * 60
LOGIN_LOCKOUT   = 15 * 60
_login_attempts = {}     # ip -> [list of failed-attempt timestamps]
_login_lock     = threading.Lock()


def _login_client_id():
    # Honor X-Forwarded-For only when explicitly configured to trust proxies.
    if os.environ.get("YF7_TRUST_PROXY") == "1":
        fwd = request.headers.get("X-Forwarded-For", "")
        if fwd:
            return fwd.split(",")[0].strip()
    return request.remote_addr or "unknown"


def _login_locked_seconds(ip):
    """Return >0 seconds remaining if this IP is locked out, else 0."""
    now = time.time()
    with _login_lock:
        attempts = [t for t in _login_attempts.get(ip, []) if now - t < LOGIN_WINDOW]
        _login_attempts[ip] = attempts
        if len(attempts) >= LOGIN_MAX_TRIES:
            wait = LOGIN_LOCKOUT - (now - attempts[-LOGIN_MAX_TRIES])
            if wait > 0:
                return int(wait) + 1
    return 0


def _login_record_failure(ip):
    with _login_lock:
        _login_attempts.setdefault(ip, []).append(time.time())


def _login_reset(ip):
    with _login_lock:
        _login_attempts.pop(ip, None)


@app.post("/api/admin/login")
def admin_login():
    ip = _login_client_id()
    wait = _login_locked_seconds(ip)
    if wait:
        return jsonify({"error": "too many attempts, try again later"}), 429

    data = parse_json()
    email = str(data.get("email") or "")
    password = str(data.get("password") or "")

    # Constant-time comparison on both fields, no short-circuit on email.
    email_ok = hmac.compare_digest(email.encode("utf-8"),
                                   ADMIN_EMAIL.encode("utf-8"))
    pw_ok    = hmac.compare_digest(password.encode("utf-8"),
                                   ADMIN_PASSWORD.encode("utf-8"))
    if email_ok and pw_ok:
        _login_reset(ip)
        session.clear()
        session["admin"] = True
        session.permanent = True
        return jsonify({"ok": True})

    _login_record_failure(ip)
    return jsonify({"error": "invalid credentials"}), 401


@app.post("/api/admin/logout")
def admin_logout():
    session.pop("admin", None)
    return jsonify({"ok": True})


@app.get("/api/admin/me")
def admin_me():
    return jsonify({"admin": bool(session.get("admin"))})


# ---------- upload ----------

@app.post("/api/upload")
@require_admin
def upload():
    """Accept either multipart 'file' or JSON {data: base64, filename: str}."""
    if "file" in request.files:
        f = request.files["file"]
        name = secrets.token_hex(8) + "_" + Path(f.filename).name
        path = UPLOAD_DIR / name
        f.save(path)
        return jsonify({"url": f"/uploads/{name}"})
    data = parse_json()
    raw = data.get("data", "")
    fname = data.get("filename", "upload.bin")
    if "," in raw:
        raw = raw.split(",", 1)[1]
    try:
        blob = base64.b64decode(raw)
    except Exception:
        return jsonify({"error": "bad base64"}), 400
    name = secrets.token_hex(8) + "_" + Path(fname).name
    (UPLOAD_DIR / name).write_bytes(blob)
    return jsonify({"url": f"/uploads/{name}"})


# ---------- tournaments ----------

def tournament_status(t):
    if t["status"] and t["status"] != "auto":
        return t["status"]
    if not t["date"]:
        return "upcoming"
    try:
        # Accept both "2025-01-15T18:00:00Z" and "2025-01-15T18:00:00+00:00".
        raw = t["date"].replace("Z", "+00:00") if isinstance(t["date"], str) else t["date"]
        d = datetime.fromisoformat(raw)
    except Exception:
        return "upcoming"
    # Make naive timestamps (from manual entry / datetime-local input) UTC.
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    now = datetime.now(timezone.utc)
    delta = (now - d).total_seconds()
    if delta < -3600:
        return "upcoming"
    if delta < 6 * 3600:
        return "live"
    return "past"


def tournament_sort_key(t):
    """Show live events first, then nearest upcoming, then recent finished."""
    status = t.get("computed_status") or tournament_status(t)
    status_order = {"live": 0, "upcoming": 1, "past": 2}
    try:
        raw = t.get("date")
        raw = raw.replace("Z", "+00:00") if isinstance(raw, str) else raw
        event_date = datetime.fromisoformat(raw)
        if event_date.tzinfo is None:
            event_date = event_date.replace(tzinfo=timezone.utc)
        timestamp = event_date.timestamp()
    except Exception:
        timestamp = float("inf")
    if status == "past" and timestamp != float("inf"):
        timestamp = -timestamp
    return (status_order.get(status, 3), timestamp, t.get("id") or 0)


@app.get("/api/tournaments")
def list_tournaments():
    db = get_db()
    rows = db.execute("SELECT * FROM tournaments").fetchall()
    out = []
    changed = False
    for r in rows:
        d = row_to_dict(r)
        if _needs_matcherino_refresh(d):
            info = _fetch_matcherino_info(d.get("matcherino_id"))
            if info:
                d, row_changed = _merge_matcherino_row(d, info)
                if row_changed:
                    db.execute(
                        """UPDATE tournaments
                           SET prize=?, image=?, link=?, description=?
                           WHERE id=?""",
                        (d.get("prize"), d.get("image"), d.get("link"),
                         d.get("description"), d.get("id"))
                    )
                    changed = True
        d["computed_status"] = tournament_status(d)
        out.append(d)
    if changed:
        db.commit()
    out.sort(key=tournament_sort_key)
    return jsonify(out)


@app.post("/api/tournaments")
@require_admin
def add_tournament():
    d = parse_json()
    region = d.get("region") if d.get("region") in TOURNAMENT_REGIONS else "EMEA"
    db = get_db()
    cur = db.execute(
        """INSERT INTO tournaments(name,date,prize,region,link,image,description,status,matcherino_id)
           VALUES(?,?,?,?,?,?,?,?,?)""",
        (d.get("name"), d.get("date"), d.get("prize"), region,
         d.get("link"), d.get("image"), d.get("description"),
         d.get("status", "auto"),
         d.get("matcherino_id"))
    )
    db.commit()
    return jsonify({"id": cur.lastrowid})


# ---------- Matcherino lookup ----------

def _extract_bounty(raw):
    """Matcherino returns either {body:{...bounty...}} or the bounty directly.
    Normalize to a dict that has the bounty fields at the top level."""
    if not isinstance(raw, dict):
        return {}
    body = raw.get("body")
    if isinstance(body, dict):
        return body
    return raw


def _parse_mat_date(v):
    """Matcherino timestamps come as ISO strings or epoch ms — normalize to ISO."""
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        try:
            return datetime.fromtimestamp(v / 1000 if v > 1e12 else v,
                                          tz=timezone.utc).isoformat()
        except Exception:
            return None
    if isinstance(v, str):
        # Matcherino sometimes returns "2025-01-15T18:00:00Z"
        return v
    return None


def _matcherino_image_url(url):
    """Return a usable Matcherino image URL, unwrapping Next.js image URLs."""
    if not isinstance(url, str):
        return ""
    url = url.strip()
    if not url:
        return ""
    if "_next/image" in url and "url=" in url:
        try:
            from urllib.parse import parse_qs, urlparse, unquote
            parsed = urlparse(url)
            raw = parse_qs(parsed.query).get("url", [""])[0]
            url = unquote(raw) or url
        except Exception:
            pass
    return url if url.startswith(("http://", "https://")) else ""


def _find_matcherino_image(obj):
    """Search Matcherino payloads for the best event image field."""
    if not isinstance(obj, dict):
        return ""

    meta = obj.get("meta") if isinstance(obj.get("meta"), dict) else {}
    preferred = (
        meta.get("backgroundImg"),
        meta.get("bannerImg"),
        meta.get("image"),
        obj.get("backgroundImg"),
        obj.get("bannerUrl"),
        obj.get("banner"),
        obj.get("imageUrl"),
        obj.get("heroImg"),
        obj.get("thumbnailImg"),
        obj.get("coverImg"),
    )
    for candidate in preferred:
        url = _matcherino_image_url(candidate)
        if url:
            return url

    def walk(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if key == "game":
                    continue
                key_l = str(key).lower()
                if any(token in key_l for token in
                       ("background", "banner", "hero", "thumbnail",
                        "cover", "image", "img")):
                    url = _matcherino_image_url(child)
                    if url and "cdn.matcherino.com" in url:
                        return url
                found = walk(child)
                if found:
                    return found
        elif isinstance(value, list):
            for child in value:
                found = walk(child)
                if found:
                    return found
        elif isinstance(value, str):
            url = _matcherino_image_url(value)
            if "cdn.matcherino.com" in url:
                return url
        return ""

    return walk(obj)


def _format_usd(amount):
    if amount is None:
        return None
    return f"${amount:,.2f}"


def _matcherino_total_spent_prize(bounty_id):
    if not bounty_id:
        return None
    try:
        r = requests.get(MATCHERINO_TOTAL_SPENT_URL,
                         params={"bountyId": bounty_id}, timeout=10)
        r.raise_for_status()
        raw_amount = _extract_bounty(r.json()).get("amount")
        total = Decimal(str(raw_amount))
        prize = (total * MATCHERINO_PRIZE_POOL_SHARE).quantize(
            Decimal("0.01"), rounding=ROUND_HALF_UP)
        return _format_usd(prize)
    except (requests.RequestException, InvalidOperation, TypeError, ValueError):
        return None


def _fallback_matcherino_prize(b):
    prize = (b.get("prizePool") or b.get("totalPrize")
             or b.get("prizePoolTotal") or b.get("crowdfundedAmount"))
    if isinstance(prize, (int, float)):
        amount = Decimal(str(prize / 100 if prize > 1000 else prize))
        return _format_usd(amount.quantize(Decimal("0.01"),
                                           rounding=ROUND_HALF_UP))
    return str(prize) if prize else None


def _normalize_bounty(raw):
    """Map a Matcherino bounty payload to the fields the YF7 admin form needs."""
    b = _extract_bounty(raw)
    if not b:
        return None
    # Prize pool can live in several keys depending on whether the tournament
    # has crowdfunding enabled, sponsors, etc.
    prize = (b.get("prizePool") or b.get("totalPrize")
             or b.get("prizePoolTotal") or b.get("crowdfundedAmount"))
    if isinstance(prize, (int, float)):
        # Matcherino stores cents — divide if it looks like cents.
        amount = prize / 100 if prize > 1000 else prize
        prize_str = f"${amount:,.0f}"
    else:
        prize_str = str(prize) if prize else None

    date_raw = (b.get("startAt") or b.get("startTime") or b.get("startDate")
                or b.get("scheduledStartAt") or b.get("createdAt"))
    bid = b.get("id") or b.get("bountyId")
    prize_str = _matcherino_total_spent_prize(bid) or _fallback_matcherino_prize(b) or prize_str
    return {
        "matcherino_id": bid,
        "name":  b.get("name") or b.get("title") or "",
        "date":  _parse_mat_date(date_raw),
        "prize": prize_str,
        "image": _find_matcherino_image(b),
        "description": b.get("description") or b.get("shortDescription") or "",
        "link":  f"https://matcherino.com/tournaments/{bid}" if bid else None,
        "raw":   b,
    }


def _fetch_matcherino_info(bounty_id):
    """Fetch and normalize a Matcherino tournament, cached to avoid refetching."""
    if not bounty_id:
        return None
    try:
        bid = int(bounty_id)
    except (TypeError, ValueError):
        return None

    now = time.time()
    with _matcherino_lock:
        cached = _matcherino_cache.get(bid)
        if cached and now - cached["ts"] < MATCHERINO_CACHE_TTL:
            return dict(cached["info"])

    try:
        r = requests.get(MATCHERINO_BOUNTY_URL, params={"id": bid}, timeout=10)
        r.raise_for_status()
    except requests.RequestException:
        return None

    info = _normalize_bounty(r.json())
    if not info or not info.get("name"):
        return None
    info.pop("raw", None)
    with _matcherino_lock:
        _matcherino_cache[bid] = {"ts": now, "info": dict(info)}
    return info


def _needs_matcherino_refresh(t):
    return bool(t.get("matcherino_id"))


def _merge_matcherino_row(t, info):
    changed = False
    incoming_prize = info.get("prize")
    if incoming_prize and incoming_prize != t.get("prize"):
        t["prize"] = incoming_prize
        changed = True
    for key in ("image", "link"):
        current = (t.get(key) or "").strip() if isinstance(t.get(key), str) else t.get(key)
        incoming = info.get(key)
        if incoming and (not current or current in {"-", "$0", "$0.00", "None", "null"}):
            t[key] = incoming
            changed = True
    if not (t.get("description") or "").strip() and info.get("description"):
        t["description"] = info["description"]
        changed = True
    return t, changed


@app.get("/api/matcherino/<int:bounty_id>")
@require_admin
def matcherino_lookup(bounty_id):
    """Fetch a Matcherino bounty by ID and return the fields needed to prefill
    the tournament form. Admin-only to avoid being a public proxy."""
    info = _fetch_matcherino_info(bounty_id)
    if not info or not info.get("name"):
        return jsonify({"error": "tournament not found"}), 404
    return jsonify(info)


@app.post("/api/tournaments/from-matcherino")
@require_admin
def add_tournament_from_matcherino():
    """One-shot endpoint: admin posts {matcherino_id, region?} and we fetch +
    insert in a single round-trip."""
    d = parse_json()
    try:
        bid = int(d.get("matcherino_id"))
    except (TypeError, ValueError):
        return jsonify({"error": "matcherino_id required"}), 400

    info = _fetch_matcherino_info(bid)
    if not info or not info.get("name"):
        return jsonify({"error": "tournament not found"}), 404

    db = get_db()
    # Upsert by matcherino_id so the same tournament can't be added twice.
    existing = db.execute(
        "SELECT id FROM tournaments WHERE matcherino_id=?", (bid,)
    ).fetchone()
    region = d.get("region") if d.get("region") in TOURNAMENT_REGIONS else "EMEA"
    if existing:
        db.execute(
            """UPDATE tournaments SET name=?, date=?, prize=?, region=?,
               link=?, image=?, description=? WHERE matcherino_id=?""",
            (info["name"], info["date"], info["prize"], region,
             info["link"], info["image"], info["description"], bid)
        )
        tid = existing["id"]
    else:
        cur = db.execute(
            """INSERT INTO tournaments(name,date,prize,region,link,image,
               description,status,matcherino_id) VALUES(?,?,?,?,?,?,?,?,?)""",
            (info["name"], info["date"], info["prize"], region,
             info["link"], info["image"], info["description"], "auto", bid)
        )
        tid = cur.lastrowid
    db.commit()
    return jsonify({"id": tid, "matcherino_id": bid, "name": info["name"]})


@app.patch("/api/tournaments/<int:tid>")
@require_admin
def update_tournament(tid):
    d = parse_json()
    if "region" in d and d.get("region") not in TOURNAMENT_REGIONS:
        d["region"] = "EMEA"
    fields = ["name", "date", "prize", "region", "link", "image", "description", "status"]
    sets, vals = [], []
    for k in fields:
        if k in d:
            sets.append(f"{k}=?")
            vals.append(d[k])
    if not sets:
        return jsonify({"ok": True})
    vals.append(tid)
    db = get_db()
    db.execute(f"UPDATE tournaments SET {','.join(sets)} WHERE id=?", vals)
    db.commit()
    return jsonify({"ok": True})


@app.delete("/api/tournaments/<int:tid>")
@require_admin
def delete_tournament(tid):
    db = get_db()
    db.execute("DELETE FROM tournaments WHERE id=?", (tid,))
    db.commit()
    return jsonify({"ok": True})


# ---------- news ----------

@app.get("/api/news")
def list_news():
    db = get_db()
    rows = db.execute("SELECT * FROM news ORDER BY date DESC").fetchall()
    return jsonify([row_to_dict(r) for r in rows])


@app.post("/api/news")
@require_admin
def add_news():
    d = parse_json()
    db = get_db()
    cur = db.execute(
        "INSERT INTO news(title,category,content,image,date) VALUES(?,?,?,?,?)",
        (d.get("title"), d.get("category"), d.get("content"),
         d.get("image"), datetime.utcnow().isoformat())
    )
    db.commit()
    return jsonify({"id": cur.lastrowid})


@app.delete("/api/news/<int:nid>")
@require_admin
def delete_news(nid):
    db = get_db()
    db.execute("DELETE FROM news WHERE id=?", (nid,))
    db.commit()
    return jsonify({"ok": True})


# ---------- winning ----------

@app.get("/api/winning")
def list_winning():
    db = get_db()
    rows = db.execute(
        "SELECT * FROM winning ORDER BY wins DESC, earnings DESC"
    ).fetchall()
    return jsonify([row_to_dict(r) for r in rows])


@app.post("/api/winning")
@require_admin
def add_winning():
    d = parse_json()
    matcherino_id = d.get("matcherino_id")
    if matcherino_id in (None, ""):
        matcherino_id = None
    else:
        try:
            matcherino_id = int(matcherino_id)
        except (TypeError, ValueError):
            return jsonify({"error": "matcherino_id must be numeric"}), 400
        if matcherino_id <= 0:
            return jsonify({"error": "matcherino_id must be positive"}), 400
    db = get_db()
    cur = db.execute(
        """INSERT INTO winning(type,name,wins,earnings,avatar,matcherino_id)
           VALUES(?,?,?,?,?,?)""",
        (d.get("type", "player"), d.get("name"),
         int(d.get("wins") or 0), int(d.get("earnings") or 0),
         d.get("avatar"), matcherino_id)
    )
    db.commit()
    return jsonify({"id": cur.lastrowid})


@app.delete("/api/winning/<int:wid>")
@require_admin
def delete_winning(wid):
    db = get_db()
    db.execute("DELETE FROM winning WHERE id=?", (wid,))
    db.commit()
    return jsonify({"ok": True})


# ---------- esports leaderboard ----------

@app.get("/api/esports/<region>/leaderboard")
def get_leaderboard(region):
    db = get_db()
    rows = db.execute(
        "SELECT * FROM esports WHERE region=? ORDER BY points DESC", (region,)
    ).fetchall()
    return jsonify([row_to_dict(r) for r in rows])


@app.post("/api/esports/<region>/leaderboard")
@require_admin
def add_leaderboard(region):
    d = parse_json()
    db = get_db()
    cur = db.execute(
        "INSERT INTO esports(region,name,points,flag) VALUES(?,?,?,?)",
        (region, d.get("name"), int(d.get("points") or 0), d.get("flag"))
    )
    db.commit()
    return jsonify({"id": cur.lastrowid})


@app.delete("/api/esports/<int:eid>")
@require_admin
def delete_leaderboard(eid):
    db = get_db()
    db.execute("DELETE FROM esports WHERE id=?", (eid,))
    db.commit()
    return jsonify({"ok": True})


# ---------- brackets ----------

@app.get("/api/brackets/<region>/<btype>")
def get_brackets(region, btype):
    db = get_db()
    rows = db.execute(
        "SELECT * FROM brackets WHERE region=? AND type=?", (region, btype)
    ).fetchall()
    return jsonify([row_to_dict(r) for r in rows])


# ---------- live brackets ----------
# Source-agnostic routes and payloads. Internal variable names refer to the
# poller's cache layout; nothing in the HTTP surface or response JSON
# discloses the upstream provider or any provider-specific identifiers.

ATHLOS_CACHE_DIR = BASE_DIR / "data" / "athlos_cache"

# Region name fragments as they appear in upstream segment names (lowercased).
ATHLOS_REGION_KEYWORDS = {
    "emea":         ("europe", "emea", "middle east"),
    "northamerica": ("americas norte", "north america", "norteamerica"),
    "southamerica": ("americas sur", "south america", "sudamerica", "latam"),
    "eastasia":     ("east asia", "eastasia"),
}

# Stage classification. Each kind has positive keywords (any must match) and
# negative keywords (none may match). Matched against both the level-0 stage
# name and the child segment's type.name.
ATHLOS_STAGE_KINDS = {
    "q1": {"any": ("day 1",),                 "none": ()},
    "q2": {"any": ("day 2",),                 "none": ()},
    "mf": {"any": ("final",),                 "none": ("qualifier",)},
}


def _load_athlos_json(name):
    path = ATHLOS_CACHE_DIR / name
    if not path.is_file():
        return None
    try:
        with path.open("r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _seg_date_key(seg):
    """Sort key: prefer date.from, fall back to id (UUID time is monotonic)."""
    d = (seg.get("date") or {}).get("from") or ""
    return (d, seg.get("id") or "")


def _seg_month(seg):
    """Return YYYY-MM derived from a segment's date.from, or ''."""
    d = (seg.get("date") or {}).get("from") or ""
    return d[:7] if len(d) >= 7 else ""


def _classify_stage(stage_name, type_name, kind):
    """Return True if the names match the requested stage kind (q1/q2/mf)."""
    rules = ATHLOS_STAGE_KINDS.get(kind)
    if not rules:
        return False
    blob = f"{stage_name} {type_name}".lower()
    if any(n in blob for n in rules["none"]):
        return False
    return any(k in blob for k in rules["any"])


def _iter_leaf_segments():
    """Yield (child_seg, stage_parent_name) for every level-1 region segment.

    stage_parent_name is the level-0 stage's name (for context); if the leaf is
    flat (no parent), fall back to its own path[].name."""
    segs = _load_athlos_json("segments.json")
    if not segs or not isinstance(segs.get("data"), list):
        return
    seen = set()
    for stage in segs["data"]:
        if stage.get("level") != 0:
            continue
        stage_name = stage.get("name") or ""
        for child in stage.get("children") or []:
            cid = child.get("id")
            if cid and cid not in seen:
                seen.add(cid)
                yield child, stage_name
    for seg in segs["data"]:
        if seg.get("level") != 1:
            continue
        sid = seg.get("id")
        if sid in seen:
            continue
        seen.add(sid)
        path_names = " ".join((p.get("name") or "") for p in (seg.get("path") or []))
        yield seg, path_names


def _resolve_athlos_segment(region, kind, month=None):
    """Return the leaf segment ID for (region, kind, month), or None.

    month: optional "YYYY-MM" filter. If None, returns the most recent."""
    region_keys = ATHLOS_REGION_KEYWORDS.get(region)
    if not region_keys or kind not in ATHLOS_STAGE_KINDS:
        return None

    def region_matches(name):
        n = (name or "").lower()
        return any(k in n for k in region_keys)

    candidates = []
    for child, stage_name in _iter_leaf_segments():
        type_name = ((child.get("type") or {}).get("name") or "")
        if not _classify_stage(stage_name, type_name, kind):
            continue
        if not region_matches(child.get("name") or ""):
            continue
        if month and _seg_month(child) != month:
            continue
        candidates.append(child)

    if not candidates:
        return None
    candidates.sort(key=_seg_date_key, reverse=True)
    return candidates[0].get("id")


def _sanitize_competitor(c):
    """Strip provider-specific identifiers; keep only what the UI needs."""
    if not isinstance(c, dict):
        return {}
    roster = c.get("roster") or {}
    seed   = c.get("seed") or {}
    result = c.get("result") or {}
    return {
        "number":    c.get("number"),
        "isBye":     bool(c.get("isBye")),
        "placement": c.get("placement"),
        "roster":    {"name": roster.get("name")},
        "seed":      {"number": seed.get("number")},
        "result":    {"score":   result.get("score"),
                      "forfeit": bool(result.get("forfeit"))},
    }


def _sanitize_match(m):
    if not isinstance(m, dict):
        return {}
    return {
        "roundNumber": m.get("roundNumber"),
        "matchNumber": m.get("matchNumber"),
        "state":       m.get("state"),
        "isBye":       bool(m.get("isBye")),
        "competitors": [_sanitize_competitor(c) for c in (m.get("competitors") or [])],
    }


@app.get("/api/live-brackets/months")
def get_live_bracket_months():
    """Return sorted (newest-first) list of YYYY-MM months that have brackets."""
    months = set()
    for child, _stage_name in _iter_leaf_segments():
        m = _seg_month(child)
        if m:
            months.add(m)
    return jsonify(sorted(months, reverse=True))


@app.get("/api/live-brackets/<region>/<kind>")
def get_live_bracket(region, kind):
    region = region.lower()
    kind   = kind.lower()
    if region not in ATHLOS_REGION_KEYWORDS or kind not in ATHLOS_STAGE_KINDS:
        return jsonify({"error": "unknown region or stage"}), 400

    month = (request.args.get("month") or "").strip() or None
    seg_id = _resolve_athlos_segment(region, kind, month=month)
    if not seg_id:
        return jsonify({"month": month, "matches": []})

    data = _load_athlos_json(f"bracket_{seg_id}.json")
    raw  = (data or {}).get("data") or []
    return jsonify({
        "month":   month,
        "matches": [_sanitize_match(m) for m in raw],
    })


@app.post("/api/brackets")
@require_admin
def add_bracket():
    d = parse_json()
    region = d.get("region") if d.get("region") in BRACKET_REGIONS else "emea"
    db = get_db()
    cur = db.execute(
        "INSERT INTO brackets(region,type,image,link,label) VALUES(?,?,?,?,?)",
        (region, d.get("type"), d.get("image"),
         d.get("link"), d.get("label"))
    )
    db.commit()
    return jsonify({"id": cur.lastrowid})


@app.delete("/api/brackets/<int:bid>")
@require_admin
def delete_bracket(bid):
    db = get_db()
    db.execute("DELETE FROM brackets WHERE id=?", (bid,))
    db.commit()
    return jsonify({"ok": True})


# ---------- about / staff / partners ----------

@app.get("/api/about")
def get_about():
    db = get_db()
    about = db.execute("SELECT value FROM settings WHERE key='about'").fetchone()
    discord = db.execute("SELECT value FROM settings WHERE key='discord'").fetchone()
    staff = db.execute("SELECT * FROM staff ORDER BY sort_order, id").fetchall()
    partners = db.execute("SELECT * FROM partners ORDER BY id").fetchall()
    return jsonify({
        "description": about["value"] if about else "",
        "discord": discord["value"] if discord else "",
        "staff": [row_to_dict(r) for r in staff],
        "partners": [row_to_dict(r) for r in partners],
    })


@app.post("/api/about")
@require_admin
def save_about():
    d = parse_json()
    db = get_db()
    if "description" in d:
        db.execute(
            "INSERT INTO settings(key,value) VALUES('about',?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (d["description"],))
    if "discord" in d:
        db.execute(
            "INSERT INTO settings(key,value) VALUES('discord',?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (d["discord"],))
    db.commit()
    return jsonify({"ok": True})


@app.get("/api/staff")
def get_staff():
    db = get_db()
    rows = db.execute("SELECT * FROM staff ORDER BY sort_order, id").fetchall()
    return jsonify([row_to_dict(r) for r in rows])


@app.post("/api/staff")
@require_admin
def add_staff():
    d = parse_json()
    db = get_db()
    cur = db.execute(
        "INSERT INTO staff(name,role,pfp,description,discord,x_url,sort_order) "
        "VALUES(?,?,?,?,?,?,?)",
        (d.get("name"), d.get("role"), d.get("pfp"),
         d.get("description"), d.get("discord"), d.get("x_url"),
         int(d.get("sort_order") or 0))
    )
    db.commit()
    return jsonify({"id": cur.lastrowid})


@app.delete("/api/staff/<int:sid>")
@require_admin
def delete_staff(sid):
    db = get_db()
    db.execute("DELETE FROM staff WHERE id=?", (sid,))
    db.commit()
    return jsonify({"ok": True})


@app.get("/api/partners")
def get_partners():
    db = get_db()
    rows = db.execute("SELECT * FROM partners ORDER BY id").fetchall()
    return jsonify([row_to_dict(r) for r in rows])


@app.post("/api/partners")
@require_admin
def add_partner():
    d = parse_json()
    db = get_db()
    cur = db.execute(
        "INSERT INTO partners(name,url,logo) VALUES(?,?,?)",
        (d.get("name"), d.get("url"), d.get("logo"))
    )
    db.commit()
    return jsonify({"id": cur.lastrowid})


@app.delete("/api/partners/<int:pid>")
@require_admin
def delete_partner(pid):
    db = get_db()
    db.execute("DELETE FROM partners WHERE id=?", (pid,))
    db.commit()
    return jsonify({"ok": True})


# ---------- tickets ----------

def serialize_ticket(db, code):
    t = db.execute("SELECT * FROM tickets WHERE code=?", (code,)).fetchone()
    if not t:
        return None
    msgs = db.execute(
        "SELECT author, author_name, text, date FROM ticket_messages "
        "WHERE ticket_code=? ORDER BY id", (code,)
    ).fetchall()
    d = row_to_dict(t)
    d["messages"] = [
        {"author": m["author"], "authorName": m["author_name"],
         "text": m["text"], "date": m["date"]}
        for m in msgs
    ]
    return d


def new_ticket_code(db):
    for _ in range(20):
        code = f"YF7-{random.randint(1000, 9999)}"
        if not db.execute("SELECT 1 FROM tickets WHERE code=?", (code,)).fetchone():
            return code
    raise RuntimeError("ticket code exhausted")


@app.post("/api/tickets")
def create_ticket():
    d = parse_json()
    name = (d.get("name") or "").strip()
    discord = (d.get("discord") or "").strip()
    subject = (d.get("subject") or "General Question").strip()
    message = (d.get("message") or "").strip()
    if not name or not discord or not message:
        return jsonify({"error": "missing fields"}), 400
    db = get_db()
    code = new_ticket_code(db)
    now = datetime.utcnow().isoformat()
    db.execute(
        "INSERT INTO tickets(code,name,discord,subject,status,date) VALUES(?,?,?,?,?,?)",
        (code, name, discord, subject, "open", now)
    )
    db.execute(
        "INSERT INTO ticket_messages(ticket_code,author,author_name,text,date) "
        "VALUES(?,?,?,?,?)",
        (code, "user", name, message, now)
    )
    db.commit()
    return jsonify({"code": code})


@app.get("/api/tickets/<code>")
def get_ticket(code):
    db = get_db()
    t = serialize_ticket(db, code)
    if not t:
        return jsonify({"error": "not found"}), 404
    return jsonify(t)


@app.post("/api/tickets/<code>/reply")
def user_reply(code):
    d = parse_json()
    text = (d.get("text") or "").strip()
    if not text:
        return jsonify({"error": "empty"}), 400
    db = get_db()
    t = db.execute("SELECT * FROM tickets WHERE code=?", (code,)).fetchone()
    if not t:
        return jsonify({"error": "not found"}), 404
    if t["status"] != "open":
        return jsonify({"error": "ticket closed"}), 400
    db.execute(
        "INSERT INTO ticket_messages(ticket_code,author,author_name,text,date) "
        "VALUES(?,?,?,?,?)",
        (code, "user", t["name"], text, datetime.utcnow().isoformat())
    )
    db.commit()
    return jsonify(serialize_ticket(db, code))


# admin ticket ops
@app.get("/api/admin/tickets")
@require_admin
def admin_list_tickets():
    db = get_db()
    rows = db.execute("SELECT * FROM tickets ORDER BY date DESC").fetchall()
    out = []
    for r in rows:
        d = row_to_dict(r)
        msgs = db.execute(
            "SELECT author,author_name,text,date FROM ticket_messages "
            "WHERE ticket_code=? ORDER BY id", (r["code"],)
        ).fetchall()
        d["messages"] = [
            {"author": m["author"], "authorName": m["author_name"],
             "text": m["text"], "date": m["date"]} for m in msgs
        ]
        out.append(d)
    return jsonify(out)


@app.post("/api/admin/tickets/<code>/reply")
@require_admin
def admin_reply(code):
    d = parse_json()
    text = (d.get("text") or "").strip()
    if not text:
        return jsonify({"error": "empty"}), 400
    db = get_db()
    if not db.execute("SELECT 1 FROM tickets WHERE code=?", (code,)).fetchone():
        return jsonify({"error": "not found"}), 404
    db.execute(
        "INSERT INTO ticket_messages(ticket_code,author,author_name,text,date) "
        "VALUES(?,?,?,?,?)",
        (code, "admin", "YF7 Staff", text, datetime.utcnow().isoformat())
    )
    db.commit()
    return jsonify(serialize_ticket(db, code))


@app.patch("/api/admin/tickets/<code>")
@require_admin
def admin_update_ticket(code):
    d = parse_json()
    db = get_db()
    if "status" in d:
        db.execute("UPDATE tickets SET status=? WHERE code=?", (d["status"], code))
    db.commit()
    return jsonify(serialize_ticket(db, code))


@app.delete("/api/admin/tickets/<code>")
@require_admin
def admin_delete_ticket(code):
    db = get_db()
    db.execute("DELETE FROM tickets WHERE code=?", (code,))
    db.commit()
    return jsonify({"ok": True})


# ---------- Supercell esports leaderboard scraping ----------

SUPERCELL_REGIONS = {
    "eastasia":     "East Asia",
    "emea":         "EMEA",
    "northamerica": "North America",
    "southamerica": "South America",
}
SUPERCELL_ASSETS_URL = "https://event.supercell.com/brawlstars/assets"
SUPERCELL_LB_URL = "https://event.supercell.com/brawlstars/en/leaderboards/{region}"
_lb_cache = {}              # region -> {"items": [...], "ts": ts, "name": ...}
_lb_lock = threading.Lock()
LB_TTL = 12 * 60 * 60       # 12 hours


def _parse_supercell_payload(text, region):
    """Best-effort parse of Nuxt's _payload.json leaderboard data."""
    items = []
    # Payload is a flat array — find anything that looks like a team entry.
    # Team rows include name, points, sometimes logo path.
    for m in re.finditer(
        r'\{"name":"([^"]+)","[^"]*":[^}]*?"points":(\d+)[^}]*?(?:"logoUrl":"([^"]*)")?',
        text):
        name, pts, logo = m.group(1), int(m.group(2)), m.group(3) or ""
        if logo.startswith("/"):
            logo = "https://event.supercell.com" + logo
        items.append({
            "name": name, "region": "", "logo": logo,
            "points": pts, "trophy": None, "disabled": False,
        })
    return items


def _fetch_supercell_json(path):
    """Fetch the JSON assets used by Supercell's Nuxt app."""
    url = f"{SUPERCELL_ASSETS_URL}/{path.lstrip('/')}"
    headers = {
        "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                       "AppleWebKit/537.36 (KHTML, like Gecko) "
                       "Chrome/124.0.0.0 Safari/537.36"),
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://event.supercell.com/brawlstars/en/leaderboards",
    }
    if HAS_CURL_CFFI:
        try:
            r = cffi_requests.get(url, headers=headers, timeout=12,
                                  impersonate="chrome124")
        except Exception:
            r = requests.get(url, headers=headers, timeout=12)
    else:
        r = requests.get(url, headers=headers, timeout=12)
    r.raise_for_status()
    return r.json()


def _supercell_logo_url(logo):
    if not logo or logo == "undefined":
        return ""
    if logo.startswith(("http://", "https://")):
        return logo
    suffix = "" if logo.endswith(".svg") else ".png"
    return f"{SUPERCELL_ASSETS_URL}{logo}{suffix}"


def _normalize_supercell_team(team):
    return {
        "name":     str(team.get("name") or "").strip(),
        "region":   str(team.get("region") or "").upper(),
        "logo":     _supercell_logo_url(str(team.get("logo") or "")),
        "points":   int(team.get("points") or 0),
        "trophy":   "gold" if team.get("wfQualified") else
                    "silver" if team.get("lcqQualified") else None,
        "disabled": team.get("teamId") is None,
    }


def _fetch_supercell_leaderboard(region):
    """Read the current official leaderboard JSON assets."""
    data = _fetch_supercell_json(f"leaderboards/{region}.json")
    teams = data.get("teams") if isinstance(data, dict) else None
    if not isinstance(teams, list):
        raise ValueError("leaderboard JSON did not contain teams")
    return [item for item in (_normalize_supercell_team(t) for t in teams)
            if item["name"]][:10]


def _scrape_supercell_leaderboard(region):
    """Return Supercell leaderboard rows for one region.

    Supercell now serves leaderboard data from JSON assets used by their Nuxt
    app. Keep the older SSR parser below as a fallback for future site changes.
    """
    try:
        return _fetch_supercell_leaderboard(region)
    except Exception:
        pass

    # Fallback: parse the SSR HTML of the Supercell leaderboard page.
    url = SUPERCELL_LB_URL.format(region=region)
    headers = {
        "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                       "AppleWebKit/537.36 (KHTML, like Gecko) "
                       "Chrome/124.0.0.0 Safari/537.36"),
        "Accept": ("text/html,application/xhtml+xml,application/xml;q=0.9,"
                   "image/avif,image/webp,*/*;q=0.8"),
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
        "Referer": "https://event.supercell.com/brawlstars/en",
    }
    # Supercell's CDN bot-blocks plain `requests` based on TLS fingerprint.
    # curl_cffi replays a real Chrome TLS handshake so the request gets through.
    if HAS_CURL_CFFI:
        try:
            r = cffi_requests.get(url, headers=headers, timeout=12,
                                  impersonate="chrome124", allow_redirects=True)
        except Exception:
            r = requests.get(url, headers=headers, timeout=12, allow_redirects=True)
    else:
        r = requests.get(url, headers=headers, timeout=12, allow_redirects=True)

    if r.status_code == 404:
        # Fallback: the prerendered Nuxt payload (what the SPA itself loads).
        for payload_url in (
            f"https://event.supercell.com/brawlstars/en/leaderboards/{region}/_payload.json",
            "https://event.supercell.com/brawlstars/en/_payload.json",
        ):
            try:
                if HAS_CURL_CFFI:
                    r2 = cffi_requests.get(payload_url, headers=headers,
                                           timeout=12, impersonate="chrome124")
                else:
                    r2 = requests.get(payload_url, headers=headers, timeout=12)
                if r2.status_code == 200:
                    items = _parse_supercell_payload(r2.text, region)
                    if items:
                        return items
            except Exception:
                pass
        r.raise_for_status()
    r.raise_for_status()
    html_text = r.text

    # The full team list lives inside the "cover" leaderboard section
    # (.leaderboard__content__rows). Extract everything between
    # `<ul ... class="leaderboard__content__rows">` and `</ul>`.
    m = re.search(
        r'class="leaderboard__content__rows"[^>]*>(.*?)</ul>',
        html_text, flags=re.S)
    block = m.group(1) if m else html_text

    items = []
    # Each row is a <button class="leaderboardRow..."> ... </button>.
    row_pat = re.compile(
        r'<button[^>]*class="leaderboardRow([^"]*)"(.*?)</button>',
        flags=re.S)
    for raw_classes, row_html in row_pat.findall(block):
        is_silver   = "leaderboardRow--silver"   in raw_classes
        is_disabled = "leaderboardRow--disabled" in raw_classes

        logo = re.search(r'class="matchTeam__logo"[^>]*src="([^"]+)"', row_html)
        name = re.search(r'class="matchTeam__name"[^>]*>([^<]+)</div>', row_html)
        team_region = re.search(
            r'class="matchTeam__region"[^>]*>([^<]+)</div>', row_html)
        trophy = re.search(
            r'class="leaderboardRow__content__trophy"[^>]*src="([^"]*trophy-icon-([a-z]+)[^"]*)"',
            row_html)
        points = re.search(
            r'class="leaderboardRow__content__points"[^>]*>(\d+)</div>', row_html)

        if not name:
            continue
        logo_url = logo.group(1) if logo else ""
        # Supercell logos are relative URLs sometimes — make absolute.
        if logo_url.startswith("/"):
            logo_url = "https://event.supercell.com" + logo_url
        trophy_kind = trophy.group(2) if trophy else None  # "gold" / "silver" / None
        if is_silver and not trophy_kind:
            trophy_kind = "silver"

        items.append({
            "name":     name.group(1).strip(),
            "region":   team_region.group(1).strip() if team_region else "",
            "logo":     logo_url,
            "points":   int(points.group(1)) if points else 0,
            "trophy":   trophy_kind,         # "gold" / "silver" / null
            "disabled": is_disabled,
        })
    return items


@app.get("/api/leaderboard/<region>")
def get_supercell_leaderboard(region):
    if region not in SUPERCELL_REGIONS:
        return jsonify({"error": "unknown region",
                        "available": list(SUPERCELL_REGIONS.keys())}), 400
    with _lb_lock:
        cached = _lb_cache.get(region)
        if cached and time.time() - cached["ts"] < LB_TTL:
            return jsonify({
                "region": region,
                "name":   SUPERCELL_REGIONS[region],
                "items":  cached["items"],
                "cached": True,
                "age":    int(time.time() - cached["ts"]),
            })
    try:
        items = _scrape_supercell_leaderboard(region)
    except Exception as e:
        with _lb_lock:
            if cached:
                return jsonify({
                    "region": region,
                    "name":   SUPERCELL_REGIONS[region],
                    "items":  cached["items"],
                    "stale":  True,
                    "error":  str(e),
                })
        return jsonify({"error": f"scrape failed: {e}"}), 502
    with _lb_lock:
        _lb_cache[region] = {"items": items, "ts": time.time()}
    return jsonify({
        "region": region,
        "name":   SUPERCELL_REGIONS[region],
        "items":  items,
        "cached": False,
    })


# ---------- Twitter / Nitter scraping ----------

_NS = {
    "atom":  "http://www.w3.org/2005/Atom",
    "media": "http://search.yahoo.com/mrss/",
    "dc":    "http://purl.org/dc/elements/1.1/",
}


def _strip_html(s: str) -> str:
    """Strip HTML tags + decode entities (Nitter RSS descriptions are HTML)."""
    if not s:
        return ""
    s = re.sub(r"<br\s*/?>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    return html.unescape(s).strip()


def _extract_images(description_html: str):
    """Pull image URLs out of Nitter's RSS description HTML (img src and
    video poster attributes both qualify)."""
    if not description_html:
        return []
    urls = []
    urls += re.findall(r'<img[^>]+src="([^"]+)"', description_html, flags=re.I)
    urls += re.findall(r'<video[^>]+poster="([^"]+)"', description_html, flags=re.I)
    urls += re.findall(r'<a[^>]+href="(https?://[^"]+\.(?:jpg|jpeg|png|webp|gif)[^"]*)"',
                       description_html, flags=re.I)
    # de-dupe while preserving order
    seen, out = set(), []
    for u in urls:
        if u not in seen:
            seen.add(u); out.append(u)
    return out


def _rewrite_nitter_url(url: str, instance: str) -> str:
    """Nitter image URLs are relative or point to the nitter instance. Rewrite
    them to the canonical x.com path so they load even if that instance dies."""
    if not url:
        return ""
    if url.startswith("/"):
        url = instance.rstrip("/") + url
    # Nitter proxies images via /pic/<path> — strip that to get the original.
    m = re.search(r"/pic/(.+)$", url)
    if m:
        decoded = requests.utils.unquote(m.group(1))
        if decoded.startswith("media/"):
            return "https://pbs.twimg.com/" + decoded
        if not decoded.startswith("http"):
            decoded = "https://" + decoded
        return decoded
    return url


def _normalize_external_image_url(url: str) -> str:
    """Repair known shorthand media URLs before proxying."""
    if not url:
        return ""
    parsed = urlparse(url)
    if parsed.netloc == "media":
        query = f"?{parsed.query}" if parsed.query else ""
        return "https://pbs.twimg.com/media" + parsed.path + query
    if parsed.netloc == "pbs.twimg.com" and parsed.path.startswith("/media/"):
        return url
    return url


def _parse_nitter_rss(xml_bytes: bytes, instance: str):
    """Turn a Nitter RSS feed into our normalized tweet dicts."""
    root = ET.fromstring(xml_bytes)
    channel = root.find("channel")
    if channel is None:
        return []
    items = []
    for it in channel.findall("item"):
        title  = (it.findtext("title") or "").strip()
        desc   = it.findtext("description") or ""
        link   = (it.findtext("link") or "").strip()
        pub    = it.findtext("pubDate") or ""
        creator = it.findtext("{http://purl.org/dc/elements/1.1/}creator") or ""
        is_rt  = title.startswith("RT by") or "RT @" in title

        # Nitter wraps replies/quotes in italic markers — keep plain text.
        text = _strip_html(desc)
        images = [_rewrite_nitter_url(u, instance) for u in _extract_images(desc)]
        # Canonicalize x.com link
        if "nitter" in link or "xcancel" in link:
            link = re.sub(r"https?://[^/]+", "https://x.com", link)

        items.append({
            "text":    text,
            "html":    desc,  # original HTML if frontend wants it
            "link":    link,
            "date":    pub,
            "author":  creator.strip() or f"@{TWITTER_HANDLE}",
            "is_retweet": is_rt,
            "images":  images,
        })
    return items


def _fetch_tweets_uncached():
    """Try each Nitter instance until one succeeds. Returns (items, source)."""
    headers = {
        "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                       "AppleWebKit/537.36 (KHTML, like Gecko) "
                       "Chrome/122.0.0.0 Safari/537.36"),
        "Accept": "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
    }
    for inst in NITTER_INSTANCES:
        url = f"{inst}/{TWITTER_HANDLE}/rss"
        try:
            r = requests.get(url, headers=headers, timeout=8)
            if r.status_code != 200 or not r.content:
                continue
            ct = r.headers.get("content-type", "")
            if "html" in ct and "<rss" not in r.text[:200].lower():
                # Some dying instances return a "rate limited" HTML page.
                continue
            items = _parse_nitter_rss(r.content, inst)
            if items:
                return items, inst
        except Exception:
            continue
    return [], None


@app.get("/api/img")
def img_proxy():
    """Proxy + cache external images (tweet media, etc.) so they load without
    referer / CORS issues. Only allows http(s) URLs."""
    url = _normalize_external_image_url(request.args.get("url", ""))
    if not url.startswith(("http://", "https://")):
        return jsonify({"error": "bad url"}), 400
    try:
        r = requests.get(url, timeout=10, headers={
            "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                           "AppleWebKit/537.36 (KHTML, like Gecko) "
                           "Chrome/124.0.0.0 Safari/537.36"),
            "Referer": "https://twitter.com/",
            "Accept": "image/avif,image/webp,image/png,image/*;q=0.8,*/*;q=0.5",
        }, stream=True)
        r.raise_for_status()
    except Exception as e:
        return jsonify({"error": str(e)}), 502
    from flask import Response
    return Response(
        r.content,
        content_type=r.headers.get("Content-Type", "image/jpeg"),
        headers={"Cache-Control": "public, max-age=3600"},
    )


def _load_tweets_from_disk():
    try:
        with open(TWEETS_CACHE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        _tweets_cache["items"]  = data.get("items") or []
        _tweets_cache["ts"]     = float(data.get("ts") or 0)
        _tweets_cache["source"] = data.get("source")
    except Exception:
        pass


def _save_tweets_to_disk():
    try:
        TWEETS_CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(TWEETS_CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(_tweets_cache, f, ensure_ascii=False)
    except Exception as exc:
        print(f"tweets cache save failed: {exc}")


_load_tweets_from_disk()


@app.get("/api/tweets")
def get_tweets():
    """Return whatever is in the cache. Refreshed externally by GitHub Actions
    via POST /api/tweets/refresh."""
    with _tweets_lock:
        now = time.time()
        age = int(now - _tweets_cache["ts"]) if _tweets_cache["ts"] else None
        stale = age is not None and age > TWEETS_CACHE_TTL
        return jsonify({
            "items":  _tweets_cache["items"],
            "source": _tweets_cache["source"],
            "cached": True,
            "stale":  stale,
            "age":    age,
        })


@app.post("/api/tweets/refresh")
def refresh_tweets():
    """Replace the tweet cache. Called by the GitHub Actions cron job.
    Auth: `Authorization: Bearer <YF7_TWEETS_TOKEN>`."""
    if not TWEETS_REFRESH_TOKEN:
        return jsonify({"error": "refresh disabled (YF7_TWEETS_TOKEN unset)"}), 503
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer ") or not hmac.compare_digest(
            auth[7:], TWEETS_REFRESH_TOKEN):
        return jsonify({"error": "unauthorized"}), 401

    body = request.get_json(silent=True) or {}
    items = body.get("items")
    if not isinstance(items, list):
        return jsonify({"error": "items must be a list"}), 400
    items = [t for t in items if isinstance(t, dict) and not t.get("is_retweet")]

    with _tweets_lock:
        _tweets_cache["items"]  = items
        _tweets_cache["ts"]     = time.time()
        _tweets_cache["source"] = body.get("source") or "github-actions"
        _save_tweets_to_disk()
    return jsonify({"ok": True, "count": len(items)})


try:
    import athlos_poller
    athlos_poller.start()
except Exception as _e:
    print(f"athlos_poller failed to start: {_e}")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)
