// routes/admin.js — Admin-only endpoints.
// All routes here are gated by requireAdmin (JWT role=admin + email in env allowlist).

import express from 'express';
import { countUsers, listUsersPaginated } from '../db.js';
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

export default router;