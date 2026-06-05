// db.js — Database layer.
// Postgres in production (DATABASE_URL set); in-memory fallback otherwise.
//
// Tables: bets, users, refresh_tokens, password_resets, visits
// All schema is created in initDb() with idempotent CREATE TABLE IF NOT EXISTS.

import pg from 'pg';

const { Pool } = pg;

let pool = null;
const memory = {
  bets: [],
  betIdSeq: 1,
  users: [],
  userIdSeq: 1,
  refreshTokens: [], // { id, userId, tokenHash, expiresAt, revokedAt, createdAt }
  refreshIdSeq: 1,
  passwordResets: [], // { id, userId, tokenHash, expiresAt, usedAt, createdAt }
  resetIdSeq: 1,
  visits: [], // { id, visitorId, ipDisplay, country, city, path, referrer, createdAt }
  visitIdSeq: 1,
};

const useMemory = !process.env.DATABASE_URL;

if (!useMemory) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost')
      ? false
      : { rejectUnauthorized: false },
  });

  // Every new connection in the pool runs `SET search_path = greenzone`.
  // This means all unqualified table names (bets, users, etc.) resolve
  // to the greenzone schema. Other apps using `public` are unaffected.
  pool.on('connect', (client) => {
    client.query('SET search_path TO greenzone, public');
  });
}

