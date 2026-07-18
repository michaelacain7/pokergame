# Home Game Hold'em

Real-time multiplayer no-limit Texas Hold'em for a private home game, with an
automatic buy-in ledger. One shared table — friends open the URL, type a name,
and sit down. No accounts, no room codes.

Node + Express serves the client; `ws` handles live sync. The server is
authoritative and holds all cards: each client only ever receives its own hole
cards (opponents are redacted until showdown).

## Run locally
```bash
npm install
npm start
# open http://localhost:3000  (open a second browser/phone to test two players)
```

## Deploy to Railway
1. Push this folder to a GitHub repo.
2. In Railway: **New Project → Deploy from GitHub repo** → pick the repo.
3. No env vars needed. Railway injects `PORT`; the server already reads it.
   Nixpacks auto-detects Node and runs `npm start`.
4. Once deployed, open **Settings → Networking → Generate Domain** to get a
   public `https://…up.railway.app` URL. WebSockets work over that domain
   automatically (the client upgrades to `wss://`).
5. Text that URL to your friends. On iPhone: Share → **Add to Home Screen** for
   a full-screen app icon.

## Notes
- State lives in memory. A redeploy or crash-restart clears the current table —
  fine for a session; the host can also hit **Reset for a New Night** anytime.
- Reconnect by entering the same name to reclaim your seat and stack.
- Up to 9 players.
