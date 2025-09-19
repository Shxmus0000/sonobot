// tools/factory-reset-auth.js
const fs = require('fs/promises');
const fssync = require('fs');
const path = require('path');

(async () => {
  try {
    // Project root (one level up from /tools)
    const ROOT = path.resolve(__dirname, '..');

    // Load .env so we can read cache file paths
    try {
      require('dotenv').config({ path: path.join(ROOT, '.env') });
    } catch (_) {}

    // Bring up DB
    const dbmod = require('../src/database/db');
    dbmod.init();

    const run = (sql, params = []) =>
      new Promise((resolve, reject) => {
        dbmod.db.run(sql, params, function (err) {
          if (err) reject(err);
          else resolve(this);
        });
      });

    const get = (sql, params = []) =>
      new Promise((resolve, reject) => {
        dbmod.db.get(sql, params, (err, row) => {
          if (err) reject(err);
          else resolve(row || null);
        });
      });

    // --- Info before wipe
    const before = await get(`SELECT COUNT(*) AS c FROM alts`);
    const countBefore = before?.c ?? 0;

    // --- DB wipe: delete all alts + clear checker assignments
    await run(`DELETE FROM alts`);
    await run(`UPDATE guild_config SET shard_checker_alt_id = 0, rpost_checker_alt_id = 0`);
    // Optional: also clear last_status/last_seen everywhere (not needed after DELETE, but safe if you only UPDATE'd)
    // await run(`UPDATE alts SET mc_uuid = NULL, mc_last_username = NULL, last_status = NULL, last_seen = 0`);

    // Shrink DB file
    await run(`VACUUM`);

    // --- Filesystem wipe: per-alt token caches + standalone caches
    const profilesRoot = path.join(ROOT, 'data', 'nmp-cache');

    // Extra safety: never rm outside the project /data folder
    const DATA_DIR = path.join(ROOT, 'data');
    const isInsideData = profilesRoot.startsWith(DATA_DIR);

    if (isInsideData && fssync.existsSync(profilesRoot)) {
      await fs.rm(profilesRoot, { recursive: true, force: true });
    }

    // Remove standalone auth caches (from .env), resolving relative paths from project root
    const maybePaths = [
      process.env.SHARD_TRACKER_TOKEN_CACHE,
      process.env.RPOST_TRACKER_TOKEN_CACHE,
    ]
      .filter(Boolean)
      .map(p => (path.isAbsolute(p) ? p : path.join(ROOT, p)));

    for (const p of maybePaths) {
      try {
        if (p.startsWith(ROOT) && fssync.existsSync(p)) {
          await fs.rm(p, { recursive: true, force: true });
        }
      } catch (_) {
        // ignore
      }
    }

    // Recreate empty profiles root so future runs have the folder
    try {
      await fs.mkdir(profilesRoot, { recursive: true });
    } catch (_) {}

    // --- Close DB
    await new Promise((resolve, reject) => {
      dbmod.db.close(err => (err ? reject(err) : resolve()));
    });

    console.log('✅ Factory reset complete.');
    console.log(`   • Deleted ${countBefore} alt row(s) from the database`);
    console.log(`   • Cleared checker assignments in guild_config`);
    console.log(`   • Removed per-alt caches under: ${profilesRoot}`);
    for (const p of maybePaths) console.log(`   • Removed cache file (if present): ${p}`);

    console.log('\nNext steps:');
    console.log('1) Restart the bot.');
    console.log('2) Open Alt Manager → Add Alt to re-add each account.');
    console.log('3) Complete Microsoft device logins when prompted.');
    process.exit(0);
  } catch (e) {
    console.error('❌ Factory reset failed:', e?.message || e);
    process.exit(1);
  }
})();
