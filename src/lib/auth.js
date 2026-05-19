// auth.js — Authentication utilities.
//
// JWT strategy:
//   - Access token:  15 min, signed with JWT_ACCESS_SECRET,  stored in httpOnly cookie "gz_access"
//   - Refresh token: 30 days, signed with JWT_REFRESH_SECRET, stored in httpOnly cookie "gz_refresh"
//   - Refresh tokens are also stored hashed in DB (refresh_tokens table) so we can revoke them.
//   - On /refresh we rotate the refresh token (issue a new one, revoke the old).
//
// Passwords: bcrypt cost 12.
//
// Admin: env-only. Three slots (ADMIN_1_*, ADMIN_2_*, ADMIN_3_*). Admins are NOT
// rows in the users table. They authenticate via the same login endpoint but the
// endpoint checks env first and issues a JWT with role="admin".

import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const BCRYPT_COST = 12;

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-me';
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret-change-me';

export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 min
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Dummy bcrypt hash used to equalize timing when a user doesn't exist on login.
// Generated once at module load. The plaintext doesn't matter — we never compare against it.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing-equalization', BCRYPT_COST);

// ── Passwords ──────────────────────────────────────────────────────

export async function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_COST);
}

export async function verifyPassword(plain, hash) {
  if (!hash) {
    // Run a compare anyway so timing is identical to a real check.
    await bcrypt.compare(plain, DUMMY_HASH);
    return false;
  }
  return bcrypt.compare(plain, hash);
}

// ── JWT ────────────────────────────────────────────────────────────

// payload: { sub: <userId|adminEmail>, role: 'user'|'admin', email }
export function signAccessToken(payload) {
  return jwt.sign(payload, ACCESS_SECRET, { expiresIn: '15m' });
}

export function verifyAccessToken(token) {
  try {
    return jwt.verify(token, ACCESS_SECRET);
  } catch {
    return null;
  }
}

export function signRefreshToken(payload) {
  return jwt.sign(payload, REFRESH_SECRET, { expiresIn: '30d' });
}

export function verifyRefreshToken(token) {
  try {
    return jwt.verify(token, REFRESH_SECRET);
  } catch {
    return null;
  }
}

// ── Hashing tokens for DB storage ──
// We store SHA-256 of the refresh token / reset token in the DB.
// The raw token lives only in the user's cookie / email link.
export function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// Cryptographically random token for password reset links.
export function generateResetToken() {
  return crypto.randomBytes(32).toString('hex'); // 64 hex chars
}

// ── Admin env lookup ──────────────────────────────────────────────

// Returns admin record { email, passwordHash } if the email matches one of the
// three configured ADMIN_*_EMAIL env vars (case-insensitive), else null.
export function getAdminByEmail(email) {
  const target = String(email || '').trim().toLowerCase();
  if (!target) return null;
  for (let i = 1; i <= 3; i++) {
    const envEmail = (process.env[`ADMIN_${i}_EMAIL`] || '').trim().toLowerCase();
    const envHash = process.env[`ADMIN_${i}_PASSWORD_HASH`] || '';
    if (envEmail && envHash && envEmail === target) {
      return { email: envEmail, passwordHash: envHash };
    }
  }
  return null;
}

export function isAdminEmail(email) {
  return getAdminByEmail(email) !== null;
}

// ── Cookie helpers ────────────────────────────────────────────────

const isProd = () => process.env.NODE_ENV === 'production';

export function cookieOptions({ maxAgeMs }) {
  const opts = {
    httpOnly: true,
    secure: isProd(), // required for SameSite=None
    sameSite: isProd() ? 'none' : 'lax', // cross-site in prod (Netlify ↔ Railway), lax in local dev
    path: '/',
    maxAge: maxAgeMs,
  };
  if (process.env.COOKIE_DOMAIN) opts.domain = process.env.COOKIE_DOMAIN;
  return opts;
}

export const ACCESS_COOKIE = 'gz_access';
export const REFRESH_COOKIE = 'gz_refresh';