export async function initDb() {
  if (useMemory) {
    console.log('[db] DATABASE_URL not set — using in-memory store (data resets on restart).');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bets (
      id           SERIAL PRIMARY KEY,
      league       TEXT NOT NULL,
      team1        TEXT NOT NULL,
      team2        TEXT NOT NULL,
      bet_type     TEXT NOT NULL,
      market       TEXT NOT NULL,
      match_time   TIMESTAMPTZ NOT NULL,
      result       TEXT NOT NULL CHECK (result IN ('win','loss')),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      full_name     TEXT NOT NULL,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  // Case-insensitive email lookup — emails are normalized to lowercase before insert,
  // but the unique index protects us against a missed normalization.
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (LOWER(email));`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash  TEXT NOT NULL UNIQUE,
      expires_at  TIMESTAMPTZ NOT NULL,
      revoked_at  TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS refresh_tokens_user_id_idx ON refresh_tokens (user_id);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash  TEXT NOT NULL UNIQUE,
      expires_at  TIMESTAMPTZ NOT NULL,
      used_at     TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS password_resets_user_id_idx ON password_resets (user_id);`);

  // visits — website traffic analytics. ip_display holds a TRUNCATED ip by default
  // (see middleware/visitTracker.js). visitor_id is a salted daily hash used to
  // count unique visitors without a durable fingerprint.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS visits (
      id          SERIAL PRIMARY KEY,
      visitor_id  TEXT NOT NULL,
      ip_display  TEXT,
      country     TEXT,
      city        TEXT,
      path        TEXT,
      referrer    TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS visits_created_at_idx ON visits (created_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS visits_visitor_id_idx ON visits (visitor_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS visits_country_idx ON visits (country);`);

  console.log('[db] Postgres ready.');
}

// ───────────────────────────────────────────────────────────────────
// BETS
// ───────────────────────────────────────────────────────────────────

// Public — list latest bets (used by hero, capped to `limit`).
export async function listBets(limit = 100) {
  if (useMemory) {
    return [...memory.bets].sort((a, b) => b.id - a.id).slice(0, limit);
  }
  const { rows } = await pool.query(
    `SELECT id, league, team1, team2, bet_type AS "betType", market,
            match_time AS "matchTime", result, created_at AS "createdAt"
     FROM bets ORDER BY created_at DESC, id DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

// Paginated + filtered list for /full-history.
// filters: { search?: string, result?: 'win' | 'loss', page: number, limit: number }
// search matches league, team1, team2, market, betType (case-insensitive substring).
export async function listBetsPaginated({ search = '', result = null, page = 1, limit = 30 }) {
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 30));
  const offset = (safePage - 1) * safeLimit;

  if (useMemory) {
    let rows = [...memory.bets];
    if (result === 'win' || result === 'loss') {
      rows = rows.filter((r) => r.result === result);
    }
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter((r) =>
        [r.league, r.team1, r.team2, r.market, r.betType]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q))
      );
    }
    const total = rows.length;
    rows.sort((a, b) => b.id - a.id);
    return { rows: rows.slice(offset, offset + safeLimit), total, page: safePage, limit: safeLimit };
  }

  const where = [];
  const params = [];
  if (result === 'win' || result === 'loss') {
    params.push(result);
    where.push(`result = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    const p = `$${params.length}`;
    where.push(`(league ILIKE ${p} OR team1 ILIKE ${p} OR team2 ILIKE ${p} OR market ILIKE ${p} OR bet_type ILIKE ${p})`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const totalRes = await pool.query(`SELECT COUNT(*)::int AS total FROM bets ${whereSql}`, params);
  const total = totalRes.rows[0].total;

  params.push(safeLimit, offset);
  const dataRes = await pool.query(
    `SELECT id, league, team1, team2, bet_type AS "betType", market,
            match_time AS "matchTime", result, created_at AS "createdAt"
     FROM bets ${whereSql}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { rows: dataRes.rows, total, page: safePage, limit: safeLimit };
}

// Stats for the full-history page.
export async function getBetStats() {
  if (useMemory) {
    const total = memory.bets.length;
    const wins = memory.bets.filter((b) => b.result === 'win').length;
    const losses = memory.bets.filter((b) => b.result === 'loss').length;
    return { total, wins, losses };
  }
  const { rows } = await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE result = 'win')::int AS wins,
       COUNT(*) FILTER (WHERE result = 'loss')::int AS losses
     FROM bets`
  );
  return rows[0];
}

export async function createBet(bet) {
  const { league, team1, team2, betType, market, matchTime, result } = bet;
  if (useMemory) {
    const row = {
      id: memory.betIdSeq++,
      league, team1, team2, betType, market, matchTime, result,
      createdAt: new Date().toISOString(),
    };
    memory.bets.push(row);
    return row;
  }
  const { rows } = await pool.query(
    `INSERT INTO bets (league, team1, team2, bet_type, market, match_time, result)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, league, team1, team2, bet_type AS "betType", market,
               match_time AS "matchTime", result, created_at AS "createdAt"`,
    [league, team1, team2, betType, market, matchTime, result]
  );
  return rows[0];
}

export async function deleteBet(id) {
  if (useMemory) {
    const before = memory.bets.length;
    memory.bets = memory.bets.filter((b) => b.id !== Number(id));
    return memory.bets.length < before;
  }
  const { rowCount } = await pool.query('DELETE FROM bets WHERE id = $1', [id]);
  return rowCount > 0;
}

// ───────────────────────────────────────────────────────────────────
// USERS
// ───────────────────────────────────────────────────────────────────

export async function findUserByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;
  if (useMemory) {
    return memory.users.find((u) => u.email.toLowerCase() === normalized) || null;
  }
  const { rows } = await pool.query(
    `SELECT id, full_name AS "fullName", email, password_hash AS "passwordHash",
            created_at AS "createdAt"
     FROM users WHERE LOWER(email) = $1`,
    [normalized]
  );
  return rows[0] || null;
}

export async function findUserById(id) {
  if (useMemory) {
    return memory.users.find((u) => u.id === Number(id)) || null;
  }
  const { rows } = await pool.query(
    `SELECT id, full_name AS "fullName", email, password_hash AS "passwordHash",
            created_at AS "createdAt"
     FROM users WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

export async function createUser({ fullName, email, passwordHash }) {
  const normalized = String(email).trim().toLowerCase();
  if (useMemory) {
    const row = {
      id: memory.userIdSeq++,
      fullName,
      email: normalized,
      passwordHash,
      createdAt: new Date().toISOString(),
    };
    memory.users.push(row);
    return row;
  }
  const { rows } = await pool.query(
    `INSERT INTO users (full_name, email, password_hash)
     VALUES ($1, $2, $3)
     RETURNING id, full_name AS "fullName", email, password_hash AS "passwordHash",
               created_at AS "createdAt"`,
    [fullName, normalized, passwordHash]
  );
  return rows[0];
}

export async function updateUserPassword(userId, passwordHash) {
  if (useMemory) {
    const u = memory.users.find((x) => x.id === Number(userId));
    if (!u) return false;
    u.passwordHash = passwordHash;
    return true;
  }
  const { rowCount } = await pool.query(
    `UPDATE users SET password_hash = $1 WHERE id = $2`,
    [passwordHash, userId]
  );
  return rowCount > 0;
}

// Admin: paginated user list, newest first.
export async function listUsersPaginated({ page = 1, limit = 25 }) {
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 25));
  const offset = (safePage - 1) * safeLimit;

  if (useMemory) {
    const total = memory.users.length;
    const rows = [...memory.users]
      .sort((a, b) => b.id - a.id)
      .slice(offset, offset + safeLimit)
      .map(({ passwordHash, ...rest }) => rest);
    return { rows, total, page: safePage, limit: safeLimit };
  }
  const totalRes = await pool.query(`SELECT COUNT(*)::int AS total FROM users`);
  const total = totalRes.rows[0].total;

  const dataRes = await pool.query(
    `SELECT id, full_name AS "fullName", email, created_at AS "createdAt"
     FROM users ORDER BY id DESC LIMIT $1 OFFSET $2`,
    [safeLimit, offset]
  );
  return { rows: dataRes.rows, total, page: safePage, limit: safeLimit };
}

