// ========================================
// File: src/discord/dashboards/wallCheckBoard.js
// ========================================
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const dayjs = require('dayjs');
const relativeTime = require('dayjs/plugin/relativeTime');
const { getConfig, getLastCheck, getRecentChecks, getLeaderboard } = require('../../database/db');

dayjs.extend(relativeTime);

const DASH_CUSTOM_IDS = {
  CLEAR: 'walls_clear',
  WEEWOO: 'walls_weewoo',
  REFRESH: 'walls_refresh',
};

async function buildEmbed(guild) {
  const cfg = await getConfig(guild.id);
  const last = await getLastCheck(guild.id);
  const recent = await getRecentChecks(guild.id, 5);
  const since24h = dayjs().subtract(24, 'hour').unix();
  const leaderboard = await getLeaderboard(guild.id, since24h);

  const interval = cfg?.interval_minutes ?? 30;
  const lastStr = last ? `${dayjs.unix(last.timestamp).fromNow()} by <@${last.discord_id}>` : 'Never';
  const overdue = last ? (dayjs().diff(dayjs.unix(last.timestamp), 'minute') > interval) : true;

  const recentLines = recent.map(r => {
    const tag = r.status === 'weewoo' ? '🚨' : '🟢';
    return `• ${tag} <@${r.discord_id}> — ${dayjs.unix(r.timestamp).fromNow()}`;
  }).join('\n') || 'No checks yet';

  const lbLines = leaderboard.map((r, i) => `#${i + 1} <@${r.discord_id}> — **${r.count}**`).join('\n') || 'No data in last 24h';

  const embed = new EmbedBuilder()
    .setTitle('🛡️ Buffer / Wall Checks')
    .setDescription(
      `Use the buttons below to report the current wall status.\n\n` +
      `🟢 **Clear** — Base checked, all safe\n` +
      `🚨 **Weewoo** — Raid alert, walls compromised\n` +
      `Interval is **${interval} minutes**.`
    )
    .addFields(
      { name: 'Last check', value: lastStr, inline: false },
      { name: 'Status', value: overdue ? '⚠️ **OVERDUE** — please check now!' : '✅ Up to date', inline: true },
      { name: 'Recent', value: recentLines, inline: false },
      { name: 'Top (24h)', value: lbLines, inline: false },
    )
    .setFooter({ text: `Guild: ${guild.name}` })
    .setTimestamp(new Date());

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(DASH_CUSTOM_IDS.CLEAR).setLabel('🟢 Clear').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(DASH_CUSTOM_IDS.WEEWOO).setLabel('🚨 Weewoo').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(DASH_CUSTOM_IDS.REFRESH).setLabel('🔄 Refresh').setStyle(ButtonStyle.Secondary),
  );

  return { embed, row };
}

async function ensureDashboard(guild, channelId) {
  const cfg = await getConfig(guild.id);
  const channel = await guild.channels.fetch(channelId);

  const { embed, row } = await buildEmbed(guild);

  if (cfg?.dashboard_message_id) {
    try {
      const msg = await channel.messages.fetch(cfg.dashboard_message_id);
      await msg.edit({ embeds: [embed], components: [row] });
      return msg;
    } catch (e) {
      // message missing; post new
    }
  }

  const newMsg = await channel.send({ embeds: [embed], components: [row] });
  return newMsg;
}

module.exports = { ensureDashboard, buildEmbed, DASH_CUSTOM_IDS };
