// visitTracker.js — Builds a normalized visit record from an incoming request
// and persists it via db.recordVisit(). Used by the public POST /api/track beacon.
//
// Privacy model (GDPR-conscious, EU operator):
//   - We resolve geo from the FULL ip (in-memory only), then store a TRUNCATED ip
//     by default (STORE_RAW_IP !== 'true'). Truncated IPs are not considered
//     personally identifying, so no consent banner is required.
//   - visitor_id is a salted daily hash of (ip + userAgent). Because the salt
//     rotates daily, it de-dupes a visitor *within a day* for "unique visitor"
//     counts WITHOUT being a durable cross-day fingerprint or a stored cookie.

import crypto from 'crypto';
import { getClientIp, lookupGeo, truncateIp } from '../lib/geolocation.js';
import { recordVisit } from '../db.js';

const STORE_RAW_IP = process.env.STORE_RAW_IP === 'true';
const VISIT_SALT = process.env.VISIT_SALT || 'greenzone-default-salt-change-me';

// YYYY-MM-DD in UTC — used to rotate the visitor hash daily.
function utcDayStamp(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function makeVisitorId(rawIp, userAgent) {
  return crypto
    .createHash('sha256')
    .update(`${rawIp}|${userAgent || ''}|${VISIT_SALT}|${utcDayStamp()}`)
    .digest('hex')
    .slice(0, 32);
}

// Pull a visit record out of the request + optional JSON body, persist it.
// Never throws — analytics must never break a user's page load.
export async function trackVisitFromRequest(req) {
  try {
    const rawIp = getClientIp(req);
    const userAgent = req.headers['user-agent'] || '';

    const { country, city } = lookupGeo(rawIp);
    const ipDisplay = STORE_RAW_IP ? rawIp : truncateIp(rawIp);
    const visitorId = makeVisitorId(rawIp, userAgent);

    const body = req.body || {};
    const path = typeof body.path === 'string' ? body.path.slice(0, 512) : null;
    const referrer = typeof body.referrer === 'string' ? body.referrer.slice(0, 512) : null;

    await recordVisit({
      visitorId,
      ipDisplay,
      country,
      city,
      path,
      referrer,
    });
    return true;
  } catch (err) {
    console.error('[track] failed to record visit:', err);
    return false;
  }
}