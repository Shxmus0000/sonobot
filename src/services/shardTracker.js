// ========================================
// File: src/services/shardTracker.js
// Thin wrapper over trackerCore
// ========================================
const { getGuildConfig, getShardConfig, upsertShardConfig } = require('../database/db');
const { runOnceForGuild: runCore } = require('./trackerCore');

async function runOnceForGuild(client, guildId) {
  return runCore(
    client,
    guildId,
    'shard',
    {
      getConfig: getShardConfig,
      upsertConfig: upsertShardConfig,
      getGuildConfig,
    },
    {
      titlePrefix: '🛡️ Shard Check',
      footerText: 'Sōnobot Shard Tracker',
      altField: 'shard_checker_alt_id',
    }
  );
}

module.exports = { runOnceForGuild };
