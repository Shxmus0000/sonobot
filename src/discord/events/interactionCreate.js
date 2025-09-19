// ========================================
// File: src/discord/events/interactionCreate.js
// ========================================
const { Events } = require('discord.js');
const {
  insertWallCheck, getConfig, getGuildConfig, upsertGuildConfig,
  insertOutpostCheck, getOutpostConfig,
} = require('../../database/db');

const { ensureDashboard, DASH_CUSTOM_IDS } = require('../dashboards/wallCheckBoard');
const { ensureOutpostDashboard, DASH_OUTPOST_IDS } = require('../dashboards/outpostBoard');

// Alt Manager interactions — IMPORTANT: import the correct name
const { handleAltManagerInteraction } = require('../dashboards/altManager');

// helper: delete ephemeral reply after ms
function autoDeleteReply(interaction, ms = 5000) {
  setTimeout(() => interaction.deleteReply().catch(() => {}), ms);
}

module.exports = {
  name: Events.InteractionCreate,
  async execute(interaction) {
    try {
      // Slash commands
      if (interaction.isChatInputCommand()) {
        const cmd = interaction.client.commands.get(interaction.commandName);
        if (!cmd) return;
        await cmd.execute(interaction);
        return;
      }

      // Alt Manager first; if handled, stop
      if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
        const altHandled = await handleAltManagerInteraction(interaction);
        if (altHandled) return;
      }

      // Config panel next; if handled, stop
      const { handleConfigInteraction } = require('../dashboards/configPanel');
      if (interaction.isButton() || interaction.isStringSelectMenu()) {
        const handled = await handleConfigInteraction(interaction);
        if (handled) return;
      }

      // ---- WALL DASHBOARD BUTTONS ----
      if (interaction.isButton() && [DASH_CUSTOM_IDS.CLEAR, DASH_CUSTOM_IDS.WEEWOO, DASH_CUSTOM_IDS.REFRESH].includes(interaction.customId)) {
        const guild = interaction.guild;
        const cfg = await getConfig(guild.id);
        if (!cfg?.channel_id) {
          await interaction.reply({ content: 'Not configured. Ask an admin to run /walls init', flags: 64 });
          autoDeleteReply(interaction);
          return;
        }

        if (interaction.customId === DASH_CUSTOM_IDS.CLEAR) {
          const now = Math.floor(Date.now() / 1000);
          const gcfgBefore = await getGuildConfig(guild.id);
          const wasActive = !!gcfgBefore?.weewoo_active;

          await insertWallCheck({ guild_id: guild.id, discord_id: interaction.user.id, timestamp: now, source: 'discord', status: 'clear' });
          await upsertGuildConfig({ guild_id: guild.id, weewoo_active: 0, weewoo_last_ping_at: 0 });

          await interaction.reply({ content: '🟢 Marked as **Clear** — thank you!', flags: 64 }); autoDeleteReply(interaction);

          if (wasActive && gcfgBefore?.raid_alerts_channel_id) {
            const raidChan = await guild.channels.fetch(gcfgBefore.raid_alerts_channel_id).catch(() => null);
            if (raidChan) await raidChan.send(`✅ **All clear** — alert cleared by ${interaction.user}`);
          }

          const channel = await guild.channels.fetch(cfg.channel_id);
          await ensureDashboard(guild, channel.id);
          return;
        }

        if (interaction.customId === DASH_CUSTOM_IDS.WEEWOO) {
          const now = Math.floor(Date.now() / 1000);
          await insertWallCheck({ guild_id: guild.id, discord_id: interaction.user.id, timestamp: now, source: 'discord', status: 'weewoo' });
          await upsertGuildConfig({ guild_id: guild.id, weewoo_active: 1 });

          const gcfg = await getGuildConfig(guild.id);
          const raidChannelId = gcfg?.raid_alerts_channel_id;
          if (raidChannelId) {
            const raidChan = await guild.channels.fetch(raidChannelId).catch(() => null);
            if (raidChan) await raidChan.send(`🚨 **WEEWOO! RAID ALERT!** (Base) Triggered by ${interaction.user}`);
          } else {
            const follow = await interaction.followUp({ content: '⚠️ No raid alerts channel set. Configure it in **#bot-configuration**.', flags: 64 });
            setTimeout(() => follow?.delete?.().catch(() => {}), 5000);
          }

          await interaction.reply({ content: '🚨 **Weewoo activated!** (base — persistent pings enabled)', flags: 64 }); autoDeleteReply(interaction);

          const channel = await guild.channels.fetch(cfg.channel_id);
          await ensureDashboard(guild, channel.id);
          return;
        }

        if (interaction.customId === DASH_CUSTOM_IDS.REFRESH) {
          const channel = await guild.channels.fetch(cfg.channel_id);
          await ensureDashboard(guild, channel.id);
          await interaction.reply({ content: '🔄 Refreshed.', flags: 64 }); autoDeleteReply(interaction);
          return;
        }
      }

      // ---- OUTPOST DASHBOARD BUTTONS ----
      if (interaction.isButton() && [DASH_OUTPOST_IDS.CLEAR, DASH_OUTPOST_IDS.WEEWOO, DASH_OUTPOST_IDS.REFRESH].includes(interaction.customId)) {
        const guild = interaction.guild;
        const cfg = await getOutpostConfig(guild.id);
        if (!cfg?.channel_id) {
          await interaction.reply({ content: 'Not configured. Set an Outpost Check Channel in the config panel.', flags: 64 });
          autoDeleteReply(interaction);
          return;
        }

        if (interaction.customId === DASH_OUTPOST_IDS.CLEAR) {
          const now = Math.floor(Date.now() / 1000);
          const gcfgBefore = await getGuildConfig(guild.id);
          const wasActive = !!gcfgBefore?.outpost_weewoo_active;

          await insertOutpostCheck({ guild_id: guild.id, discord_id: interaction.user.id, timestamp: now, source: 'discord', status: 'clear' });
          await upsertGuildConfig({ guild_id: guild.id, outpost_weewoo_active: 0, outpost_weewoo_last_ping_at: 0 });

          await interaction.reply({ content: '🟢 (Outpost) Marked as **Clear** — thank you!', flags: 64 }); autoDeleteReply(interaction);

          if (wasActive && gcfgBefore?.outpost_alerts_channel_id) {
            const aChan = await guild.channels.fetch(gcfgBefore.outpost_alerts_channel_id).catch(() => null);
            if (aChan) await aChan.send(`✅ **Outpost clear** — alert cleared by ${interaction.user}`);
          }

          const channel = await guild.channels.fetch(cfg.channel_id);
          await ensureOutpostDashboard(guild, channel.id);
          return;
        }

        if (interaction.customId === DASH_OUTPOST_IDS.WEEWOO) {
          const now = Math.floor(Date.now() / 1000);
          await insertOutpostCheck({ guild_id: guild.id, discord_id: interaction.user.id, timestamp: now, source: 'discord', status: 'weewoo' });
          await upsertGuildConfig({ guild_id: guild.id, outpost_weewoo_active: 1 });

          const gcfg = await getGuildConfig(guild.id);
          const alertId = gcfg?.outpost_alerts_channel_id;
          if (alertId) {
            const aChan = await guild.channels.fetch(alertId).catch(() => null);
            if (aChan) await aChan.send(`🚨 **WEEWOO! RAID ALERT!** (Outpost) Triggered by ${interaction.user}`);
          } else {
            const follow = await interaction.followUp({ content: '⚠️ No outpost alerts channel set. Configure it in **#bot-configuration**.', flags: 64 });
            setTimeout(() => follow?.delete?.().catch(() => {}), 5000);
          }

          await interaction.reply({ content: '🚨 **Outpost Weewoo activated!** (persistent pings enabled)', flags: 64 }); autoDeleteReply(interaction);

          const channel = await guild.channels.fetch(cfg.channel_id);
          await ensureOutpostDashboard(guild, channel.id);
          return;
        }

        if (interaction.customId === DASH_OUTPOST_IDS.REFRESH) {
          const channel = await guild.channels.fetch(cfg.channel_id);
          await ensureOutpostDashboard(guild, channel.id);
          await interaction.reply({ content: '🔄 Refreshed.', flags: 64 }); autoDeleteReply(interaction);
          return;
        }
      }
    } catch (err) {
      console.error('interactionCreate error:', err);
      if (interaction.deferred || interaction.replied) {
        try { await interaction.editReply({ content: '⚠️ Something went wrong.' }); } catch {}
      } else {
        try { await interaction.reply({ content: '⚠️ Something went wrong.', flags: 64 }); } catch {}
      }
    }
  }
};
