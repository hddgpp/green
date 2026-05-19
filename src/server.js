// server.js — GreenZone API entry point.
//
// Mounted routes:
//   /api/health                  GET   public
//   /api/bets                    GET   public (latest 100 or paginated)
//   /api/bets/stats              GET   public (totals)
//   /api/bets                    POST  X-Admin-Token (extension)
//   /api/bets/:id                DEL   X-Admin-Token (extension)
//   /api/auth/signup             POST  public + rate-limited
//   /api/auth/login              POST  public + rate-limited
//   /api/auth/logout             POST  public
//   /api/auth/me                 GET   user/admin JWT
//   /api/auth/refresh            POST  refresh cookie
//   /api/auth/request-password-reset POST public + rate-limited
//   /api/auth/reset-password     POST  public + rate-limited
//   /api/admin/stats             GET   admin JWT
//   /api/admin/users             GET   admin JWT

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';

import { initDb } from './db.js';
import { generalLimiter } from './middleware/rateLimiters.js';

import authRoutes from './routes/auth.js';
import betsRoutes from './routes/bets.js';
import adminRoutes from './routes/admin.js';

const app = express();
const PORT = process.env.PORT || 3000;

// trust proxy — Railway/Netlify sit behind a load balancer.
// Required for express-rate-limit to read the real IP from X-Forwarded-For,
// and for Secure cookies to be set correctly.
app.set('trust proxy', 1);

// ─── Security headers ─────────────────────────────────────────────
app.use(helmet({
  // We don't serve HTML, so CSP and a few other defaults don't apply.
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// ─── CORS ────────────────────────────────────────────────────────
// IMPORTANT: with httpOnly cookies and credentials:'include', credentialed CORS
// FORBIDS wildcards. We now require explicit origins. The previous
// regex match for *.netlify.app is removed — list deploy preview URLs
// explicitly in CORS_ORIGINS if you need them.
const allowList = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // No-origin requests (curl, server-to-server). Safe — no cookie context.
      if (!origin) return callback(null, true);
      // Extension's own origin — the extension uses X-Admin-Token, not cookies.
      if (origin.startsWith('chrome-extension://')) return callback(null, true);
      if (allowList.includes(origin)) return callback(null, true);
      return callback(new Error(`CORS: origin not allowed: ${origin}`));
    },
    credentials: true, // ← required for cookies
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Admin-Token'],
  })
);

// ─── Body + cookie parsing ────────────────────────────────────────
app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());

// ─── Global rate limit ───────────────────────────────────────────
app.use('/api/', generalLimiter);

// ─── Routes ──────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'greenzone-api', time: new Date().toISOString() });
});

app.use('/api/auth', authRoutes);
app.use('/api/bets', betsRoutes);
app.use('/api/admin', adminRoutes);

// Root pinger so Railway/Netlify health checks pass.
app.get('/', (_req, res) => res.json({ service: 'greenzone-api', status: 'running' }));

// ─── 404 + global error handlers ─────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  // CORS errors land here as 500s by default — coerce to 403 with a clean message.
  if (err && /^CORS:/.test(err.message)) {
    return res.status(403).json({ error: err.message });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Boot ────────────────────────────────────────────────────────
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