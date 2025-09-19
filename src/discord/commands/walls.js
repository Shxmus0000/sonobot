// ========================================
// File: src/discord/commands/walls.js
// ========================================
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const dayjs = require('dayjs');
const { upsertConfig, getConfig, getLeaderboard } = require('../../database/db');
const { ensureDashboard } = require('../dashboards/wallCheckBoard');

module.exports.data = new SlashCommandBuilder()
  .setName('walls')
  .setDescription('Wall/buffer checks setup & controls')
  .addSubcommand(sub => sub
    .setName('init')
    .setDescription('Initialize #buffer-checks dashboard in this server')
    .addIntegerOption(opt =>
      opt.setName('interval_minutes')
        .setDescription('Interval between required checks (default 30)')
        .setMinValue(5)
    )
  )
  .addSubcommand(sub => sub
    .setName('set-interval')
    .setDescription('Set the required check interval in minutes')
    .addIntegerOption(opt =>
      opt.setName('interval_minutes')
        .setDescription('Minutes')
        .setRequired(true)
        .setMinValue(5)
    )
  )
  .addSubcommand(sub => sub
    .setName('leaderboard')
    .setDescription('Show top wall checkers for a period')
    .addStringOption(opt =>
      opt.setName('period')
        .setDescription('Time period')
        .addChoices(
          { name: '24h', value: '24h' },
          { name: '7d', value: '7d' },
          { name: '30d', value: '30d' },
        )
    )
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

module.exports.execute = async (interaction) => {
  const sub = interaction.options.getSubcommand();
  const guild = interaction.guild;

  if (sub === 'init') {
    const interval = interaction.options.getInteger('interval_minutes') ?? 30;

    // Find or create #buffer-checks
    let channel = guild.channels.cache.find(c => c.name === 'buffer-checks');
    if (!channel) {
      channel = await guild.channels.create({
        name: 'buffer-checks',
        reason: 'Wall checks dashboard',
      });
    }

    await upsertConfig({ guild_id: guild.id, channel_id: channel.id, interval_minutes: interval });

    const dashMsg = await ensureDashboard(guild, channel.id);
    await upsertConfig({ guild_id: guild.id, dashboard_message_id: dashMsg.id });

    await interaction.reply({
      content: `✅ Wall checks initialized in ${channel}. Interval set to **${interval} min**.`,
      ephemeral: true
    });
    return;
  }

  if (sub === 'set-interval') {
    const interval = interaction.options.getInteger('interval_minutes');
    const cfg = await getConfig(guild.id);
    if (!cfg || !cfg.channel_id) {
      return interaction.reply({ content: '❌ Run `/walls init` first.', ephemeral: true });
    }

    await upsertConfig({ guild_id: guild.id, interval_minutes: interval });
    await interaction.reply({ content: `⏱️ Interval updated to **${interval} minutes**.`, ephemeral: true });
    return;
  }

  if (sub === 'leaderboard') {
    const period = interaction.options.getString('period') ?? '24h';

    let since;
    if (period === '7d') since = dayjs().subtract(7, 'day').unix();
    else if (period === '30d') since = dayjs().subtract(30, 'day').unix();
    else since = dayjs().subtract(24, 'hour').unix();

    const rows = await getLeaderboard(guild.id, since);
    const lines = rows.map((r, i) => `#${i + 1} <@${r.discord_id}> — **${r.count}**`).join('\n') || 'No data.';

    await interaction.reply({
      embeds: [{
        title: `🏆 Wall Check Leaderboard (${period})`,
        description: lines,
        color: 0x00AE86
      }]
    });
    return;
  }
};
