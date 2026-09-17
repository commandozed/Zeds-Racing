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
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL environment variable.");
  console.error("Set it to your Supabase Session pooler connection string.");
  process.exit(1);
}

if (!ADMIN_PASSWORD) {
  console.warn(
    "Warning: ADMIN_PASSWORD is not set. The admin page's delete function will refuse all requests until it is."
  );
}

// Original Vanilla Classic race/class restrictions -- stable and
// unchanged since 2004, unlike retail's much looser modern matrix. Unlike
// the fully-independent retail picks, this list only contains real,
// creatable combinations, so the randomizer can never land on something
// impossible (no Tauren Mages here).
const RANDOMIZER_CLASSIC_COMBOS = [
  // Alliance
  { race: "Human", class: "Warrior" }, { race: "Human", class: "Paladin" },
  { race: "Human", class: "Rogue" }, { race: "Human", class: "Priest" },
  { race: "Human", class: "Mage" }, { race: "Human", class: "Warlock" },
  { race: "Dwarf", class: "Warrior" }, { race: "Dwarf", class: "Paladin" },
  { race: "Dwarf", class: "Hunter" }, { race: "Dwarf", class: "Rogue" },
  { race: "Dwarf", class: "Priest" },
  { race: "Night Elf", class: "Warrior" }, { race: "Night Elf", class: "Hunter" },
  { race: "Night Elf", class: "Rogue" }, { race: "Night Elf", class: "Priest" },
  { race: "Night Elf", class: "Druid" },
  { race: "Gnome", class: "Warrior" }, { race: "Gnome", class: "Rogue" },
  { race: "Gnome", class: "Mage" }, { race: "Gnome", class: "Warlock" },
  // Horde
  { race: "Orc", class: "Warrior" }, { race: "Orc", class: "Hunter" },
  { race: "Orc", class: "Rogue" }, { race: "Orc", class: "Warlock" },
  { race: "Orc", class: "Shaman" },
  { race: "Tauren", class: "Warrior" }, { race: "Tauren", class: "Hunter" },
  { race: "Tauren", class: "Shaman" }, { race: "Tauren", class: "Druid" },
  { race: "Troll", class: "Warrior" }, { race: "Troll", class: "Hunter" },
  { race: "Troll", class: "Rogue" }, { race: "Troll", class: "Priest" },
  { race: "Troll", class: "Mage" }, { race: "Troll", class: "Shaman" },
  { race: "Undead", class: "Warrior" }, { race: "Undead", class: "Rogue" },
  { race: "Undead", class: "Priest" }, { race: "Undead", class: "Mage" },
  { race: "Undead", class: "Warlock" },
];

// The two wheels still spin through every individual race/class name for
// visual effect -- only the combo they land on together is constrained
// to a real one, via RANDOMIZER_CLASSIC_COMBOS above.
const RANDOMIZER_RACES = ["Human", "Dwarf", "Night Elf", "Gnome", "Orc", "Tauren", "Troll", "Undead"];
const RANDOMIZER_CLASSES = ["Warrior", "Paladin", "Hunter", "Rogue", "Priest", "Mage", "Warlock", "Shaman", "Druid"];

