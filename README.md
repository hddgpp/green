# GreenZone Backend

The API that stores bets and serves them to the website.

- **Stack:** Node.js (v20+), Express, PostgreSQL
- **Deploys to:** Railway
- **Falls back to:** an in-memory store if no `DATABASE_URL` is set (useful for local testing — resets when the server restarts)

---

## Run locally

```bash
cd backend
npm install
cp .env.example .env
# (optional) edit .env — change ADMIN_TOKEN to a long random string
npm run dev
```

The server starts at **http://localhost:3000**.

Test it:
```bash
curl http://localhost:3000/api/health
```

---

## Environment variables

| Variable | Required? | Description |
|---|---|---|
| `PORT` | No (defaults to 3000) | Port to listen on. Railway sets this automatically. |
| `DATABASE_URL` | Recommended | Postgres connection string. Auto-set by Railway’s Postgres plugin. If empty, the server uses an in-memory store. |
| `CORS_ORIGINS` | Yes (in prod) | Comma-separated list of frontend origins allowed to call the API (e.g. `https://greenzone.netlify.app,https://greenzone.com`). Chrome extensions are allowed automatically. Any `*.netlify.app` URL is also allowed (for deploy previews). |
| `ADMIN_TOKEN` | Yes | Secret token the extension must send in the `X-Admin-Token` header to POST or DELETE bets. Generate one with `openssl rand -hex 32`. |

---

## API endpoints

### `GET /api/health`
Health check. Returns `{ ok: true, service: "greenzone-api", time: "..." }`.

### `GET /api/bets`
Public. Returns the latest 100 bets, newest first.

```bash
curl https://your-app.up.railway.app/api/bets
```

Response:
```json
{
  "bets": [
    {
      "id": 1,
      "league": "Premier League",
      "team1": "Arsenal",
      "team2": "Chelsea",
      "betType": "Total Goals",
      "market": "Over 2.5",
      "matchTime": "2025-12-01T20:00:00.000Z",
      "result": "win",
      "createdAt": "2026-05-13T15:29:16.589Z"
    }
  ]
}
```

### `POST /api/bets`
Requires `X-Admin-Token` header. Creates a new bet.

```bash
curl -X POST https://your-app.up.railway.app/api/bets \
  -H "Content-Type: application/json" \
  -H "X-Admin-Token: your-admin-token" \
  -d '{
    "league": "Premier League",
    "team1": "Arsenal",
    "team2": "Chelsea",
    "betType": "Total Goals",
    "market": "Over 2.5",
    "matchTime": "2025-12-01T20:00:00Z",
    "result": "win"
  }'
```

### `DELETE /api/bets/:id`
Requires `X-Admin-Token` header. Removes a bet by id.

```bash
curl -X DELETE https://your-app.up.railway.app/api/bets/3 \
  -H "X-Admin-Token: your-admin-token"
```

---

## Deploy to Railway (terminal-only)

See **section E** of the root [`README.md`](../README.md) for the step-by-step walkthrough.

Quick reference:
```bash
railway login
cd backend
railway init
# Then via the UI: add a PostgreSQL plugin (railway open → + Create → Database → PostgreSQL)
railway variables --set "ADMIN_TOKEN=$(openssl rand -hex 32)"
railway variables --set "CORS_ORIGINS=https://greenzone.netlify.app"
railway up
railway domain  # copy this URL — you need it for the frontend and extension
```

---

## File layout

```
backend/
├── src/
│   ├── server.js     ← Express app, routes, CORS, auth middleware
│   └── db.js         ← Postgres + in-memory fallback
├── .env.example      ← copy to .env for local dev
├── package.json
├── Procfile          ← Railway start command
└── railway.json      ← Railway deploy config
```

---

## Why Postgres (instead of SQLite)?

Railway’s filesystem is ephemeral — files written to disk are wiped on every redeploy. SQLite would need a Railway Volume to persist, which costs more and adds complexity. Railway’s managed Postgres plugin is free on the hobby tier, autobackup-friendly, and exposes `DATABASE_URL` automatically. For a project this size, it’s the simplest reliable choice.

For **local dev** we don’t require Postgres — the in-memory fallback works fine for testing, and `DATABASE_URL` set to a local Postgres URL works if you want persistence.