export async function countUsers() {
  if (useMemory) return memory.users.length;
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS total FROM users`);
  return rows[0].total;
}

// ───────────────────────────────────────────────────────────────────
// REFRESH TOKENS
// ───────────────────────────────────────────────────────────────────

export async function insertRefreshToken({ userId, tokenHash, expiresAt }) {
  if (useMemory) {
    const row = {
      id: memory.refreshIdSeq++,
      userId,
      tokenHash,
      expiresAt: new Date(expiresAt).toISOString(),
      revokedAt: null,
      createdAt: new Date().toISOString(),
    };
    memory.refreshTokens.push(row);
    return row;
  }
  const { rows } = await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)
     RETURNING id, user_id AS "userId", token_hash AS "tokenHash",
               expires_at AS "expiresAt", revoked_at AS "revokedAt",
               created_at AS "createdAt"`,
    [userId, tokenHash, expiresAt]
  );
  return rows[0];
}

export async function findActiveRefreshToken(tokenHash) {
  if (useMemory) {
    const now = Date.now();
    return memory.refreshTokens.find(
      (t) => t.tokenHash === tokenHash && !t.revokedAt && new Date(t.expiresAt).getTime() > now
    ) || null;
  }
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId", token_hash AS "tokenHash",
            expires_at AS "expiresAt", revoked_at AS "revokedAt",
            created_at AS "createdAt"
     FROM refresh_tokens
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
    [tokenHash]
  );
  return rows[0] || null;
}

export async function revokeRefreshTokenById(id) {
  if (useMemory) {
    const t = memory.refreshTokens.find((x) => x.id === Number(id));
    if (!t) return false;
    t.revokedAt = new Date().toISOString();
    return true;
  }
  const { rowCount } = await pool.query(
    `UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL`,
    [id]
  );
  return rowCount > 0;
}

export async function revokeAllUserRefreshTokens(userId) {
  if (useMemory) {
    memory.refreshTokens.forEach((t) => {
      if (t.userId === Number(userId) && !t.revokedAt) t.revokedAt = new Date().toISOString();
    });
    return true;
  }
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );
  return true;
}

// ───────────────────────────────────────────────────────────────────
// PASSWORD RESETS
// ───────────────────────────────────────────────────────────────────

export async function insertPasswordReset({ userId, tokenHash, expiresAt }) {
  if (useMemory) {
    const row = {
      id: memory.resetIdSeq++,
      userId,
      tokenHash,
      expiresAt: new Date(expiresAt).toISOString(),
      usedAt: null,
      createdAt: new Date().toISOString(),
    };
    memory.passwordResets.push(row);
    return row;
  }
  const { rows } = await pool.query(
    `INSERT INTO password_resets (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)
     RETURNING id, user_id AS "userId", token_hash AS "tokenHash",
               expires_at AS "expiresAt", used_at AS "usedAt",
               created_at AS "createdAt"`,
    [userId, tokenHash, expiresAt]
  );
  return rows[0];
}