function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
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

  // Migration: these columns were added after the table already existed
  // in some deployments, so add them explicitly rather than relying on
  // CREATE TABLE IF NOT EXISTS, which is a no-op on an existing table.
  await pool.query(`ALTER TABLE xp_characters ADD COLUMN IF NOT EXISTS character_race TEXT`);
  await pool.query(`ALTER TABLE xp_characters ADD COLUMN IF NOT EXISTS class_name TEXT`);

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

  // Stores an optional end time for each race type. Null/missing means no
  // timer is running -- the countdown UI just hides itself in that case.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS race_settings (
      race_type TEXT PRIMARY KEY,
      ends_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // Single-row table holding the current class/race randomizer result for
  // the XP race page. "active" false means nothing has been spun yet (or
  // it was reset), so the page hides the widget entirely.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS xp_randomizer (
      id INTEGER PRIMARY KEY DEFAULT 1,
      active BOOLEAN NOT NULL DEFAULT false,
      race TEXT,
      class TEXT,
      spin_started_at TIMESTAMPTZ,
      CONSTRAINT single_row CHECK (id = 1)
    )
  `);
}

// ---- Routes ---------------------------------------------------------------

const SUBMISSION_GRACE_SECONDS = 60;

/**
 * Checks whether submissions are still allowed for a race type. Allowed
 * when no timer has ever been set, and for a grace period after the
 * timer's end time -- everything closes after that until an admin resets
 * the race. The comparison runs inside Postgres so it's judged against
 * the database's clock, not this server's, avoiding any clock-skew games.
 */
async function isSubmissionWindowOpen(raceType) {
  const result = await pool.query(
    `SELECT (ends_at IS NULL OR now() <= ends_at + ($2 * interval '1 second')) AS allowed
     FROM race_settings WHERE race_type = $1`,
    [raceType, SUBMISSION_GRACE_SECONDS]
  );

  if (result.rows.length === 0) return true; // no timer ever set for this race
  return result.rows[0].allowed;
}

app.post("/api/submit-gold", async (req, res) => {
  const { characterName, realmName, gold, lastUpdated } = req.body || {};

  if (!(await isSubmissionWindowOpen("gold"))) {
    return res.status(403).json({ error: "The gold competition has ended. Submissions are closed." });
  }

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
  const {
    characterName,
    realmName,
    characterLevel,
    currentXP,
    currentXPMax,
    lastUpdated,
    characterRace,
    characterClassName,
  } = req.body || {};

  if (!(await isSubmissionWindowOpen("xp"))) {
    return res.status(403).json({ error: "The XP race has ended. Submissions are closed." });
  }

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
  const race = typeof characterRace === "string" && characterRace.trim() !== "" ? characterRace.trim() : null;
  const className =
    typeof characterClassName === "string" && characterClassName.trim() !== ""
      ? characterClassName.trim()
      : null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO xp_characters
         (character_name, realm_name, character_level, current_xp, current_xp_max, last_updated, updated_at, character_race, class_name)
       VALUES ($1, $2, $3, $4, $5, $6, now(), $7, $8)
       ON CONFLICT (character_name, realm_name)
       DO UPDATE SET character_level = EXCLUDED.character_level,
                     current_xp = EXCLUDED.current_xp,
                     current_xp_max = EXCLUDED.current_xp_max,
                     last_updated = EXCLUDED.last_updated,
                     updated_at = EXCLUDED.updated_at,
                     character_race = EXCLUDED.character_race,
                     class_name = EXCLUDED.class_name`,
      [trimmedCharacter, trimmedRealm, truncLevel, truncXP, truncXPMax, truncLastUpdated, race, className]
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
              last_updated, updated_at, rank, previous_rank, character_race, class_name
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
        characterRace: row.character_race,
        characterClassName: row.class_name,
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
              updated_at, rank, previous_rank, character_race, class_name
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
      characterRace: row.character_race,
      characterClassName: row.class_name,
    }));

    res.json({ ok: true, leaderboard });
  } catch (err) {
    console.error("Database error:", err.message);
    res.status(500).json({ error: "Failed to load XP leaderboard" });
  }
});

// ---- Admin: list and delete characters -----------------------------------
//
// The list endpoints are read-only and mirror what's already public on the
// leaderboard pages, so they're left open. Deletion is destructive and
// public-facing (anyone with the site's link could otherwise grief the
// leaderboard), so it requires ADMIN_PASSWORD, set as an environment
// variable and never stored in the database or sent anywhere except this
// one check.

function checkAdminPassword(req, res) {
  const { adminPassword } = req.body || {};

  if (!ADMIN_PASSWORD) {
    res.status(500).json({ error: "Server has no ADMIN_PASSWORD configured." });
    return false;
  }
  if (adminPassword !== ADMIN_PASSWORD) {
    res.status(401).json({ error: "Incorrect admin password." });
    return false;
  }
  return true;
}

app.get("/api/admin/characters", async (req, res) => {
  try {
    const [goldResult, xpResult] = await Promise.all([
      pool.query(`SELECT character_name, realm_name, gold FROM characters ORDER BY character_name`),
      pool.query(
        `SELECT character_name, realm_name, character_level FROM xp_characters ORDER BY character_name`
      ),
    ]);

    res.json({
      ok: true,
      gold: goldResult.rows.map((r) => ({
        characterName: r.character_name,
        realmName: r.realm_name,
        gold: Number(r.gold),
      })),
      xp: xpResult.rows.map((r) => ({
        characterName: r.character_name,
        realmName: r.realm_name,
        characterLevel: r.character_level,
      })),
    });
  } catch (err) {
    console.error("Database error:", err.message);
    res.status(500).json({ error: "Failed to load character lists" });
  }
});

