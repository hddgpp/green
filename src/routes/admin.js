// routes/admin.js — Admin-only endpoints.
// All routes here are gated by requireAdmin (JWT role=admin + email in env allowlist).

import express from 'express';
import {
  countUsers,
  listUsersPaginated,
  getVisitSummary,
  getVisitTimeSeries,
  listVisitorsPaginated,
} from '../db.js';
import { requireAdmin } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(requireAdmin);

// GET /api/admin/stats
router.get('/stats', async (_req, res) => {
  try {
    const totalUsers = await countUsers();
    res.json({ totalUsers });
  } catch (err) {
    console.error('GET /api/admin/stats failed:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// GET /api/admin/users?page=1&limit=25
router.get('/users', async (req, res) => {
  try {
    const data = await listUsersPaginated({
      page: req.query.page,
      limit: req.query.limit,
    });
    res.json(data);
  } catch (err) {
    console.error('GET /api/admin/users failed:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ─── Analytics ────────────────────────────────────────────────────

// GET /api/admin/analytics/summary → { today, month, year, total }
router.get('/analytics/summary', async (_req, res) => {
  try {
    const summary = await getVisitSummary();
    res.json(summary);
  } catch (err) {
    console.error('GET /api/admin/analytics/summary failed:', err);
    res.status(500).json({ error: 'Failed to fetch analytics summary' });
  }
});

// GET /api/admin/analytics/timeseries?interval=day|week|month|year
//   → { interval, series: [{ bucket, visits, uniques }] }
router.get('/analytics/timeseries', async (req, res) => {
  try {
    const allowed = ['day', 'week', 'month', 'year'];
    const interval = allowed.includes(req.query.interval) ? req.query.interval : 'day';
    const series = await getVisitTimeSeries({ interval, points: req.query.points });
    res.json({ interval, series });
  } catch (err) {
    console.error('GET /api/admin/analytics/timeseries failed:', err);
    res.status(500).json({ error: 'Failed to fetch analytics timeseries' });
  }
});

// GET /api/admin/analytics/visitors?page=&limit=&search=&sort=&dir=
//   → { rows, total, page, limit }
router.get('/analytics/visitors', async (req, res) => {
  try {
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 120) : '';
    const sort = ['recent', 'visits'].includes(req.query.sort) ? req.query.sort : 'recent';
    const dir = ['asc', 'desc'].includes(req.query.dir) ? req.query.dir : 'desc';
    const data = await listVisitorsPaginated({
      search,
      sort,
      dir,
      page: req.query.page,
      limit: req.query.limit,
    });
    res.json(data);
  } catch (err) {
    console.error('GET /api/admin/analytics/visitors failed:', err);
    res.status(500).json({ error: 'Failed to fetch visitors' });
  }
});

export default router;