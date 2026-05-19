// routes/bets.js — Bets endpoints.
//
// CONTRACT PRESERVATION:
//   - GET /api/bets with NO query params returns { bets: [...] } (latest 100)
//     so the existing frontend BetFeed and any other consumer keeps working.
//   - POST /api/bets and DELETE /api/bets/:id are byte-for-byte unchanged.
//     The extension's X-Admin-Token flow is untouched.
//
// NEW:
//   - GET /api/bets?page=1&limit=30&search=arsenal&result=win
//     returns { rows, total, page, limit }
//   - GET /api/bets/stats returns { total, wins, losses }

import express from 'express';
import { listBets, listBetsPaginated, getBetStats, createBet, deleteBet } from '../db.js';

const router = express.Router();

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'change-me-to-a-long-random-string';

function requireExtensionAdmin(req, res, next) {
  const token = req.header('X-Admin-Token');
  if (!token || token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized: invalid or missing X-Admin-Token' });
  }
  next();
}

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
  for (const f of ['league', 'team1', 'team2', 'betType', 'market']) {
    if (body[f] && body[f].length > 120) errors.push(`Field too long: ${f}`);
  }
  return errors;
}

// GET /api/bets
//   - No query params → legacy shape: { bets: [...] }, latest 100 (or `limit`).
//   - With page/search/result → paginated shape: { rows, total, page, limit }.
router.get('/', async (req, res) => {
  try {
    const hasPagination =
      req.query.page !== undefined ||
      req.query.search !== undefined ||
      req.query.result !== undefined;

    if (!hasPagination) {
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
      const bets = await listBets(limit);
      return res.json({ bets });
    }

    const result = ['win', 'loss'].includes(req.query.result) ? req.query.result : null;
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 120) : '';
    const data = await listBetsPaginated({
      search,
      result,
      page: req.query.page,
      limit: req.query.limit,
    });
    res.json(data);
  } catch (err) {
    console.error('GET /api/bets failed:', err);
    res.status(500).json({ error: 'Failed to fetch bets' });
  }
});

// GET /api/bets/stats — totals for the full-history page.
router.get('/stats', async (_req, res) => {
  try {
    const stats = await getBetStats();
    res.json(stats);
  } catch (err) {
    console.error('GET /api/bets/stats failed:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// POST /api/bets — UNCHANGED (extension contract).
router.post('/', requireExtensionAdmin, async (req, res) => {
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

// DELETE /api/bets/:id — UNCHANGED (extension contract).
router.delete('/:id', requireExtensionAdmin, async (req, res) => {
  try {
    const ok = await deleteBet(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Bet not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/bets/:id failed:', err);
    res.status(500).json({ error: 'Failed to delete bet' });
  }
});

export default router;