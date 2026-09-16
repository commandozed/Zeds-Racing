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
