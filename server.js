// server.js
// Express backend for GoldComp. Accepts gold snapshots from the desktop
// watcher and upserts them into a Postgres database (Supabase), keyed by
// character + realm. Every submission is also kept permanently in a
// submissions table, which powers the leaderboard's history view.

const express = require("express");
const { Pool } = require("pg");
const path = require("path");

const PORT = process.env.PORT || 5000;
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL environment variable.");
  console.error("Set it to your Supabase Session pooler connection string.");
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---- Database setup -----------------------------------------------------

// Supabase requires SSL. rejectUnauthorized: false is the standard setting
// for connecting with the plain 'pg' package without bundling Supabase's CA
// certificate -- fine for this use case, not appropriate if you were
// handling highly sensitive data.
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS characters (
      id SERIAL PRIMARY KEY,
      character_name TEXT NOT NULL,
      realm_name TEXT NOT NULL,
      gold BIGINT NOT NULL,
      last_updated BIGINT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (character_name, realm_name)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS submissions (
      id SERIAL PRIMARY KEY,
      character_name TEXT NOT NULL,
      realm_name TEXT NOT NULL,
      gold BIGINT NOT NULL,
      last_updated BIGINT,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_submissions_character
    ON submissions (character_name, realm_name, submitted_at DESC)
  `);

  // XP race: current standings, including rank and previous_rank so the
  // leaderboard can show how far each racer moved since the last update.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS xp_characters (
      id SERIAL PRIMARY KEY,
      character_name TEXT NOT NULL,
      realm_name TEXT NOT NULL,
      character_level INTEGER NOT NULL,
      current_xp BIGINT NOT NULL,
      current_xp_max BIGINT,
      last_updated BIGINT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      rank INTEGER,
      previous_rank INTEGER,
      UNIQUE (character_name, realm_name)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS xp_submissions (
      id SERIAL PRIMARY KEY,
      character_name TEXT NOT NULL,
      realm_name TEXT NOT NULL,
      character_level INTEGER NOT NULL,
      current_xp BIGINT NOT NULL,
      current_xp_max BIGINT,
      last_updated BIGINT,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_xp_submissions_character
    ON xp_submissions (character_name, realm_name, submitted_at DESC)
  `);
}

// ---- Routes ---------------------------------------------------------------

