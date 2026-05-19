// routes/auth.js — All authentication endpoints.
//
// Endpoints (all under /api/auth):
//   POST   /signup
//   POST   /login
//   POST   /logout
//   GET    /me
//   POST   /refresh
//   POST   /request-password-reset
//   POST   /reset-password

import express from 'express';
import { z } from 'zod';

import {
  findUserByEmail, findUserById, createUser, updateUserPassword,
  insertRefreshToken, findActiveRefreshToken, revokeRefreshTokenById, revokeAllUserRefreshTokens,
  insertPasswordReset, findActivePasswordReset, markPasswordResetUsed,
} from '../db.js';

import {
  hashPassword, verifyPassword,
  signAccessToken, signRefreshToken, verifyRefreshToken,
  sha256, generateResetToken,
  cookieOptions, ACCESS_COOKIE, REFRESH_COOKIE,
  ACCESS_TOKEN_TTL_MS, REFRESH_TOKEN_TTL_MS,
  getAdminByEmail,
} from '../lib/auth.js';

import { sendPasswordResetEmail } from '../lib/mailer.js';

import {
  loginLimiter, signupLimiter,
  resetRequestLimiter, resetConfirmLimiter,
} from '../middleware/rateLimiters.js';

import { requireUser } from '../middleware/authMiddleware.js';

const router = express.Router();

// ── Validation schemas ────────────────────────────────────────────

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .email();

const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(200);

const signupSchema = z.object({
  fullName: z.string().trim().min(2, 'Please enter your full name').max(120),
  email: emailSchema,
  password: passwordSchema,
  acceptedTerms: z.literal(true, {
    errorMap: () => ({ message: 'You must accept the Terms & Conditions' }),
  }),
});

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
});

const requestResetSchema = z.object({
  email: emailSchema,
});

const resetPasswordSchema = z.object({
  token: z.string().min(32).max(128),
  password: passwordSchema,
});

function firstZodError(err) {
  return err?.issues?.[0]?.message || 'Invalid request';
}

// ── Helpers ──────────────────────────────────────────────────────

async function issueSession(res, { sub, role, email }) {
  const accessToken = signAccessToken({ sub, role, email });
  const refreshToken = signRefreshToken({ sub, role, email });

  // Persist the hashed refresh token so we can revoke it.
  // (Only for real users; admins are env-only and have no DB user_id to link to.)
  if (role === 'user') {
    await insertRefreshToken({
      userId: Number(sub),
      tokenHash: sha256(refreshToken),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    });
  }

  res.cookie(ACCESS_COOKIE, accessToken, cookieOptions({ maxAgeMs: ACCESS_TOKEN_TTL_MS }));
  res.cookie(REFRESH_COOKIE, refreshToken, cookieOptions({ maxAgeMs: REFRESH_TOKEN_TTL_MS }));
}

function clearSessionCookies(res) {
  res.clearCookie(ACCESS_COOKIE, cookieOptions({ maxAgeMs: 0 }));
  res.clearCookie(REFRESH_COOKIE, cookieOptions({ maxAgeMs: 0 }));
}

// ── POST /signup ─────────────────────────────────────────────────

router.post('/signup', signupLimiter, async (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: firstZodError(parsed.error) });

  const { fullName, email, password } = parsed.data;

  // Reject if the email matches a hardcoded admin slot — admins don't get user accounts.
  if (getAdminByEmail(email)) {
    // Generic message — don't reveal "this is an admin email".
    return res.status(400).json({ error: 'Unable to create account with the provided information.' });
  }

  const existing = await findUserByEmail(email);
  if (existing) {
    // Pragmatic enumeration protection — generic message, no mention of "email taken".
    return res.status(400).json({ error: 'Unable to create account with the provided information.' });
  }

  try {
    const passwordHash = await hashPassword(password);
    const user = await createUser({ fullName, email, passwordHash });

    await issueSession(res, { sub: String(user.id), role: 'user', email: user.email });

    res.status(201).json({
      user: { id: user.id, fullName: user.fullName, email: user.email, role: 'user' },
    });
  } catch (err) {
    console.error('signup failed:', err);
    res.status(500).json({ error: 'Signup failed' });
  }
});

// ── POST /login ──────────────────────────────────────────────────

router.post('/login', loginLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    // Same generic message — never specify "email format invalid" etc.
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const { email, password } = parsed.data;

  // 1) Admin path — check env-only credentials first.
  const admin = getAdminByEmail(email);
  if (admin) {
    const ok = await verifyPassword(password, admin.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

    // Admin "sub" is the email (no DB row to use as id).
    await issueSession(res, { sub: admin.email, role: 'admin', email: admin.email });
    return res.json({
      user: { id: null, fullName: null, email: admin.email, role: 'admin' },
    });
  }

  // 2) Regular user path.
  const user = await findUserByEmail(email);

  // Always run a bcrypt compare — even if the user doesn't exist — so response
  // timing doesn't leak account existence.
  const ok = await verifyPassword(password, user?.passwordHash);
  if (!user || !ok) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  await issueSession(res, { sub: String(user.id), role: 'user', email: user.email });
  res.json({
    user: { id: user.id, fullName: user.fullName, email: user.email, role: 'user' },
  });
});

