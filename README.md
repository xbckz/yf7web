# YF7 Tournaments

Brawl Stars tournament organizer website — Python (Flask) backend + static frontend.
SQLite database, no external services required.

## Run locally

```powershell
# 1. install Python deps (one time)
pip install -r requirements.txt

# 2. start the server
python server.py
```

Then open <http://localhost:5000>.

The first run auto-creates `yf7.db` (SQLite) and an `uploads/` folder for
admin-uploaded images.

## Admin

The admin panel is hidden from the public navbar. Access it directly at
<http://localhost:5000/admin>.

Default credentials (override with env vars):

- Username: `yf7wantstoomuch`
- Password: `YmhSBe12sd!Jwx1308`

**⚠️ Change these before deploying anywhere public.**

```powershell
$env:YF7_ADMIN_PASSWORD = "your-new-password"
$env:YF7_SECRET_KEY = "long-random-string"
python server.py
```

From the admin panel you can manage:

- Tournaments (with banner upload, status auto-detected from date, manual override)
- News articles (with cover images)
- Winning teams/players ranking
- Regional leaderboards (EU, NA, LATAM, Asia, MENA)
- Brackets (MQ qualifiers / MF finals — link or image)
- About page text, staff with PFPs, partners with logos
- Discord invite URL (used by all "Join Discord" buttons site-wide)
- Support tickets (reply, close/reopen, delete)

## Logo

Drop your transparent logo at `logo.png` in the project root and it will appear
in the navbar, footer, and admin login. Any `.png/.jpg` works (if missing, the
logo image is hidden gracefully and only the text wordmark shows).

## Production

Use a real WSGI server, e.g.:

```bash
pip install gunicorn
gunicorn -w 4 -b 0.0.0.0:5000 server:app
```

Put it behind nginx/caddy with HTTPS and set `YF7_SECRET_KEY` + `YF7_ADMIN_PASSWORD`.