app.post("/api/submit-gold", async (req, res) => {
  const { characterName, realmName, gold, lastUpdated } = req.body || {};

  // Basic validation -- reject anything that doesn't look like a real snapshot.
  if (typeof characterName !== "string" || characterName.trim() === "") {
    return res.status(400).json({ error: "characterName is required" });
  }
  if (typeof realmName !== "string" || realmName.trim() === "") {
    return res.status(400).json({ error: "realmName is required" });
  }
  if (typeof gold !== "number" || !Number.isFinite(gold) || gold < 0) {
    return res.status(400).json({ error: "gold must be a non-negative number" });
  }

  const trimmedCharacter = characterName.trim();
  const trimmedRealm = realmName.trim();
  const truncGold = Math.trunc(gold);
  const truncLastUpdated = Number.isFinite(lastUpdated) ? Math.trunc(lastUpdated) : null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const upsertResult = await client.query(
      `INSERT INTO characters (character_name, realm_name, gold, last_updated, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (character_name, realm_name)
       DO UPDATE SET gold = EXCLUDED.gold,
                     last_updated = EXCLUDED.last_updated,
                     updated_at = EXCLUDED.updated_at
       RETURNING character_name, realm_name, gold, last_updated, updated_at`,
      [trimmedCharacter, trimmedRealm, truncGold, truncLastUpdated]
    );

    await client.query(
      `INSERT INTO submissions (character_name, realm_name, gold, last_updated, submitted_at)
       VALUES ($1, $2, $3, $4, now())`,
      [trimmedCharacter, trimmedRealm, truncGold, truncLastUpdated]
    );

    await client.query("COMMIT");

    const saved = upsertResult.rows[0];
    console.log(`Saved ${saved.character_name}-${saved.realm_name}: ${saved.gold} copper`);

    res.status(200).json({
      ok: true,
      character: {
        characterName: saved.character_name,
        realmName: saved.realm_name,
        gold: Number(saved.gold),
        lastUpdated: saved.last_updated !== null ? Number(saved.last_updated) : null,
        updatedAt: saved.updated_at,
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Database error:", err.message);
    res.status(500).json({ error: "Failed to save gold data" });
  } finally {
    client.release();
  }
});

// XP race: accepts a character's current level + current-level XP,
// upserts it, records history, and recomputes everyone's rank so the
// leaderboard can show movement since the last update.
app.post("/api/submit-xp", async (req, res) => {
  const { characterName, realmName, characterLevel, currentXP, currentXPMax, lastUpdated } =
    req.body || {};

  if (typeof characterName !== "string" || characterName.trim() === "") {
    return res.status(400).json({ error: "characterName is required" });
  }
  if (typeof realmName !== "string" || realmName.trim() === "") {
    return res.status(400).json({ error: "realmName is required" });
  }
  if (typeof characterLevel !== "number" || !Number.isFinite(characterLevel) || characterLevel < 1) {
    return res.status(400).json({ error: "characterLevel must be a positive number" });
  }
  if (typeof currentXP !== "number" || !Number.isFinite(currentXP) || currentXP < 0) {
    return res.status(400).json({ error: "currentXP must be a non-negative number" });
  }

  const trimmedCharacter = characterName.trim();
  const trimmedRealm = realmName.trim();
  const truncLevel = Math.trunc(characterLevel);
  const truncXP = Math.trunc(currentXP);
  const truncXPMax = Number.isFinite(currentXPMax) ? Math.trunc(currentXPMax) : null;
  const truncLastUpdated = Number.isFinite(lastUpdated) ? Math.trunc(lastUpdated) : null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO xp_characters
         (character_name, realm_name, character_level, current_xp, current_xp_max, last_updated, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (character_name, realm_name)
       DO UPDATE SET character_level = EXCLUDED.character_level,
                     current_xp = EXCLUDED.current_xp,
                     current_xp_max = EXCLUDED.current_xp_max,
                     last_updated = EXCLUDED.last_updated,
                     updated_at = EXCLUDED.updated_at`,
      [trimmedCharacter, trimmedRealm, truncLevel, truncXP, truncXPMax, truncLastUpdated]
    );

    await client.query(
      `INSERT INTO xp_submissions
         (character_name, realm_name, character_level, current_xp, current_xp_max, last_updated, submitted_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())`,
      [trimmedCharacter, trimmedRealm, truncLevel, truncXP, truncXPMax, truncLastUpdated]
    );

    // Recompute the whole field's ranking (level desc, then current-level
    // XP desc as the same-level tiebreaker), capturing each racer's prior
    // rank into previous_rank in the same pass so the leaderboard can show
    // movement since the last update.
    await client.query(`
      WITH ranked AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY character_level DESC, current_xp DESC) AS new_rank
        FROM xp_characters
      )
      UPDATE xp_characters x
      SET previous_rank = x.rank,
          rank = ranked.new_rank
      FROM ranked
      WHERE ranked.id = x.id
    `);

    const saved = await client.query(
      `SELECT character_name, realm_name, character_level, current_xp, current_xp_max,
              last_updated, updated_at, rank, previous_rank
       FROM xp_characters
       WHERE character_name = $1 AND realm_name = $2`,
      [trimmedCharacter, trimmedRealm]
    );

    await client.query("COMMIT");

    const row = saved.rows[0];
    console.log(
      `Saved XP for ${row.character_name}-${row.realm_name}: level ${row.character_level}, rank ${row.rank}`
    );

    res.status(200).json({
      ok: true,
      character: {
        characterName: row.character_name,
        realmName: row.realm_name,
        characterLevel: row.character_level,
        currentXP: Number(row.current_xp),
        currentXPMax: row.current_xp_max !== null ? Number(row.current_xp_max) : null,
        lastUpdated: row.last_updated !== null ? Number(row.last_updated) : null,
        updatedAt: row.updated_at,
        rank: row.rank,
        previousRank: row.previous_rank,
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Database error:", err.message);
    res.status(500).json({ error: "Failed to save XP data" });
  } finally {
    client.release();
  }
});

// Returns every character sorted by gold, highest first -- the leaderboard.
app.get("/api/leaderboard", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT character_name, realm_name, gold, last_updated, updated_at
       FROM characters
       ORDER BY gold DESC`
    );

    const leaderboard = result.rows.map((row) => ({
      characterName: row.character_name,
      realmName: row.realm_name,
      gold: Number(row.gold),
      lastUpdated: row.last_updated !== null ? Number(row.last_updated) : null,
      updatedAt: row.updated_at, // pg returns a Date; JSON.stringify -> ISO string with Z
    }));

    res.json({ ok: true, leaderboard });
  } catch (err) {
    console.error("Database error:", err.message);
    res.status(500).json({ error: "Failed to load leaderboard" });
  }
});

