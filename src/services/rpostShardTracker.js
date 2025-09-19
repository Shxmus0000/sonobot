// ========================================
// File: src/services/rpostShardTracker.js
// Thin wrapper over trackerCore
// ========================================
const { getGuildConfig, getRpostShardConfig, upsertRpostShardConfig } = require('../database/db');
const { runOnceForGuild: runCore } = require('./trackerCore');

async function runOnceForGuild(client, guildId) {
  return runCore(
    client,
    guildId,
    'rpost',
    {
      getConfig: getRpostShardConfig,
      upsertConfig: upsertRpostShardConfig,
      getGuildConfig,
    },
    {
      titlePrefix: '🛡️ RPost Shard Check',
      footerText: 'Sōnobot RPost Tracker',
      altField: 'rpost_checker_alt_id',
    }
  );
}

module.exports = { runOnceForGuild };