// ── POST /logout ─────────────────────────────────────────────────

router.post('/logout', async (req, res) => {
  // Revoke the refresh token in DB if we have one.
  const refresh = req.cookies?.[REFRESH_COOKIE];
  if (refresh) {
    const tokenHash = sha256(refresh);
    const row = await findActiveRefreshToken(tokenHash);
    if (row) await revokeRefreshTokenById(row.id);
  }
  clearSessionCookies(res);
  res.json({ ok: true });
});

// ── GET /me ──────────────────────────────────────────────────────

router.get('/me', requireUser, async (req, res) => {
  const { sub, role, email } = req.user;

  if (role === 'admin') {
    // Admin payload — no DB row to fetch from.
    return res.json({ user: { id: null, fullName: null, email, role: 'admin' } });
  }

  const user = await findUserById(sub);
  if (!user) {
    // Token references a user that no longer exists — clear cookies and 401.
    clearSessionCookies(res);
    return res.status(401).json({ error: 'Authentication required' });
  }
  res.json({
    user: { id: user.id, fullName: user.fullName, email: user.email, role: 'user' },
  });
});

// ── POST /refresh ────────────────────────────────────────────────
// Rotates the refresh token. Issues a new access + refresh cookie pair.

router.post('/refresh', async (req, res) => {
  const refresh = req.cookies?.[REFRESH_COOKIE];
  if (!refresh) return res.status(401).json({ error: 'Authentication required' });

  const payload = verifyRefreshToken(refresh);
  if (!payload) {
    clearSessionCookies(res);
    return res.status(401).json({ error: 'Authentication required' });
  }

  // Admin tokens don't have DB-backed refresh rows. Just re-issue.
  if (payload.role === 'admin') {
    // Re-verify the admin is still configured in env.
    if (!getAdminByEmail(payload.email)) {
      clearSessionCookies(res);
      return res.status(401).json({ error: 'Authentication required' });
    }
    await issueSession(res, { sub: payload.email, role: 'admin', email: payload.email });
    return res.json({ ok: true });
  }

  // User tokens: must exist + not be revoked + not be expired in DB.
  const tokenHash = sha256(refresh);
  const row = await findActiveRefreshToken(tokenHash);
  if (!row) {
    // Stolen / replayed / revoked. Clear cookies and bail.
    clearSessionCookies(res);
    return res.status(401).json({ error: 'Authentication required' });
  }

  // Rotate: revoke the old, issue a new one (issueSession inserts new row).
  await revokeRefreshTokenById(row.id);

  const user = await findUserById(payload.sub);
  if (!user) {
    clearSessionCookies(res);
    return res.status(401).json({ error: 'Authentication required' });
  }
  await issueSession(res, { sub: String(user.id), role: 'user', email: user.email });
  res.json({ ok: true });
});

// ── POST /request-password-reset ────────────────────────────────

router.post('/request-password-reset', resetRequestLimiter, async (req, res) => {
  const parsed = requestResetSchema.safeParse(req.body);
  // Always return the same generic message, even for malformed emails.
  const genericResponse = {
    message: 'If an account with that email exists, a reset link has been sent.',
  };

  if (!parsed.success) return res.json(genericResponse);

  const { email } = parsed.data;

  // Admin emails: don't issue resets via this flow. They're env-managed.
  // Still return the same generic message.
  if (getAdminByEmail(email)) return res.json(genericResponse);

  const user = await findUserByEmail(email);
  if (!user) return res.json(genericResponse);

  try {
    const rawToken = generateResetToken();
    const tokenHash = sha256(rawToken);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await insertPasswordReset({ userId: user.id, tokenHash, expiresAt });

    const appUrl = (process.env.APP_URL || 'http://localhost:5173').replace(/\/+$/, '');
    const resetUrl = `${appUrl}/reset-password?token=${rawToken}`;

    await sendPasswordResetEmail({ to: user.email, resetUrl, fullName: user.fullName });
  } catch (err) {
    // Never reveal email errors to the client.
    console.error('request-password-reset failed:', err);
  }

  res.json(genericResponse);
});

// ── POST /reset-password ────────────────────────────────────────

router.post('/reset-password', resetConfirmLimiter, async (req, res) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
  }

  const { token, password } = parsed.data;
  const tokenHash = sha256(token);

  const reset = await findActivePasswordReset(tokenHash);
  if (!reset) {
    return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
  }

  try {
    const newHash = await hashPassword(password);
    await updateUserPassword(reset.userId, newHash);
    await markPasswordResetUsed(reset.id);
    // Invalidate all existing sessions for this user — anyone holding a refresh
    // token loses access immediately.
    await revokeAllUserRefreshTokens(reset.userId);

    res.json({ ok: true });
  } catch (err) {
    console.error('reset-password failed:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

export default router;