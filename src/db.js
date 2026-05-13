// db.js — Tiny database layer.
// Uses Postgres if DATABASE_URL is set; otherwise falls back to an in-memory store
// so the backend still runs cleanly for quick local testing.

import pg from 'pg';

const { Pool } = pg;

let pool = null;
let memoryStore = [];
let memoryIdSeq = 1;

const useMemory = !process.env.DATABASE_URL;

if (!useMemory) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Railway Postgres requires SSL; this works locally too because rejectUnauthorized is off.
    ssl: process.env.DATABASE_URL.includes('localhost')
      ? false
      : { rejectUnauthorized: false },
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
  console.log('[db] Postgres ready.');
}

export async function listBets(limit = 50) {
  if (useMemory) {
    return [...memoryStore]
      .sort((a, b) => b.id - a.id)
      .slice(0, limit);
  }
  const { rows } = await pool.query(
    'SELECT id, league, team1, team2, bet_type AS "betType", market, match_time AS "matchTime", result, created_at AS "createdAt" FROM bets ORDER BY id DESC LIMIT $1',
    [limit]
  );
  return rows;
}

export async function createBet(bet) {
  const { league, team1, team2, betType, market, matchTime, result } = bet;
  if (useMemory) {
    const row = {
      id: memoryIdSeq++,
      league,
      team1,
      team2,
      betType,
      market,
      matchTime,
      result,
      createdAt: new Date().toISOString(),
    };
    memoryStore.push(row);
    return row;
  }
  const { rows } = await pool.query(
    `INSERT INTO bets (league, team1, team2, bet_type, market, match_time, result)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, league, team1, team2, bet_type AS "betType", market, match_time AS "matchTime", result, created_at AS "createdAt"`,
    [league, team1, team2, betType, market, matchTime, result]
  );
  return rows[0];
}

export async function deleteBet(id) {
  if (useMemory) {
    const before = memoryStore.length;
    memoryStore = memoryStore.filter((b) => b.id !== Number(id));
    return memoryStore.length < before;
  }
  const { rowCount } = await pool.query('DELETE FROM bets WHERE id = $1', [id]);
  return rowCount > 0;
}
