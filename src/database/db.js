// ========================================
// File: src/database/db.js
// ========================================
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();

// Create or open SQLite database file
const db = new sqlite3.Database(path.join(__dirname, 'sonobot.sqlite'));

// ===== Encryption helpers (alts) =====
const ENC_VERSION = 'v1';
const ALT_CRYPT_KEY_B64 = process.env.ALT_CRYPT_KEY || '';
let ALT_CRYPT_KEY = null;
if (ALT_CRYPT_KEY_B64) {
  try {
    ALT_CRYPT_KEY = Buffer.from(ALT_CRYPT_KEY_B64, 'base64');
    if (ALT_CRYPT_KEY.length !== 32) {
      console.error('[AltCrypt] ALT_CRYPT_KEY must decode to 32 bytes. Refusing to use.');
      ALT_CRYPT_KEY = null;
    }
  } catch {
    console.error('[AltCrypt] ALT_CRYPT_KEY is not valid base64.');
  }
}

function assertKeyOrThrow() {
  if (!ALT_CRYPT_KEY) {
    throw new Error('ALT_CRYPT_KEY not set or invalid. Set a 32-byte base64 key in env.');
  }
}

function encryptSecret(plain) {
  assertKeyOrThrow();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ALT_CRYPT_KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_VERSION}:${iv.toString('base64')}:${enc.toString('base64')}:${tag.toString('base64')}`;
}

function decryptSecret(blob) {
  assertKeyOrThrow();
  if (!blob) return '';
  const [ver, ivb64, ctb64, tagb64] = String(blob).split(':');
  if (ver !== ENC_VERSION) throw new Error('Unsupported enc version');
  const iv = Buffer.from(ivb64, 'base64');
  const ct = Buffer.from(ctb64, 'base64');
  const tag = Buffer.from(tagb64, 'base64');
  const dec = crypto.createDecipheriv('aes-256-gcm', ALT_CRYPT_KEY, iv);
  dec.setAuthTag(tag);
  const out = Buffer.concat([dec.update(ct), dec.final()]);
  return out.toString('utf8');
}

function maybeEncrypt(plain) {
  if (plain == null) return null;
  return encryptSecret(String(plain));
}
function maybeDecrypt(blob) {
  if (!blob) return '';
  return decryptSecret(String(blob));
}

// ===== Schema shape cache (for legacy compatibility) =====
const ALT_TABLE_SHAPE = {
  hasLoginEncrypted: false,
  loginEncryptedType: null,   // 'TEXT' | 'INTEGER' | etc
  loginEncryptedNotNull: false,
  emailCol: 'email_enc',      // may switch to 'email_encrypted'
  passwordCol: 'password_enc' // may switch to 'password_encrypted'
};

// Init tables + lightweight migrations
const init = () => {
  db.serialize(() => {
    // ---- WALLS ----
    db.run(`CREATE TABLE IF NOT EXISTS wall_config (
      guild_id TEXT PRIMARY KEY,
      channel_id TEXT,
      dashboard_message_id TEXT,
      interval_minutes INTEGER DEFAULT 30,
      last_notified_at INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS wall_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      discord_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      source TEXT CHECK(source IN ('discord','ingame')) DEFAULT 'discord'
    )`);

    db.all(`PRAGMA table_info(wall_checks)`, (err, rows) => {
      if (err) return console.error('PRAGMA table_info(wall_checks) failed:', err);
      const hasStatus = Array.isArray(rows) && rows.some(r => r.name === 'status');
      if (!hasStatus) {
        db.run(
          `ALTER TABLE wall_checks
           ADD COLUMN status TEXT CHECK(status IN ('clear','weewoo')) DEFAULT 'clear'`,
          (e) => { if (e && !String(e.message).includes('duplicate column name')) console.error('Add status (walls) failed:', e); }
        );
      }
    });

    // ---- OUTPOST ----
    db.run(`CREATE TABLE IF NOT EXISTS outpost_config (
      guild_id TEXT PRIMARY KEY,
      channel_id TEXT,
      dashboard_message_id TEXT,
      interval_minutes INTEGER DEFAULT 30,
      last_notified_at INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS outpost_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      discord_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      source TEXT CHECK(source IN ('discord','ingame')) DEFAULT 'discord',
      status TEXT CHECK(status IN ('clear','weewoo')) DEFAULT 'clear'
    )`);

    // ---- GUILD CONFIG ----
    db.run(`CREATE TABLE IF NOT EXISTS guild_config (
      guild_id TEXT PRIMARY KEY,
      raid_alerts_channel_id TEXT,
      weewoo_active INTEGER DEFAULT 0,
      weewoo_ping_interval_minutes INTEGER DEFAULT 2,
      weewoo_last_ping_at INTEGER DEFAULT 0,
      -- Outpost-specific
      outpost_alerts_channel_id TEXT,
      outpost_weewoo_active INTEGER DEFAULT 0,
      outpost_weewoo_ping_interval_minutes INTEGER DEFAULT 2,
      outpost_weewoo_last_ping_at INTEGER DEFAULT 0,
      -- pause flags
      base_alerts_paused INTEGER DEFAULT 0,
      outpost_alerts_paused INTEGER DEFAULT 0,
      -- checker role assignments
      shard_checker_alt_id INTEGER DEFAULT 0,
      rpost_checker_alt_id INTEGER DEFAULT 0
    )`);

    db.all(`PRAGMA table_info(guild_config)`, (err, rows) => {
      if (err) return console.error('PRAGMA table_info(guild_config) failed:', err);
      const cols = Array.isArray(rows) ? rows.map(r => r.name) : [];
      const addCol = (name, ddl) =>
        !cols.includes(name) &&
        db.run(`ALTER TABLE guild_config ADD COLUMN ${ddl}`,
          e => { if (e && !String(e.message).includes('duplicate column name')) console.error(`Add ${name} failed:`, e); });

      // walls
      addCol('weewoo_active', 'weewoo_active INTEGER DEFAULT 0');
      addCol('weewoo_ping_interval_minutes', 'weewoo_ping_interval_minutes INTEGER DEFAULT 2');
      addCol('weewoo_last_ping_at', 'weewoo_last_ping_at INTEGER DEFAULT 0');
      // outpost
      addCol('outpost_alerts_channel_id', 'outpost_alerts_channel_id TEXT');
      addCol('outpost_weewoo_active', 'outpost_weewoo_active INTEGER DEFAULT 0');
      addCol('outpost_weewoo_ping_interval_minutes', 'outpost_weewoo_ping_interval_minutes INTEGER DEFAULT 2');
      addCol('outpost_weewoo_last_ping_at', 'outpost_weewoo_last_ping_at INTEGER DEFAULT 0');
      // pause flags
      addCol('base_alerts_paused', 'base_alerts_paused INTEGER DEFAULT 0');
      addCol('outpost_alerts_paused', 'outpost_alerts_paused INTEGER DEFAULT 0');
      // checker assignments
      addCol('shard_checker_alt_id', 'shard_checker_alt_id INTEGER DEFAULT 0');
      addCol('rpost_checker_alt_id', 'rpost_checker_alt_id INTEGER DEFAULT 0');
    });

    // ---- SHARD TRACKER (MAIN) ----
    db.run(`CREATE TABLE IF NOT EXISTS shard_config (
      guild_id TEXT PRIMARY KEY,
      channel_id TEXT,
      enabled INTEGER DEFAULT 0,
      interval_minutes INTEGER DEFAULT 5,
      previous_message_id TEXT,
      last_run_at INTEGER DEFAULT 0
    )`);

    db.all(`PRAGMA table_info(shard_config)`, (err, rows) => {
      if (err) return console.error('PRAGMA table_info(shard_config) failed:', err);
      const cols = Array.isArray(rows) ? rows.map(r => r.name) : [];
      const addCol = (name, ddl) =>
        !cols.includes(name) &&
        db.run(`ALTER TABLE shard_config ADD COLUMN ${ddl}`,
          e => { if (e && !String(e.message).includes('duplicate column name')) console.error(`Add ${name} failed:`, e); });
      addCol('previous_message_id', 'previous_message_id TEXT');
      addCol('last_run_at', 'last_run_at INTEGER DEFAULT 0');
    });

    // ---- SHARD TRACKER (RPOST) ----
    db.run(`CREATE TABLE IF NOT EXISTS rpost_shard_config (
      guild_id TEXT PRIMARY KEY,
      channel_id TEXT,
      enabled INTEGER DEFAULT 0,
      interval_minutes INTEGER DEFAULT 5,
      previous_message_id TEXT,
      last_run_at INTEGER DEFAULT 0
    )`);

    db.all(`PRAGMA table_info(rpost_shard_config)`, (err, rows) => {
      if (err) return console.error('PRAGMA table_info(rpost_shard_config) failed:', err);
      const cols = Array.isArray(rows) ? rows.map(r => r.name) : [];
      const addCol = (name, ddl) =>
        !cols.includes(name) &&
        db.run(`ALTER TABLE rpost_shard_config ADD COLUMN ${ddl}`,
          e => { if (e && !String(e.message).includes('duplicate column name')) console.error(`Add (rpost) ${name} failed:`, e); });
      addCol('previous_message_id', 'previous_message_id TEXT');
      addCol('last_run_at', 'last_run_at INTEGER DEFAULT 0');
    });

    // ---- ALT MANAGER CONFIG ----
    db.run(`CREATE TABLE IF NOT EXISTS alt_manager_config (
      guild_id TEXT PRIMARY KEY,
      channel_id TEXT,
      dashboard_message_id TEXT
    )`);

    // ---- ALTS ----
    db.run(`CREATE TABLE IF NOT EXISTS alts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      label TEXT NOT NULL,
      auth_mode TEXT CHECK(auth_mode IN ('offline','microsoft')) NOT NULL DEFAULT 'offline',
      mc_username TEXT,
      msa_label TEXT,
      email_enc TEXT,
      password_enc TEXT,
      created_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0,
      last_status TEXT,
      last_seen INTEGER DEFAULT 0
    )`);

    // Robust migrations for alts (idempotent) + legacy compatibility sniffing
    db.all(`PRAGMA table_info(alts)`, (err, rows) => {
      if (err) return console.error('PRAGMA table_info(alts) failed:', err);
      const cols = Array.isArray(rows) ? rows.map(r => r.name) : [];
      const addCol = (name, ddl) =>
        !cols.includes(name) &&
        db.run(`ALTER TABLE alts ADD COLUMN ${ddl}`,
          e => { if (e && !String(e.message).includes('duplicate column name')) console.error(`Add (alts) ${name} failed:`, e); });

      addCol('auth_mode', `auth_mode TEXT CHECK(auth_mode IN ('offline','microsoft')) NOT NULL DEFAULT 'offline'`);
      addCol('mc_username', 'mc_username TEXT');
      addCol('msa_label', 'msa_label TEXT');
      addCol('email_enc', 'email_enc TEXT');
      addCol('password_enc', 'password_enc TEXT');
      addCol('created_at', 'created_at INTEGER DEFAULT 0');
      addCol('updated_at', 'updated_at INTEGER DEFAULT 0');
      addCol('last_status', 'last_status TEXT');
      addCol('last_seen', 'last_seen INTEGER DEFAULT 0');

      // NEW: identity columns
      addCol('mc_uuid', 'mc_uuid TEXT');
      addCol('mc_last_username', 'mc_last_username TEXT');

      // Legacy columns mapping
      const loginRow = rows.find(r => r.name === 'login_encrypted');
      if (loginRow) {
        ALT_TABLE_SHAPE.hasLoginEncrypted = true;
        ALT_TABLE_SHAPE.loginEncryptedType = (loginRow.type || '').toUpperCase();
        ALT_TABLE_SHAPE.loginEncryptedNotNull = !!loginRow.notnull;

        // Backfill any NULLs to satisfy NOT NULL
        const defVal = ALT_TABLE_SHAPE.loginEncryptedType.includes('INT') ? 0 : '';
        if (ALT_TABLE_SHAPE.loginEncryptedNotNull) {
          db.run(
            `UPDATE alts SET login_encrypted = COALESCE(login_encrypted, ?)` ,
            [defVal],
            (e) => { if (e) console.error('Backfill login_encrypted failed:', e.message); }
          );
        }
      }

      if (cols.includes('email_encrypted') && !cols.includes('email_enc')) {
        ALT_TABLE_SHAPE.emailCol = 'email_encrypted';
      } else {
        ALT_TABLE_SHAPE.emailCol = 'email_enc';
      }

      if (cols.includes('password_encrypted') && !cols.includes('password_enc')) {
        ALT_TABLE_SHAPE.passwordCol = 'password_encrypted';
      } else {
        ALT_TABLE_SHAPE.passwordCol = 'password_enc';
      }
    });
  });
};

// --------- WALL QUERIES ----------
const getConfig = (guildId) => new Promise((resolve, reject) => {
  db.get(`SELECT * FROM wall_config WHERE guild_id = ?`, [guildId], (err, row) => {
    if (err) reject(err); else resolve(row || null);
  });
});

const upsertConfig = ({ guild_id, channel_id, dashboard_message_id, interval_minutes, last_notified_at }) => new Promise((resolve, reject) => {
  db.run(
    `INSERT INTO wall_config (guild_id, channel_id, dashboard_message_id, interval_minutes, last_notified_at)
     VALUES (?, ?, ?, COALESCE(?, 30), COALESCE(?, 0))
     ON CONFLICT(guild_id) DO UPDATE SET
       channel_id = COALESCE(excluded.channel_id, wall_config.channel_id),
       dashboard_message_id = COALESCE(excluded.dashboard_message_id, wall_config.dashboard_message_id),
       interval_minutes = COALESCE(excluded.interval_minutes, wall_config.interval_minutes),
       last_notified_at = COALESCE(excluded.last_notified_at, wall_config.last_notified_at)`,
    [guild_id, channel_id || null, dashboard_message_id || null, interval_minutes, last_notified_at],
    (err) => err ? reject(err) : resolve()
  );
});

const insertWallCheck = ({ guild_id, discord_id, timestamp, source = 'discord', status = 'clear' }) => new Promise((resolve, reject) => {
  db.run(
    `INSERT INTO wall_checks (guild_id, discord_id, timestamp, source, status)
     VALUES (?, ?, ?, ?, ?)`,
    [guild_id, discord_id, timestamp, source, status],
    function (err) { if (err) reject(err); else resolve(this.lastID); }
  );
});

const resetWallChecks = (guildId) => new Promise((resolve, reject) => {
  db.run(`DELETE FROM wall_checks WHERE guild_id = ?`, [guildId], (err) => {
    if (err) reject(err); else resolve();
  });
});

const getLastCheck = (guildId) => new Promise((resolve, reject) => {
  db.get(`SELECT * FROM wall_checks WHERE guild_id = ? ORDER BY timestamp DESC LIMIT 1`,
    [guildId], (err, row) => err ? reject(err) : resolve(row || null));
});

const getRecentChecks = (guildId, limit = 5) => new Promise((resolve, reject) => {
  db.all(`SELECT * FROM wall_checks WHERE guild_id = ? ORDER BY timestamp DESC LIMIT ?`,
    [guildId, limit], (err, rows) => err ? reject(err) : resolve(rows || []));
});

const getLeaderboard = (guildId, sinceEpoch) => new Promise((resolve, reject) => {
  db.all(
    `SELECT discord_id, COUNT(*) as count
     FROM wall_checks
     WHERE guild_id = ? AND timestamp >= ? AND status = 'clear'
     GROUP BY discord_id
     ORDER BY count DESC
     LIMIT 10`,
    [guildId, sinceEpoch],
    (err, rows) => err ? reject(err) : resolve(rows || []
  ));
});

const updateLastNotified = (guildId, ts) => new Promise((resolve, reject) => {
  db.run(`UPDATE wall_config SET last_notified_at = ? WHERE guild_id = ?`, [ts, guildId], (err) => {
    if (err) reject(err); else resolve();
  });
});

// --------- OUTPOST QUERIES ----------
const getOutpostConfig = (guildId) => new Promise((resolve, reject) => {
  db.get(`SELECT * FROM outpost_config WHERE guild_id = ?`, [guildId], (err, row) => {
    if (err) reject(err); else resolve(row || null);
  });
});

const upsertOutpostConfig = ({ guild_id, channel_id, dashboard_message_id, interval_minutes, last_notified_at }) => new Promise((resolve, reject) => {
  db.run(
    `INSERT INTO outpost_config (guild_id, channel_id, dashboard_message_id, interval_minutes, last_notified_at)
     VALUES (?, ?, ?, COALESCE(?, 30), COALESCE(?, 0))
     ON CONFLICT(guild_id) DO UPDATE SET
       channel_id = COALESCE(excluded.channel_id, outpost_config.channel_id),
       dashboard_message_id = COALESCE(excluded.dashboard_message_id, outpost_config.dashboard_message_id),
       interval_minutes = COALESCE(excluded.interval_minutes, outpost_config.interval_minutes),
       last_notified_at = COALESCE(excluded.last_notified_at, outpost_config.last_notified_at)`,
    [guild_id, channel_id || null, dashboard_message_id || null, interval_minutes, last_notified_at],
    (err) => err ? reject(err) : resolve()
  );
});

const insertOutpostCheck = ({ guild_id, discord_id, timestamp, source = 'discord', status = 'clear' }) => new Promise((resolve, reject) => {
  db.run(
    `INSERT INTO outpost_checks (guild_id, discord_id, timestamp, source, status)
     VALUES (?, ?, ?, ?, ?)`,
    [guild_id, discord_id, timestamp, source, status],
    function (err) { if (err) reject(err); else resolve(this.lastID); }
  );
});

const resetOutpostChecks = (guildId) => new Promise((resolve, reject) => {
  db.run(`DELETE FROM outpost_checks WHERE guild_id = ?`, [guildId], (err) => {
    if (err) reject(err); else resolve();
  });
});

const getOutpostLastCheck = (guildId) => new Promise((resolve, reject) => {
  db.get(`SELECT * FROM outpost_checks WHERE guild_id = ? ORDER BY timestamp DESC LIMIT 1`,
    [guildId], (err, row) => err ? reject(err) : resolve(row || null));
});

const getOutpostRecentChecks = (guildId, limit = 5) => new Promise((resolve, reject) => {
  db.all(`SELECT * FROM outpost_checks WHERE guild_id = ? ORDER BY timestamp DESC LIMIT ?`,
    [guildId, limit], (err, rows) => err ? reject(err) : resolve(rows || []));
});

const getOutpostLeaderboard = (guildId, sinceEpoch) => new Promise((resolve, reject) => {
  db.all(
    `SELECT discord_id, COUNT(*) as count
     FROM outpost_checks
     WHERE guild_id = ? AND timestamp >= ?
     AND status = 'clear'
     GROUP BY discord_id
     ORDER BY count DESC
     LIMIT 10`,
    [guildId, sinceEpoch],
    (err, rows) => err ? reject(err) : resolve(rows || [])
  );
});

const updateOutpostLastNotified = (guildId, ts) => new Promise((resolve, reject) => {
  db.run(`UPDATE outpost_config SET last_notified_at = ? WHERE guild_id = ?`, [ts, guildId], (err) => {
    if (err) reject(err); else resolve();
  });
});

// --------- GUILD CONFIG ----------
const getGuildConfig = (guildId) => new Promise((resolve, reject) => {
  db.get(`SELECT * FROM guild_config WHERE guild_id = ?`, [guildId], (err, row) => {
    if (err) reject(err); else resolve(row || null);
  });
});

const upsertGuildConfig = ({
  guild_id,
  raid_alerts_channel_id = null,
  weewoo_active = null,
  weewoo_ping_interval_minutes = null,
  weewoo_last_ping_at = null,
  // outpost
  outpost_alerts_channel_id = null,
  outpost_weewoo_active = null,
  outpost_weewoo_ping_interval_minutes = null,
  outpost_weewoo_last_ping_at = null,
  // pause flags
  base_alerts_paused = null,
  outpost_alerts_paused = null,
  // checker roles
  shard_checker_alt_id = null,
  rpost_checker_alt_id = null,
}) => new Promise((resolve, reject) => {
  db.run(`INSERT OR IGNORE INTO guild_config (guild_id) VALUES (?)`, [guild_id], (insErr) => {
    if (insErr) return reject(insErr);

    const sets = [];
    const vals = [];
    if (raid_alerts_channel_id !== null)                { sets.push(`raid_alerts_channel_id = ?`); vals.push(raid_alerts_channel_id); }
    if (weewoo_active !== null)                          { sets.push(`weewoo_active = ?`); vals.push(weewoo_active); }
    if (weewoo_ping_interval_minutes !== null)           { sets.push(`weewoo_ping_interval_minutes = ?`); vals.push(weewoo_ping_interval_minutes); }
    if (weewoo_last_ping_at !== null)                    { sets.push(`weewoo_last_ping_at = ?`); vals.push(weewoo_last_ping_at); }
    if (outpost_alerts_channel_id !== null)              { sets.push(`outpost_alerts_channel_id = ?`); vals.push(outpost_alerts_channel_id); }
    if (outpost_weewoo_active !== null)                  { sets.push(`outpost_weewoo_active = ?`); vals.push(outpost_weewoo_active); }
    if (outpost_weewoo_ping_interval_minutes !== null)   { sets.push(`outpost_weewoo_ping_interval_minutes = ?`); vals.push(outpost_weewoo_ping_interval_minutes); }
    if (outpost_weewoo_last_ping_at !== null)            { sets.push(`outpost_weewoo_last_ping_at = ?`); vals.push(outpost_weewoo_last_ping_at); }
    if (base_alerts_paused !== null)                     { sets.push(`base_alerts_paused = ?`); vals.push(base_alerts_paused); }
    if (outpost_alerts_paused !== null)                  { sets.push(`outpost_alerts_paused = ?`); vals.push(outpost_alerts_paused); }
    if (shard_checker_alt_id !== null)                   { sets.push(`shard_checker_alt_id = ?`); vals.push(shard_checker_alt_id); }
    if (rpost_checker_alt_id !== null)                   { sets.push(`rpost_checker_alt_id = ?`); vals.push(rpost_checker_alt_id); }

    if (sets.length === 0) return resolve();
    vals.push(guild_id);

    db.run(`UPDATE guild_config SET ${sets.join(', ')} WHERE guild_id = ?`, vals,
      (updErr) => updErr ? reject(updErr) : resolve());
  });
});

// --------- SHARD CONFIG (MAIN) ----------
const getShardConfig = (guildId) => new Promise((resolve, reject) => {
  db.get(`SELECT * FROM shard_config WHERE guild_id = ?`, [guildId], (err, row) => {
    if (err) reject(err); else resolve(row || null);
  });
});

const upsertShardConfig = ({
  guild_id,
  channel_id = null,
  enabled = null,
  interval_minutes = null,
  previous_message_id = null,
  last_run_at = null
}) => new Promise((resolve, reject) => {
  db.run(`INSERT OR IGNORE INTO shard_config (guild_id) VALUES (?)`, [guild_id], (insErr) => {
    if (insErr) return reject(insErr);
    const sets = [], vals = [];
    if (channel_id !== null)          { sets.push(`channel_id = ?`); vals.push(channel_id); }
    if (enabled !== null)             { sets.push(`enabled = ?`); vals.push(enabled); }
    if (interval_minutes !== null)    { sets.push(`interval_minutes = ?`); vals.push(interval_minutes); }
    if (previous_message_id !== null) { sets.push(`previous_message_id = ?`); vals.push(previous_message_id); }
    if (last_run_at !== null)         { sets.push(`last_run_at = ?`); vals.push(last_run_at); }
    if (sets.length === 0) return resolve();
    vals.push(guild_id);
    db.run(`UPDATE shard_config SET ${sets.join(', ')} WHERE guild_id = ?`, vals,
      (updErr) => updErr ? reject(updErr) : resolve());
  });
});

// --------- SHARD CONFIG (RPOST) ----------
const getRpostShardConfig = (guildId) => new Promise((resolve, reject) => {
  db.get(`SELECT * FROM rpost_shard_config WHERE guild_id = ?`, [guildId], (err, row) => {
    if (err) reject(err); else resolve(row || null);
  });
});

const upsertRpostShardConfig = ({
  guild_id,
  channel_id = null,
  enabled = null,
  interval_minutes = null,
  previous_message_id = null,
  last_run_at = null
}) => new Promise((resolve, reject) => {
  db.run(`INSERT OR IGNORE INTO rpost_shard_config (guild_id) VALUES (?)`, [guild_id], (insErr) => {
    if (insErr) return reject(insErr);
    const sets = [], vals = [];
    if (channel_id !== null)          { sets.push(`channel_id = ?`); vals.push(channel_id); }
    if (enabled !== null)             { sets.push(`enabled = ?`); vals.push(enabled); }
    if (interval_minutes !== null)    { sets.push(`interval_minutes = ?`); vals.push(interval_minutes); }
    if (previous_message_id !== null) { sets.push(`previous_message_id = ?`); vals.push(previous_message_id); }
    if (last_run_at !== null)         { sets.push(`last_run_at = ?`); vals.push(last_run_at); }
    if (sets.length === 0) return resolve();
    vals.push(guild_id);
    db.run(`UPDATE rpost_shard_config SET ${sets.join(', ')} WHERE guild_id = ?`, vals,
      (updErr) => updErr ? reject(updErr) : resolve());
  });
});

// --------- ALT MANAGER CONFIG ----------
const getAltManagerConfig = (guildId) => new Promise((resolve, reject) => {
  db.get(`SELECT * FROM alt_manager_config WHERE guild_id = ?`, [guildId], (err, row) =>
    err ? reject(err) : resolve(row || null)
  );
});

const upsertAltManagerConfig = ({ guild_id, channel_id = null, dashboard_message_id = null }) => new Promise((resolve, reject) => {
  db.run(`INSERT OR IGNORE INTO alt_manager_config (guild_id) VALUES (?)`, [guild_id], (insErr) => {
    if (insErr) return reject(insErr);
    const sets = [], vals = [];
    if (channel_id !== null)          { sets.push(`channel_id = ?`); vals.push(channel_id); }
    if (dashboard_message_id !== null){ sets.push(`dashboard_message_id = ?`); vals.push(dashboard_message_id); }
    if (sets.length === 0) return resolve();
    vals.push(guild_id);
    db.run(`UPDATE alt_manager_config SET ${sets.join(', ')} WHERE guild_id = ?`, vals,
      (updErr) => updErr ? reject(updErr) : resolve());
  });
});

// --------- ALTS CRUD ----------
const listAlts = (guildId) => new Promise((resolve, reject) => {
  db.all(`SELECT * FROM alts WHERE guild_id = ? ORDER BY label COLLATE NOCASE`, [guildId],
    (err, rows) => err ? reject(err) : resolve(rows || []));
});

const getAltById = (id) => new Promise((resolve, reject) => {
  db.get(`SELECT * FROM alts WHERE id = ?`, [id], (err, row) => err ? reject(err) : resolve(row || null));
});

const insertAlt = ({
  guild_id, label, auth_mode = 'offline', mc_username = null,
  msa_label = null, email_plain = null, password_plain = null
}) => new Promise((resolve, reject) => {
  try { if (email_plain || password_plain) assertKeyOrThrow(); } catch (e) { return reject(e); }
  const now = Math.floor(Date.now() / 1000);

  // dynamic column list to satisfy legacy NOT NULL login_encrypted
  const cols = ['guild_id', 'label', 'auth_mode', 'mc_username', 'msa_label', ALT_TABLE_SHAPE.emailCol, ALT_TABLE_SHAPE.passwordCol, 'created_at', 'updated_at']
    .filter(Boolean);
  const vals = [
    guild_id, label, auth_mode, mc_username, msa_label,
    ALT_TABLE_SHAPE.emailCol ? (email_plain ? maybeEncrypt(email_plain) : null) : undefined,
    ALT_TABLE_SHAPE.passwordCol ? (password_plain ? maybeEncrypt(password_plain) : null) : undefined,
    now, now
  ].filter(v => v !== undefined);

  // include legacy login_encrypted if required
  if (ALT_TABLE_SHAPE.hasLoginEncrypted && ALT_TABLE_SHAPE.loginEncryptedNotNull) {
    cols.push('login_encrypted');
    const defVal = (ALT_TABLE_SHAPE.loginEncryptedType || '').toUpperCase().includes('INT') ? 0 : '';
    vals.push(defVal);
  }

  const placeholders = cols.map(() => '?').join(', ');
  const sql = `INSERT INTO alts (${cols.join(', ')}) VALUES (${placeholders})`;

  db.run(sql, vals, function (err) { if (err) reject(err); else resolve(this.lastID); });
});

const updateAlt = ({
  id, label = null, auth_mode = null, mc_username = null,
  msa_label = null, email_plain = undefined, password_plain = undefined
}) => new Promise((resolve, reject) => {
  const sets = [], vals = [];
  if (label !== null)          { sets.push(`label = ?`); vals.push(label); }
  if (auth_mode !== null)      { sets.push(`auth_mode = ?`); vals.push(auth_mode); }
  if (mc_username !== null)    { sets.push(`mc_username = ?`); vals.push(mc_username); }
  if (msa_label !== null)      { sets.push(`msa_label = ?`); vals.push(msa_label); }

  if (email_plain !== undefined && ALT_TABLE_SHAPE.emailCol) {
    try { if (email_plain) assertKeyOrThrow(); } catch (e) { return reject(e); }
    sets.push(`${ALT_TABLE_SHAPE.emailCol} = ?`); vals.push(email_plain ? maybeEncrypt(email_plain) : null);
  }
  if (password_plain !== undefined && ALT_TABLE_SHAPE.passwordCol) {
    try { if (password_plain) assertKeyOrThrow(); } catch (e) { return reject(e); }
    sets.push(`${ALT_TABLE_SHAPE.passwordCol} = ?`); vals.push(password_plain ? maybeEncrypt(password_plain) : null);
  }

  sets.push(`updated_at = ?`); vals.push(Math.floor(Date.now() / 1000));
  if (!sets.length) return resolve();
  vals.push(id);
  db.run(`UPDATE alts SET ${sets.join(', ')} WHERE id = ?`, vals, (err) => err ? reject(err) : resolve());
});

const deleteAlt = (id) => new Promise((resolve, reject) => {
  db.run(`DELETE FROM alts WHERE id = ?`, [id], (err) => err ? reject(err) : resolve());
});

const setAltStatus = ({ id, status = null, last_seen = null }) => new Promise((resolve, reject) => {
  const sets = [], vals = [];
  if (status !== null)    { sets.push(`last_status = ?`); vals.push(status); }
  if (last_seen !== null) { sets.push(`last_seen = ?`); vals.push(last_seen); }
  if (!sets.length) return resolve();
  vals.push(id);
  db.run(`UPDATE alts SET ${sets.join(', ')} WHERE id = ?`, vals, (err) => err ? reject(err) : resolve());
});

// NEW: persist / update the bound Minecraft UUID for an alt (compat)
const setAltMcUuid = ({ id, mc_uuid = null }) => new Promise((resolve, reject) => {
  db.run(
    `UPDATE alts SET mc_uuid = ?, updated_at = ? WHERE id = ?`,
    [mc_uuid, Math.floor(Date.now() / 1000), id],
    (err) => err ? reject(err) : resolve()
  );
});

// NEW: persist IGN + UUID together
const setAltIdentity = ({ id, mc_uuid = undefined, mc_last_username = undefined }) => new Promise((resolve, reject) => {
  const sets = [], vals = [];
  if (mc_uuid !== undefined)          { sets.push(`mc_uuid = ?`); vals.push(mc_uuid); }
  if (mc_last_username !== undefined) { sets.push(`mc_last_username = ?`); vals.push(mc_last_username); }
  if (!sets.length) return resolve();
  sets.push(`updated_at = ?`); vals.push(Math.floor(Date.now() / 1000));
  vals.push(id);
  db.run(`UPDATE alts SET ${sets.join(', ')} WHERE id = ?`, vals, (err) => err ? reject(err) : resolve());
});

// Helpers for dashboard / runtime
function decryptAltRowSecrets(row) {
  if (!row) return row;
  const out = { ...row };

  // prefer new columns, else legacy names
  const emailBlob = row.email_enc ?? row.email_encrypted ?? null;
  const passBlob  = row.password_enc ?? row.password_encrypted ?? null;

  try { out.email_plain = emailBlob ? maybeDecrypt(emailBlob) : null; } catch { out.email_plain = null; }
  try { out.password_plain = passBlob ? maybeDecrypt(passBlob) : null; } catch { out.password_plain = null; }
  return out;
}

module.exports = {
  db,
  init,
  // walls
  getConfig,
  upsertConfig,
  insertWallCheck,
  resetWallChecks,
  getLastCheck,
  getRecentChecks,
  getLeaderboard,
  updateLastNotified,
  // outpost
  getOutpostConfig,
  upsertOutpostConfig,
  insertOutpostCheck,
  resetOutpostChecks,
  getOutpostLastCheck,
  getOutpostRecentChecks,
  getOutpostLeaderboard,
  updateOutpostLastNotified,
  // guild config
  getGuildConfig,
  upsertGuildConfig,
  // shard config (main)
  getShardConfig,
  upsertShardConfig,
  // shard config (rpost)
  getRpostShardConfig,
  upsertRpostShardConfig,
  // alt manager config + alts
  getAltManagerConfig,
  upsertAltManagerConfig,
  listAlts,
  getAltById,
  insertAlt,
  updateAlt,
  deleteAlt,
  setAltStatus,
  setAltMcUuid,        // compat
  setAltIdentity,      // <-- NEW export
  decryptAltRowSecrets,
};
