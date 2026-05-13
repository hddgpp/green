// server.js — GreenZone API
// Endpoints:
//   GET    /api/health        → healthcheck
//   GET    /api/bets          → list latest bets (public)
//   POST   /api/bets          → create a bet (requires X-Admin-Token)
//   DELETE /api/bets/:id      → delete a bet (requires X-Admin-Token)

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { initDb, listBets, createBet, deleteBet } from './db.js';

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'change-me-to-a-long-random-string';

// ---------- CORS ----------
// Allow:
//   - any origin listed in CORS_ORIGINS (comma-separated)
//   - any chrome-extension:// origin (so the extension can post bets)
//   - no-origin requests (curl, server-to-server, mobile)
const allowList = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (origin.startsWith('chrome-extension://')) return callback(null, true);
      if (allowList.includes(origin)) return callback(null, true);
      // Also allow netlify preview URLs by default — they look like https://deploy-preview-X--site.netlify.app
      if (/\.netlify\.app$/.test(new URL(origin).hostname)) return callback(null, true);
      return callback(new Error(`CORS: origin not allowed: ${origin}`));
    },
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Admin-Token'],
  })
);

app.use(express.json({ limit: '64kb' }));

// ---------- Auth middleware for write routes ----------
function requireAdmin(req, res, next) {
  const token = req.header('X-Admin-Token');
  if (!token || token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized: invalid or missing X-Admin-Token' });
  }
  next();
}

// ---------- Validation ----------
function validateBet(body) {
  const errors = [];
  const required = ['league', 'team1', 'team2', 'betType', 'market', 'matchTime', 'result'];
  for (const f of required) {
    if (!body[f] || typeof body[f] !== 'string') errors.push(`Missing/invalid field: ${f}`);
  }
  if (body.result && !['win', 'loss'].includes(body.result)) {
    errors.push("'result' must be 'win' or 'loss'");
  }
  if (body.matchTime && isNaN(Date.parse(body.matchTime))) {
    errors.push("'matchTime' must be a valid ISO date string");
  }
  // Length caps to avoid abuse
  for (const f of ['league', 'team1', 'team2', 'betType', 'market']) {
    if (body[f] && body[f].length > 120) errors.push(`Field too long: ${f}`);
  }
  return errors;
}

// ---------- Routes ----------
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'greenzone-api', time: new Date().toISOString() });
});

app.get('/api/bets', async (_req, res) => {
  try {
    const bets = await listBets(100);
    res.json({ bets });
  } catch (err) {
    console.error('GET /api/bets failed:', err);
    res.status(500).json({ error: 'Failed to fetch bets' });
  }
});

app.post('/api/bets', requireAdmin, async (req, res) => {
  const errors = validateBet(req.body);
  if (errors.length) return res.status(400).json({ errors });

  try {
    const bet = await createBet(req.body);
    res.status(201).json({ bet });
  } catch (err) {
    console.error('POST /api/bets failed:', err);
    res.status(500).json({ error: 'Failed to create bet' });
  }
});

app.delete('/api/bets/:id', requireAdmin, async (req, res) => {
  try {
    const ok = await deleteBet(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Bet not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/bets/:id failed:', err);
    res.status(500).json({ error: 'Failed to delete bet' });
  }
});

// Root pinger so Railway/Netlify health checks work
app.get('/', (_req, res) => res.json({ service: 'greenzone-api', status: 'running' }));

// ---------- Boot ----------
(async () => {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`[server] GreenZone API listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
})();
