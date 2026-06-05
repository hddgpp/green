// geolocation.js — Resolve an IP address to { country, city } using geoip-lite.
//
// geoip-lite ships an offline MaxMind GeoLite database, so there are NO external
// API calls, no rate limits, and no third party ever receives your visitors' IPs
// (a GDPR plus). Lookups are cached in-memory for the process lifetime to keep
// the hot path cheap.
//
// We import geoip-lite lazily/defensively: if the package isn't installed yet
// (e.g. before `npm i geoip-lite`), the module still loads and simply returns
// nulls instead of crashing the server.

let geoip = null;
try {
  // eslint-disable-next-line import/no-extraneous-dependencies
  const mod = await import('geoip-lite');
  geoip = mod.default || mod;
} catch {
  console.warn('[geo] geoip-lite not installed — country/city will be null. Run: npm i geoip-lite');
}

// Simple unbounded-but-tiny cache. IPs seen this process run resolve instantly.
// Keys are the *raw* IP (we look up before truncation). Values are { country, city }.
const cache = new Map();
const MAX_CACHE = 50_000; // hard cap so a flood of unique IPs can't grow memory forever.

// Pull the client IP out of the request. We trust X-Forwarded-For because
// `app.set('trust proxy', 1)` is configured in server.js (Railway/Netlify edge).
export function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) {
    // XFF can be "client, proxy1, proxy2" — the first entry is the real client.
    return xff.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || '';
}

// Look up { country, city } for a raw IP. Returns nulls on miss or if geoip is absent.
export function lookupGeo(rawIp) {
  if (!rawIp || !geoip) return { country: null, city: null };

  if (cache.has(rawIp)) return cache.get(rawIp);

  let result = { country: null, city: null };
  try {
    const geo = geoip.lookup(rawIp);
    if (geo) {
      result = {
        country: geo.country || null, // ISO-3166 alpha-2, e.g. "MA", "CH"
        city: geo.city || null,
      };
    }
  } catch {
    /* malformed IP — leave nulls */
  }

  if (cache.size < MAX_CACHE) cache.set(rawIp, result);
  return result;
}

// Truncate an IP for privacy-preserving storage (GDPR-friendly).
//   IPv4: drop the last octet      → 41.248.120.5   => 41.248.120.0
//   IPv6: keep the first 3 hextets → 2a01:e0a:...   => 2a01:e0a:1234::
export function truncateIp(rawIp) {
  if (!rawIp) return null;

  // IPv4-mapped IPv6 (::ffff:1.2.3.4) → treat as IPv4.
  const v4mapped = rawIp.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const ip = v4mapped ? v4mapped[1] : rawIp;

  if (ip.includes('.')) {
    const parts = ip.split('.');
    if (parts.length === 4) {
      parts[3] = '0';
      return parts.join('.');
    }
    return ip;
  }

  if (ip.includes(':')) {
    const hextets = ip.split(':');
    return hextets.slice(0, 3).join(':') + '::';
  }

  return ip;
}