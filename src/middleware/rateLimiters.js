// rateLimiters.js — express-rate-limit instances per route.
//
// Limits (production defaults):
//   - Login:          5 per 15 min (per IP)
//   - Signup:         5 per hour (per IP)
//   - Reset request:  3 per hour (per IP)
//   - Reset confirm:  10 per hour (per IP)
//   - General API:   100 per minute (per IP)
//   - Track beacon:   60 per minute (per IP)
//
// For automated tests, set RATE_LIMIT_DISABLED=true to use very high limits
// (10000 per window). This env flag is NEVER set in production — defaults apply.

import rateLimit from 'express-rate-limit';

const TEST_MODE = process.env.RATE_LIMIT_DISABLED === 'true';
const HIGH = 10000;

const json = (_req, res) =>
  res.status(429).json({ error: 'Too many requests. Please try again later.' });

function build({ windowMs, max }) {
  return rateLimit({
    windowMs,
    max: TEST_MODE ? HIGH : max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: json,
  });
}

export const loginLimiter = build({ windowMs: 15 * 60 * 1000, max: 5 });
export const signupLimiter = build({ windowMs: 60 * 60 * 1000, max: 5 });
export const resetRequestLimiter = build({ windowMs: 60 * 60 * 1000, max: 3 });
export const resetConfirmLimiter = build({ windowMs: 60 * 60 * 1000, max: 10 });
export const generalLimiter = build({ windowMs: 60 * 1000, max: 100 });

// Track beacon: generous per-IP allowance. A real visitor fires this a handful
// of times per session; 60/min/IP absorbs SPA navigation bursts while still
// capping abuse. The beacon also returns 204 before doing any DB work.
export const trackLimiter = build({ windowMs: 60 * 1000, max: 60 });