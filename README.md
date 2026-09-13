# LAN Print Relay

A tiny server that lets your phone send print jobs to your home/office PC
from anywhere on the internet — not just the same Wi-Fi. It doesn't store
anything; it just forwards requests between your phone and your desktop app
using a short pairing ID.

## Deploy it on Render (free, no credit card)

1. Put this `lan-print-relay` folder in its own GitHub repository (create a
   new repo, push these files to it). Render deploys from Git.
2. Go to [render.com](https://render.com) and sign up (GitHub login is
   fastest).
3. Click **New +** → **Web Service**, connect your GitHub account, and pick
   the repository you just created.
4. Settings:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
5. Click **Create Web Service**. After a minute or two you'll get a URL like:
   ```
   https://lan-print-relay-xxxx.onrender.com
   ```
   That's your relay's address — you'll paste it into both the desktop app
   and the phone app, once.

## Using the relay's own URL as your phone app

This relay also serves the same LAN Print web app at its own address. Add
the relay's URL itself to your phone's home screen instead of (or alongside)
the local printer PC's address — since it's HTTPS, it will always open, on
any network. Inside it, the "This network" tab is automatically hidden (it
can't reach a plain-HTTP local printer from an HTTPS page — browsers block
that), so it goes straight to the "Anywhere" tab using your pairing ID.

If you also want quick local-network printing without going through the
relay at all, keep a separate home-screen icon pointing at the printer PC's
local address (shown in the desktop app) — that one still uses the faster,
relay-free "This network" flow.

## Important limitation of the free tier

Render's free web services **go to sleep after 15 minutes with no traffic**
and take 30–60 seconds to wake back up on the next request. In practice this
means:

- If nobody's printed anything in the last 15 minutes, the *first* remote
  print attempt after that may take up to a minute, or briefly show the
  printer as "offline" while it reconnects. Just wait a few seconds and try
  again — the desktop app automatically reconnects once the relay wakes up.
- Printing while on the same Wi-Fi as the printer (the local mode) is
  unaffected by any of this — it never touches the relay.

If you print remotely often and the delay bothers you, Render's paid Starter
tier (~$7/month) removes the sleep behavior entirely. You'd just change the
service's instance type in the Render dashboard — no code changes needed.

## Security note

There are no accounts here — the pairing ID itself is the shared secret.
Anyone who has your ID can send print jobs to your printer while your
desktop app is running and connected to this relay. Don't post your ID
publicly. If you ever suspect someone else has it, regenerate a new ID from
the desktop app's settings and re-enter it on your phone.

## Running it yourself instead (VPS, etc.)

This is a plain Node.js + Express + `ws` app — no Render-specific code. On
any server with Node 18+:
```
npm install
npm start
```
It listens on `process.env.PORT` (defaults to 10000). Put it behind a
reverse proxy with HTTPS (e.g., Caddy or nginx) if you're exposing it
directly, since browsers require `wss://` (secure WebSocket) for a page
served over `https://`.
