// routes/track.js — Public visit-tracking beacon.
//
//   POST /api/track   public + trackLimiter
//   body (optional): { path?: string, referrer?: string }
//
// The frontend fires this once per public landing-page load (via navigator.sendBeacon
// or fetch with keepalive). It always returns 204 quickly — the client doesn't care
// about the result, and we never want tracking to slow down or error a page view.

import express from 'express';
import { trackVisitFromRequest } from '../middleware/visitTracker.js';

const router = express.Router();

// POST /api/track
router.post('/', async (req, res) => {
  // Fire-and-forget: respond immediately, persist in the background.
  res.status(204).end();
  trackVisitFromRequest(req);
});

export default router;