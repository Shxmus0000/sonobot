// ========================================
// File: src/discord/dashboards/outpostBoard.js
// ========================================
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const dayjs = require('dayjs');
const relativeTime = require('dayjs/plugin/relativeTime');
const {
  getOutpostConfig,
  getOutpostLastCheck,
  getOutpostRecentChecks,
  getOutpostLeaderboard,
} = require('../../database/db');

dayjs.extend(relativeTime);

const DASH_OUTPOST_IDS = {
  CLEAR: 'outpost_clear',
  WEEWOO: 'outpost_weewoo',
  REFRESH: 'outpost_refresh',
};

async function buildOutpostEmbed(guild) {
  const cfg = await getOutpostConfig(guild.id);
  const last = await getOutpostLastCheck(guild.id);
  const recent = await getOutpostRecentChecks(guild.id, 5);
  const since24h = dayjs().subtract(24, 'hour').unix();
  const leaderboard = await getOutpostLeaderboard(guild.id, since24h);

  const interval = cfg?.interval_minutes ?? 30;
  const lastStr = last ? `${dayjs.unix(last.timestamp).fromNow()} by <@${last.discord_id}>` : 'Never';
  const overdue = last ? (dayjs().diff(dayjs.unix(last.timestamp), 'minute') > interval) : true;

  const recentLines = recent.map(r => `• <@${r.discord_id}> — ${dayjs.unix(r.timestamp).fromNow()}`).join('\n') || 'No checks yet';
  const lbLines = leaderboard.map((r, i) => `#${i+1} <@${r.discord_id}> — **${r.count}**`).join('\n') || 'No data in last 24h';

  const embed = new EmbedBuilder()
    .setTitle('🏴 Raiding Outpost — Status Checks')
    .setDescription(
      `Use the buttons to report outpost status.\n\n` +
      `🟢 **Clear** — Outpost secure\n` +
      `🚨 **Weewoo** — Under attack\n` +
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
    new ButtonBuilder().setCustomId(DASH_OUTPOST_IDS.CLEAR).setLabel('🟢 Clear').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(DASH_OUTPOST_IDS.WEEWOO).setLabel('🚨 Weewoo').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(DASH_OUTPOST_IDS.REFRESH).setLabel('🔄 Refresh').setStyle(ButtonStyle.Secondary),
  );

  return { embed, row };
}

async function ensureOutpostDashboard(guild, channelId) {
  const cfg = await getOutpostConfig(guild.id);
  const channel = await guild.channels.fetch(channelId);

  const { embed, row } = await buildOutpostEmbed(guild);

  if (cfg?.dashboard_message_id) {
    try {
      const msg = await channel.messages.fetch(cfg.dashboard_message_id);
      await msg.edit({ embeds: [embed], components: [row] });
      return msg;
    } catch { /* fallthrough */ }
  }
  const newMsg = await channel.send({ embeds: [embed], components: [row] });
  return newMsg;
}

module.exports = { ensureOutpostDashboard, buildOutpostEmbed, DASH_OUTPOST_IDS };