// Returns the full submission history for one character, newest first.
app.get("/api/history", async (req, res) => {
  const { characterName, realmName } = req.query;

  if (typeof characterName !== "string" || typeof realmName !== "string") {
    return res.status(400).json({ error: "characterName and realmName query params are required" });
  }

  try {
    const result = await pool.query(
      `SELECT gold, last_updated, submitted_at
       FROM submissions
       WHERE character_name = $1 AND realm_name = $2
       ORDER BY submitted_at DESC
       LIMIT 200`,
      [characterName.trim(), realmName.trim()]
    );

    const history = result.rows.map((row) => ({
      gold: Number(row.gold),
      lastUpdated: row.last_updated !== null ? Number(row.last_updated) : null,
      submittedAt: row.submitted_at, // pg returns a Date; JSON.stringify -> ISO string with Z
    }));

    res.json({ ok: true, characterName: characterName.trim(), realmName: realmName.trim(), history });
  } catch (err) {
    console.error("Database error:", err.message);
    res.status(500).json({ error: "Failed to load submission history" });
  }
});

// Ranks characters by gold gained over roughly the last hour. For each
// character this compares their most recent submission to whichever
// submission was current as of one hour ago, and sorts by the
// difference. Characters with no submission older than an hour yet are
// excluded -- there's no honest baseline to compare against for them.
app.get("/api/leaderboard/hourly", async (req, res) => {
  try {
    const result = await pool.query(`
      WITH latest AS (
        SELECT DISTINCT ON (character_name, realm_name)
          character_name, realm_name, gold AS latest_gold, submitted_at AS latest_at
        FROM submissions
        ORDER BY character_name, realm_name, submitted_at DESC
      ),
      baseline AS (
        SELECT DISTINCT ON (character_name, realm_name)
          character_name, realm_name, gold AS baseline_gold, submitted_at AS baseline_at
        FROM submissions
        WHERE submitted_at <= now() - interval '1 hour'
        ORDER BY character_name, realm_name, submitted_at DESC
      )
      SELECT
        l.character_name,
        l.realm_name,
        l.latest_gold,
        b.baseline_gold,
        (l.latest_gold - b.baseline_gold) AS gained,
        b.baseline_at
      FROM latest l
      JOIN baseline b
        ON b.character_name = l.character_name AND b.realm_name = l.realm_name
      ORDER BY gained DESC
      LIMIT 10
    `);

    const hourly = result.rows.map((row) => ({
      characterName: row.character_name,
      realmName: row.realm_name,
      gained: Number(row.gained),
      currentGold: Number(row.latest_gold),
      baselineGold: Number(row.baseline_gold),
      baselineAt: row.baseline_at,
    }));

    res.json({ ok: true, hourly });
  } catch (err) {
    console.error("Database error:", err.message);
    res.status(500).json({ error: "Failed to load hourly leaderboard" });
  }
});

// Returns the XP race standings, ranked by level then current-level XP.
// Includes each racer's rank change since the prior update, and how long
// it's been since their last submission (so the page can flag stale
// racers who haven't /reload'ed recently).
app.get("/api/leaderboard/xp", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT character_name, realm_name, character_level, current_xp, current_xp_max,
              updated_at, rank, previous_rank
       FROM xp_characters
       ORDER BY rank ASC NULLS LAST`
    );

    const leaderboard = result.rows.map((row) => ({
      characterName: row.character_name,
      realmName: row.realm_name,
      characterLevel: row.character_level,
      currentXP: Number(row.current_xp),
      currentXPMax: row.current_xp_max !== null ? Number(row.current_xp_max) : null,
      updatedAt: row.updated_at,
      rank: row.rank,
      previousRank: row.previous_rank, // null means this is their first-ever ranked update
    }));

    res.json({ ok: true, leaderboard });
  } catch (err) {
    console.error("Database error:", err.message);
    res.status(500).json({ error: "Failed to load XP leaderboard" });
  }
});

// Simple health check, handy for confirming the server is up.
app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`GoldComp backend listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to connect to the database:", err.message);
    process.exit(1);
  });