app.post("/api/admin/delete-gold-character", async (req, res) => {
  if (!checkAdminPassword(req, res)) return;

  const { characterName, realmName } = req.body || {};
  if (typeof characterName !== "string" || typeof realmName !== "string") {
    return res.status(400).json({ error: "characterName and realmName are required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM characters WHERE character_name = $1 AND realm_name = $2`,
      [characterName.trim(), realmName.trim()]
    );
    await client.query(
      `DELETE FROM submissions WHERE character_name = $1 AND realm_name = $2`,
      [characterName.trim(), realmName.trim()]
    );
    await client.query("COMMIT");

    console.log(`Admin deleted gold entry: ${characterName}-${realmName}`);
    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Database error:", err.message);
    res.status(500).json({ error: "Failed to delete character" });
  } finally {
    client.release();
  }
});

app.post("/api/admin/delete-xp-character", async (req, res) => {
  if (!checkAdminPassword(req, res)) return;

  const { characterName, realmName } = req.body || {};
  if (typeof characterName !== "string" || typeof realmName !== "string") {
    return res.status(400).json({ error: "characterName and realmName are required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM xp_characters WHERE character_name = $1 AND realm_name = $2`,
      [characterName.trim(), realmName.trim()]
    );
    await client.query(
      `DELETE FROM xp_submissions WHERE character_name = $1 AND realm_name = $2`,
      [characterName.trim(), realmName.trim()]
    );

    // Recompute ranks for whoever's left, resetting previous_rank to match
    // so nobody shows a phantom "moved up" badge just because someone else
    // was removed by an admin.
    await client.query(`
      WITH ranked AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY character_level DESC, current_xp DESC) AS new_rank
        FROM xp_characters
      )
      UPDATE xp_characters x
      SET rank = ranked.new_rank,
          previous_rank = ranked.new_rank
      FROM ranked
      WHERE ranked.id = x.id
    `);

    await client.query("COMMIT");

    console.log(`Admin deleted XP entry: ${characterName}-${realmName}`);
    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Database error:", err.message);
    res.status(500).json({ error: "Failed to delete character" });
  } finally {
    client.release();
  }
});

// ---- Race timers ----------------------------------------------------------

// Public: returns each race's end time (or null if no timer is set), so
// the leaderboard pages can render a live countdown.
app.get("/api/race-settings", async (req, res) => {
  try {
    const result = await pool.query(`SELECT race_type, ends_at FROM race_settings`);

    const settings = { gold: { endsAt: null }, xp: { endsAt: null } };
    result.rows.forEach((row) => {
      if (settings[row.race_type]) {
        settings[row.race_type].endsAt = row.ends_at;
      }
    });

    res.json({ ok: true, ...settings });
  } catch (err) {
    console.error("Database error:", err.message);
    res.status(500).json({ error: "Failed to load race settings" });
  }
});

// Admin: starts (or restarts) a race's countdown, ending durationMinutes
// from right now.
app.post("/api/admin/set-race-timer", async (req, res) => {
  if (!checkAdminPassword(req, res)) return;

  const { raceType, durationMinutes } = req.body || {};

  if (raceType !== "gold" && raceType !== "xp") {
    return res.status(400).json({ error: 'raceType must be "gold" or "xp"' });
  }
  if (typeof durationMinutes !== "number" || !Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    return res.status(400).json({ error: "durationMinutes must be a positive number" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO race_settings (race_type, ends_at, updated_at)
       VALUES ($1, now() + ($2 * interval '1 minute'), now())
       ON CONFLICT (race_type)
       DO UPDATE SET ends_at = EXCLUDED.ends_at, updated_at = EXCLUDED.updated_at
       RETURNING ends_at`,
      [raceType, durationMinutes]
    );

    console.log(`Admin set ${raceType} race timer: ends at ${result.rows[0].ends_at}`);
    res.json({ ok: true, endsAt: result.rows[0].ends_at });
  } catch (err) {
    console.error("Database error:", err.message);
    res.status(500).json({ error: "Failed to set race timer" });
  }
});

// Admin: clears a race's timer, hiding the countdown on that page.
app.post("/api/admin/clear-race-timer", async (req, res) => {
  if (!checkAdminPassword(req, res)) return;

  const { raceType } = req.body || {};
  if (raceType !== "gold" && raceType !== "xp") {
    return res.status(400).json({ error: 'raceType must be "gold" or "xp"' });
  }

  try {
    await pool.query(
      `INSERT INTO race_settings (race_type, ends_at, updated_at)
       VALUES ($1, NULL, now())
       ON CONFLICT (race_type)
       DO UPDATE SET ends_at = NULL, updated_at = now()`,
      [raceType]
    );

    console.log(`Admin cleared ${raceType} race timer`);
    res.json({ ok: true });
  } catch (err) {
    console.error("Database error:", err.message);
    res.status(500).json({ error: "Failed to clear race timer" });
  }
});

// Admin: fully resets the gold competition -- wipes all standings and
// history, and clears the timer, ready for a fresh race.
app.post("/api/admin/reset-gold-race", async (req, res) => {
  if (!checkAdminPassword(req, res)) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM characters`);
    await client.query(`DELETE FROM submissions`);
    await client.query(
      `INSERT INTO race_settings (race_type, ends_at, updated_at)
       VALUES ('gold', NULL, now())
       ON CONFLICT (race_type) DO UPDATE SET ends_at = NULL, updated_at = now()`
    );
    await client.query("COMMIT");

    console.log("Admin reset the gold competition.");
    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Database error:", err.message);
    res.status(500).json({ error: "Failed to reset gold competition" });
  } finally {
    client.release();
  }
});

// Admin: fully resets the XP race -- wipes all standings and history, and
// clears the timer, ready for a fresh race.
app.post("/api/admin/reset-xp-race", async (req, res) => {
  if (!checkAdminPassword(req, res)) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM xp_characters`);
    await client.query(`DELETE FROM xp_submissions`);
    await client.query(
      `INSERT INTO race_settings (race_type, ends_at, updated_at)
       VALUES ('xp', NULL, now())
       ON CONFLICT (race_type) DO UPDATE SET ends_at = NULL, updated_at = now()`
    );
    await client.query(
      `INSERT INTO xp_randomizer (id, active, race, class, spin_started_at)
       VALUES (1, false, NULL, NULL, NULL)
       ON CONFLICT (id) DO UPDATE SET active = false, race = NULL, class = NULL, spin_started_at = NULL`
    );
    await client.query("COMMIT");

    console.log("Admin reset the XP race.");
    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Database error:", err.message);
    res.status(500).json({ error: "Failed to reset XP race" });
  } finally {
    client.release();
  }
});

// ---- Class/race randomizer for the XP race page --------------------------

// Public: current randomizer state. The page derives its own animation
// purely from spinStartedAt, so this only needs to be polled occasionally
// (to notice a newly-triggered spin), not continuously.
app.get("/api/randomizer", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT active, race, class, spin_started_at FROM xp_randomizer WHERE id = 1`
    );

    if (result.rows.length === 0 || !result.rows[0].active) {
      return res.json({ ok: true, active: false });
    }

    const row = result.rows[0];
    res.json({ ok: true, active: true, race: row.race, class: row.class, spinStartedAt: row.spin_started_at });
  } catch (err) {
    console.error("Database error:", err.message);
    res.status(500).json({ error: "Failed to load randomizer state" });
  }
});

// Admin: rolls a new random race + class and starts the spin. Doesn't
// return the result -- the admin sees the reveal on the public page at
// the same moment as everyone else, preserving the surprise.
app.post("/api/admin/spin-randomizer", async (req, res) => {
  if (!checkAdminPassword(req, res)) return;

  const combo = pickRandom(RANDOMIZER_CLASSIC_COMBOS);
  const race = combo.race;
  const wowClass = combo.class;

  try {
    await pool.query(
      `INSERT INTO xp_randomizer (id, active, race, class, spin_started_at)
       VALUES (1, true, $1, $2, now())
       ON CONFLICT (id) DO UPDATE SET active = true, race = EXCLUDED.race,
         class = EXCLUDED.class, spin_started_at = EXCLUDED.spin_started_at`,
      [race, wowClass]
    );

    console.log("Admin triggered the class/race randomizer.");
    res.json({ ok: true });
  } catch (err) {
    console.error("Database error:", err.message);
    res.status(500).json({ error: "Failed to start randomizer" });
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
