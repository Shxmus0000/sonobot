// ========================================
// File: src/discord/events/ready.js
// ========================================
const { Events, REST, Routes } = require('discord.js');
const { ensureConfigPanel } = require('../dashboards/configPanel');

// Alt Manager additions
const { listAlts, getAltManagerConfig } = require('../../database/db');
const { ensureAltManagerDashboard } = require('../dashboards/altManager');

// NOTE: your altRunner is in src/discord/alts/
const AltRunner = require('../alts/altRunner');

// Start periodic tasks here (moved from index.js)
const { startScheduler } = require('../../utils/scheduler');

module.exports = {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    console.log(`✅ Logged in as ${client.user.tag}`);

    // Init AltRunner with the discord client (so it can post device-code instructions)
    AltRunner.init(client);

    const guildId = process.env.GUILD_ID;
    if (guildId) {
      // Register slash commands (guild-scoped for fast iteration)
      const commands = client.commands ?? new Map();
      const body = Array.from(commands.values()).map(c => c.data.toJSON());
      const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

      try {
        await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body });
        console.log(`🧰 Registered ${body.length} guild commands in ${guildId}.`);
      } catch (e) {
        console.error('Failed to register commands:', e);
      }
    } else {
      console.warn('ℹ️ Set GUILD_ID in .env to auto-register guild slash commands.');
    }

    // Ensure panels and auto-login alts
    for (const [, guild] of client.guilds.cache) {
      try {
        await ensureConfigPanel(guild);
      } catch (e) {
        console.error(`Config panel error in guild ${guild.id}:`, e);
      }

      try {
        // Ensure Alt Manager dashboard if configured
        const altCfg = await getAltManagerConfig(guild.id);
        if (altCfg?.channel_id) {
          try {
            await ensureAltManagerDashboard(guild, altCfg.channel_id);
            console.log(`🧪 Alt Manager dashboard ensured for guild ${guild.id}.`);
          } catch (e) {
            console.warn(`Alt Manager dashboard error in guild ${guild.id}: ${e.message}`);
          }
        } else {
          console.log(`🧪 Alt Manager channel not set for guild ${guild.id}; skip dashboard.`);
        }

        // Auto-login all alts on startup
        const alts = await listAlts(guild.id);
        for (const alt of alts) {
          try {
            await AltRunner.loginAlt(alt.id);
            console.log(`🔌 Auto-login started for alt "${alt.label}" (${alt.id}) in guild ${guild.id}.`);
          } catch (e) {
            console.warn(`⚠️ Auto-login failed for alt "${alt.label}" (${alt.id}) in guild ${guild.id}: ${e.message}`);
          }
        }
      } catch (e) {
        console.warn(`Alt setup failed in guild ${guild.id}:`, e);
      }
    }

    // Start all periodic jobs (walls/outpost, shard/rpost, etc.)
    try {
      startScheduler(client);
    } catch (e) {
      console.error('startScheduler failed:', e);
    }
  }
};
