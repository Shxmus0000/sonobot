// ========================================
// File: src/utils/scheduler.js
// ========================================
const dayjs = require('dayjs');
const {
  // walls
  getConfig, getLastCheck, updateLastNotified,
  // outpost
  getOutpostConfig, getOutpostLastCheck, updateOutpostLastNotified,
  // guild
  getGuildConfig, upsertGuildConfig,
  // shard (main + rpost)
  getShardConfig, getRpostShardConfig,
} = require('../database/db');

const { runOnceForGuild: runShardOnce } = require('../services/shardTracker');
const { runOnceForGuild: runRpostOnce } = require('../services/rpostShardTracker');

async function tick(client) {
  for (const [guildId, guild] of client.guilds.cache) {
    try {
      const now = dayjs().unix();
      const gcfg = await getGuildConfig(guildId);

      // --- WALLS OVERDUE (skip if paused) ---
      const wcfg = await getConfig(guildId);
      if (wcfg?.channel_id && !gcfg?.base_alerts_paused) {
        const channel = guild.channels.cache.get(wcfg.channel_id);
        if (channel) {
          const last = await getLastCheck(guildId);
          const wallIntervalSecs = Math.max(5, (wcfg.interval_minutes || 30)) * 60;
          const lastTs = last ? last.timestamp : 0;
          const overdue = now - lastTs > wallIntervalSecs;
          const throttleSecs = Math.min(wallIntervalSecs, 10 * 60);
          const alreadyNotified = now - (wcfg.last_notified_at || 0) < throttleSecs;

          if (overdue && !alreadyNotified) {
            await channel.send(`⚠️ **Wall check overdue!** Last check was ${lastTs ? `<t:${lastTs}:R>` : 'never'}. Please report status.`);
            await updateLastNotified(guildId, now);
          }
        }
      }

      // --- OUTPOST OVERDUE (skip if paused) ---
      const ocfg = await getOutpostConfig(guildId);
      if (ocfg?.channel_id && !gcfg?.outpost_alerts_paused) {
        const channel = guild.channels.cache.get(ocfg.channel_id);
        if (channel) {
          const last = await getOutpostLastCheck(guildId);
          const intervalSecs = Math.max(5, (ocfg.interval_minutes || 30)) * 60;
          const lastTs = last ? last.timestamp : 0;
          const overdue = now - lastTs > intervalSecs;
          const throttleSecs = Math.min(intervalSecs, 10 * 60);
          const alreadyNotified = now - (ocfg.last_notified_at || 0) < throttleSecs;

          if (overdue && !alreadyNotified) {
            await channel.send(`⚠️ **Outpost check overdue!** Last check was ${lastTs ? `<t:${lastTs}:R>` : 'never'}. Please report status.`);
            await updateOutpostLastNotified(guildId, now);
          }
        }
      }

      // --- WEEWOO RE-PINGS (WALLS) skip if paused ---
      if (gcfg?.weewoo_active && !gcfg?.base_alerts_paused) {
        const raidChanId = gcfg.raid_alerts_channel_id;
        const intervalMin = Math.max(1, gcfg.weewoo_ping_interval_minutes || 2);
        const lastPing = gcfg.weewoo_last_ping_at || 0;

        if (raidChanId && now - lastPing >= intervalMin * 60 - 2) {
          const raidChan = guild.channels.cache.get(raidChanId) || await guild.channels.fetch(raidChanId).catch(() => null);
          if (raidChan) {
            await raidChan.send(`🚨 **WEEWOO ACTIVE (Base)** — not clear. Use **🟢 Clear** in #buffer-checks when safe.`);
            await upsertGuildConfig({ guild_id: guildId, weewoo_last_ping_at: now });
          }
        }
      }

      // --- WEEWOO RE-PINGS (OUTPOST) skip if paused ---
      if (gcfg?.outpost_weewoo_active && !gcfg?.outpost_alerts_paused) {
        const alertId = gcfg.outpost_alerts_channel_id;
        const intervalMin = Math.max(1, gcfg.outpost_weewoo_ping_interval_minutes || 2);
        const lastPing = gcfg.outpost_weewoo_last_ping_at || 0;

        if (alertId && now - lastPing >= intervalMin * 60 - 2) {
          const aChan = guild.channels.cache.get(alertId) || await guild.channels.fetch(alertId).catch(() => null);
          if (aChan) {
            await aChan.send(`🚨 **WEEWOO ACTIVE (Outpost)** — not clear. Use **🟢 Clear** on the Outpost dashboard when safe.`);
            await upsertGuildConfig({ guild_id: guildId, outpost_weewoo_last_ping_at: now });
          }
        }
      }

      // --- SHARD TRACKER (MAIN) ---
      const scfg = await getShardConfig(guildId);
      if (scfg?.enabled && scfg?.channel_id) {
        const intervalSecs = Math.max(1, scfg.interval_minutes || 5) * 60;
        const lastRun = scfg.last_run_at || 0;
        if (now - lastRun >= intervalSecs - 2) {
          await runShardOnce(client, guildId);
        }
      }

      // --- SHARD TRACKER (RPOST) ---
      const rcfg = await getRpostShardConfig(guildId);
      if (rcfg?.enabled && rcfg?.channel_id) {
        const intervalSecs = Math.max(1, rcfg.interval_minutes || 5) * 60;
        const lastRun = rcfg.last_run_at || 0;
        if (now - lastRun >= intervalSecs - 2) {
          await runRpostOnce(client, guildId);
        }
      }
    } catch (e) {
      console.error(`scheduler tick error in guild ${guildId}:`, e);
    }
  }
}

function startScheduler(client) {
  setInterval(() => tick(client), 10 * 1000);
}

module.exports = { startScheduler };
