// authMiddleware.js — Express middleware that reads the gz_access cookie,
// verifies the JWT, and attaches req.user = { sub, role, email } if valid.
//
// requireUser:  401 if missing or invalid token, or if token role is not 'user' or 'admin'.
// requireAdmin: 401 if missing/invalid, 403 if role is not 'admin' OR email is not in env allowlist.

import { verifyAccessToken, ACCESS_COOKIE, isAdminEmail } from '../lib/auth.js';

function readAccessToken(req) {
  // Primary: cookie. Fallback: Authorization: Bearer (handy for curl, never used by the web app).
  const fromCookie = req.cookies?.[ACCESS_COOKIE];
  if (fromCookie) return fromCookie;
  const authHeader = req.header('Authorization') || '';
  if (authHeader.startsWith('Bearer ')) return authHeader.slice(7);
  return null;
}

export function attachUser(req, _res, next) {
  const token = readAccessToken(req);
  if (token) {
    const payload = verifyAccessToken(token);
    if (payload) req.user = payload;
  }
  next();
}

export function requireUser(req, res, next) {
  const token = readAccessToken(req);
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  const payload = verifyAccessToken(token);
  if (!payload) return res.status(401).json({ error: 'Authentication required' });
  req.user = payload;
  next();
}

export function requireAdmin(req, res, next) {
  const token = readAccessToken(req);
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  const payload = verifyAccessToken(token);
  if (!payload) return res.status(401).json({ error: 'Authentication required' });

  // Belt-and-braces: even if someone forges a JWT with role=admin, we re-check the
  // email against the env allowlist on every admin request.
  if (payload.role !== 'admin' || !payload.email || !isAdminEmail(payload.email)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  req.user = payload;
  next();
}