export async function findActivePasswordReset(tokenHash) {
  if (useMemory) {
    const now = Date.now();
    return memory.passwordResets.find(
      (r) => r.tokenHash === tokenHash && !r.usedAt && new Date(r.expiresAt).getTime() > now
    ) || null;
  }
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId", token_hash AS "tokenHash",
            expires_at AS "expiresAt", used_at AS "usedAt",
            created_at AS "createdAt"
     FROM password_resets
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()`,
    [tokenHash]
  );
  return rows[0] || null;
}

export async function markPasswordResetUsed(id) {
  if (useMemory) {
    const r = memory.passwordResets.find((x) => x.id === Number(id));
    if (!r) return false;
    r.usedAt = new Date().toISOString();
    return true;
  }
  const { rowCount } = await pool.query(
    `UPDATE password_resets SET used_at = NOW() WHERE id = $1`,
    [id]
  );
  return rowCount > 0;
}

// ───────────────────────────────────────────────────────────────────
// VISITS (analytics)
// ───────────────────────────────────────────────────────────────────

// Insert one visit. Called by the public /api/track beacon.
export async function recordVisit({ visitorId, ipDisplay, country, city, path, referrer }) {
  if (useMemory) {
    const row = {
      id: memory.visitIdSeq++,
      visitorId,
      ipDisplay: ipDisplay || null,
      country: country || null,
      city: city || null,
      path: path || null,
      referrer: referrer || null,
      createdAt: new Date().toISOString(),
    };
    memory.visits.push(row);
    return row;
  }
  const { rows } = await pool.query(
    `INSERT INTO visits (visitor_id, ip_display, country, city, path, referrer)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, visitor_id AS "visitorId", ip_display AS "ipDisplay",
               country, city, path, referrer, created_at AS "createdAt"`,
    [visitorId, ipDisplay || null, country || null, city || null, path || null, referrer || null]
  );
  return rows[0];
}

// Summary cards: unique visitors today / this month / this year / all-time.
// "Unique" = distinct visitor_id within each window. Boundaries are UTC.
export async function getVisitSummary() {
  if (useMemory) {
    const now = new Date();
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const startOfYear = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));

    const uniqIn = (from) => {
      const set = new Set();
      for (const v of memory.visits) {
        if (new Date(v.createdAt) >= from) set.add(v.visitorId);
      }
      return set.size;
    };
    const allTime = new Set(memory.visits.map((v) => v.visitorId)).size;

    return {
      today: uniqIn(startOfDay),
      month: uniqIn(startOfMonth),
      year: uniqIn(startOfYear),
      total: allTime,
    };
  }
  const { rows } = await pool.query(
    `SELECT
       COUNT(DISTINCT visitor_id) FILTER (WHERE created_at >= date_trunc('day', NOW()))::int   AS today,
       COUNT(DISTINCT visitor_id) FILTER (WHERE created_at >= date_trunc('month', NOW()))::int AS month,
       COUNT(DISTINCT visitor_id) FILTER (WHERE created_at >= date_trunc('year', NOW()))::int  AS year,
       COUNT(DISTINCT visitor_id)::int                                                          AS total
     FROM visits`
  );
  return rows[0];
}

// Time series for the chart. interval ∈ 'day' | 'week' | 'month' | 'year'.
// Returns [{ bucket: ISO string, visits: number, uniques: number }] oldest→newest.
// `points` caps how many buckets back we look (default sized per interval).
export async function getVisitTimeSeries({ interval = 'day', points } = {}) {
  const allowed = { day: 30, week: 12, month: 12, year: 5 };
  const trunc = allowed[interval] ? interval : 'day';
  const limit = Math.min(366, Math.max(1, Number(points) || allowed[trunc]));

  if (useMemory) {
    // Bucket in JS to mirror date_trunc semantics (UTC).
    const buckets = new Map(); // key: ISO bucket start → { visits, uniques:Set }
    const bucketStart = (d) => {
      const dt = new Date(d);
      const y = dt.getUTCFullYear();
      const m = dt.getUTCMonth();
      const day = dt.getUTCDate();
      if (trunc === 'year') return new Date(Date.UTC(y, 0, 1));
      if (trunc === 'month') return new Date(Date.UTC(y, m, 1));
      if (trunc === 'week') {
        const dow = (dt.getUTCDay() + 6) % 7; // Monday=0
        const monday = new Date(Date.UTC(y, m, day - dow));
        return monday;
      }
      return new Date(Date.UTC(y, m, day)); // day
    };
    for (const v of memory.visits) {
      const key = bucketStart(v.createdAt).toISOString();
      if (!buckets.has(key)) buckets.set(key, { visits: 0, uniques: new Set() });
      const b = buckets.get(key);
      b.visits += 1;
      b.uniques.add(v.visitorId);
    }
    const series = [...buckets.entries()]
      .map(([bucket, b]) => ({ bucket, visits: b.visits, uniques: b.uniques.size }))
      .sort((a, b) => new Date(a.bucket) - new Date(b.bucket));
    return series.slice(-limit);
  }

  // Postgres path. date_trunc gives clean period buckets; we generate a gap-free
  // series so the chart doesn't have holes on quiet days.
  const intervalStep = { day: '1 day', week: '1 week', month: '1 month', year: '1 year' }[trunc];
  const { rows } = await pool.query(
    `WITH series AS (
       SELECT generate_series(
         date_trunc($1, NOW()) - ($2::int - 1) * $3::interval,
         date_trunc($1, NOW()),
         $3::interval
       ) AS bucket
     )
     SELECT s.bucket AS "bucket",
            COALESCE(COUNT(v.id), 0)::int AS visits,
            COALESCE(COUNT(DISTINCT v.visitor_id), 0)::int AS uniques
     FROM series s
     LEFT JOIN visits v
       ON date_trunc($1, v.created_at) = s.bucket
     GROUP BY s.bucket
     ORDER BY s.bucket ASC`,
    [trunc, limit, intervalStep]
  );
  return rows;
}

// Visitors table: one row per visitor_id, aggregated. Newest activity first by default.
// filters: { search?, page, limit, sort?: 'recent'|'visits', dir?: 'asc'|'desc' }
// search matches ip_display, country, city (case-insensitive substring).
export async function listVisitorsPaginated({ search = '', page = 1, limit = 25, sort = 'recent', dir = 'desc' } = {}) {
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 25));
  const offset = (safePage - 1) * safeLimit;
  const sortKey = sort === 'visits' ? 'visits' : 'lastVisit';
  const sortDir = dir === 'asc' ? 'asc' : 'desc';

  if (useMemory) {
    const byVisitor = new Map();
    for (const v of memory.visits) {
      if (!byVisitor.has(v.visitorId)) {
        byVisitor.set(v.visitorId, {
          visitorId: v.visitorId,
          ipDisplay: v.ipDisplay,
          country: v.country,
          city: v.city,
          visits: 0,
          lastVisit: v.createdAt,
        });
      }
      const agg = byVisitor.get(v.visitorId);
      agg.visits += 1;
      if (new Date(v.createdAt) >= new Date(agg.lastVisit)) {
        agg.lastVisit = v.createdAt;
        agg.ipDisplay = v.ipDisplay;
        agg.country = v.country;
        agg.city = v.city;
      }
    }
    let rows = [...byVisitor.values()];
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter((r) =>
        [r.ipDisplay, r.country, r.city].filter(Boolean).some((x) => String(x).toLowerCase().includes(q))
      );
    }
    const total = rows.length;
    rows.sort((a, b) => {
      let cmp;
      if (sortKey === 'visits') cmp = a.visits - b.visits;
      else cmp = new Date(a.lastVisit) - new Date(b.lastVisit);
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return { rows: rows.slice(offset, offset + safeLimit), total, page: safePage, limit: safeLimit };
  }

  const params = [];
  let whereSql = '';
  if (search) {
    params.push(`%${search}%`);
    const p = `$${params.length}`;
    whereSql = `WHERE (ip_display ILIKE ${p} OR country ILIKE ${p} OR city ILIKE ${p})`;
  }

  const totalRes = await pool.query(
    `SELECT COUNT(*)::int AS total FROM (
       SELECT visitor_id FROM visits ${whereSql} GROUP BY visitor_id
     ) t`,
    params
  );
  const total = totalRes.rows[0].total;

  const orderCol = sortKey === 'visits' ? 'visits' : '"lastVisit"';
  params.push(safeLimit, offset);
  const dataRes = await pool.query(
    `SELECT visitor_id AS "visitorId",
            (ARRAY_AGG(ip_display ORDER BY created_at DESC))[1] AS "ipDisplay",
            (ARRAY_AGG(country    ORDER BY created_at DESC))[1] AS country,
            (ARRAY_AGG(city       ORDER BY created_at DESC))[1] AS city,
            COUNT(*)::int      AS visits,
            MAX(created_at)    AS "lastVisit"
     FROM visits ${whereSql}
     GROUP BY visitor_id
     ORDER BY ${orderCol} ${sortDir}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { rows: dataRes.rows, total, page: safePage, limit: safeLimit };
}

// Optional retention cleanup — delete visits older than N days. Not called
// automatically; wire to a cron/scheduled job if you want enforced retention.
export async function deleteVisitsOlderThan(days) {
  const n = Math.max(1, Number(days) || 90);
  if (useMemory) {
    const cutoff = Date.now() - n * 24 * 60 * 60 * 1000;
    const before = memory.visits.length;
    memory.visits = memory.visits.filter((v) => new Date(v.createdAt).getTime() >= cutoff);
    return before - memory.visits.length;
  }
  const { rowCount } = await pool.query(
    `DELETE FROM visits WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')`,
    [n]
  );
  return rowCount;
}