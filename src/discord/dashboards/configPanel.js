// ========================================
// File: src/discord/dashboards/configPanel.js
// ========================================
const {
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} = require('discord.js');

const {
  // guild + walls/outpost
  getGuildConfig, upsertGuildConfig,
  getConfig, upsertConfig, resetWallChecks,
  getOutpostConfig, upsertOutpostConfig, resetOutpostChecks,
  // shard
  getShardConfig, upsertShardConfig,
  getRpostShardConfig, upsertRpostShardConfig,
  // alt manager
  getAltManagerConfig, upsertAltManagerConfig,
  // NEW: show checker names
  getAltById,
} = require('../../database/db');

const { ensureDashboard } = require('./wallCheckBoard');
const { ensureOutpostDashboard } = require('./outpostBoard');
const { ensureAltManagerDashboard } = require('./altManager');

// Use assigned alts: when enabling trackers, log those alts in so they’re ready
const AltRunner = require('../alts/altRunner');

// =================== IDs ===================
const IDS = {
  // main
  BTN_BUFFER_MENU: 'cfg_btn_buffer_menu',
  BTN_OUTPOST_MENU: 'cfg_btn_outpost_menu',
  BTN_SHARD_MENU: 'cfg_btn_shard_menu',
  BTN_RPOST_MENU: 'cfg_btn_rpost_menu',
  BTN_ALTMGR_MENU: 'cfg_btn_altmgr_menu',
  BTN_REFRESH: 'cfg_btn_refresh',

  // buffer submenu
  BTN_RAID_CHAN: 'cfg_btn_raid_channel',
  BTN_INTERVAL_WEEWOO: 'cfg_btn_weewoo_interval',
  BTN_INTERVAL_WALLS: 'cfg_btn_wall_interval',
  BTN_WALL_CHANNEL: 'cfg_btn_wall_channel',
  BTN_RESET_WALLS: 'cfg_btn_reset_walls',
  BTN_START_WEEWOO: 'cfg_btn_start_weewoo',
  BTN_STOP_WEEWOO: 'cfg_btn_stop_weewoo',

  // outpost submenu
  BTN_OUTPOST_ALERT_CHAN: 'cfg_btn_outpost_alert_channel',
  BTN_OUTPOST_INTERVAL_WEEWOO: 'cfg_btn_outpost_weewoo_interval',
  BTN_OUTPOST_INTERVAL: 'cfg_btn_outpost_interval',
  BTN_OUTPOST_CHANNEL: 'cfg_btn_outpost_channel',
  BTN_RESET_OUTPOST: 'cfg_btn_reset_outpost',
  BTN_OUTPOST_START: 'cfg_btn_outpost_start',
  BTN_OUTPOST_STOP: 'cfg_btn_outpost_stop',

  // shard submenu (main)
  BTN_SHARD_CHANNEL: 'cfg_btn_shard_channel',
  BTN_SHARD_INTERVAL: 'cfg_btn_shard_interval',
  BTN_SHARD_START: 'cfg_btn_shard_start',
  BTN_SHARD_STOP: 'cfg_btn_shard_stop',

  // rpost shard submenu
  BTN_RPOST_CHANNEL: 'cfg_btn_rpost_channel',
  BTN_RPOST_INTERVAL: 'cfg_btn_rpost_interval',
  BTN_RPOST_START: 'cfg_btn_rpost_start',
  BTN_RPOST_STOP: 'cfg_btn_rpost_stop',

  // alt manager submenu
  BTN_ALTMGR_CHANNEL: 'cfg_btn_altmgr_channel',

  BACK: 'cfg_back',

  // string selects (intervals + channel picks)
  PICK_RAID: 'cfg_pick_raid_channel',
  PICK_INTERVAL_WEEWOO: 'cfg_pick_interval_weewoo',
  PICK_INTERVAL_WALLS: 'cfg_pick_interval_walls',
  PICK_WALL_CHANNEL: 'cfg_pick_wall_channel',
  PICK_OUTPOST_ALERT: 'cfg_pick_outpost_alert_channel',
  PICK_OUTPOST_INTERVAL_WEEWOO: 'cfg_pick_outpost_weewoo_interval',
  PICK_OUTPOST_INTERVAL: 'cfg_pick_outpost_interval',
  PICK_OUTPOST_CHANNEL: 'cfg_pick_outpost_channel',
  PICK_SHARD_CHANNEL: 'cfg_pick_shard_channel',
  PICK_SHARD_INTERVAL: 'cfg_pick_shard_interval',
  PICK_RPOST_CHANNEL: 'cfg_pick_rpost_channel',
  PICK_RPOST_INTERVAL: 'cfg_pick_rpost_interval',
  PICK_ALTMGR_CHANNEL: 'cfg_pick_altmgr_channel',

  // paging buttons (suffix with target + page)
  PAGE_PREV: 'cfg_page_prev',
  PAGE_NEXT: 'cfg_page_next',
};

// Panel title helper for robust detection
const PANEL_TITLE = '⚙️ Bot Configuration';

// Map a target key to updater + title/desc
const CHANNEL_TARGETS = {
  raid: {
    title: 'Set Raid Alerts Channel',
    desc: 'Pick a text channel to receive Weewoo alerts for the main base.',
    apply: async (guild, channelId) => upsertGuildConfig({ guild_id: guild.id, raid_alerts_channel_id: channelId }),
    onDone: buildBufferSubmenu,
  },
  wall: {
    title: 'Set Wall Check Channel',
    desc: 'Pick a text channel to host the Wall/Buffer dashboard.',
    apply: async (guild, channelId) => {
      const before = await getConfig(guild.id);
      const oldChannelId = before?.channel_id || null;
      const oldMsgId = before?.dashboard_message_id || null;

      await upsertConfig({ guild_id: guild.id, channel_id: channelId, dashboard_message_id: null });

      const newChan = await guild.channels.fetch(channelId).catch(() => null);
      if (newChan) {
        const newMsg = await ensureDashboard(guild, channelId);
        await upsertConfig({ guild_id: guild.id, dashboard_message_id: newMsg.id });
      }
      if (oldChannelId && oldMsgId && oldChannelId !== channelId) {
        const oldChan = await guild.channels.fetch(oldChannelId).catch(() => null);
        if (oldChan) oldChan.messages.delete(oldMsgId).catch(() => {});
      }
    },
    onDone: buildBufferSubmenu,
  },
  outpost_alert: {
    title: 'Set Outpost Alerts Channel',
    desc: 'Pick a text channel to receive Weewoo alerts for the outpost.',
    apply: async (guild, channelId) => upsertGuildConfig({ guild_id: guild.id, outpost_alerts_channel_id: channelId }),
    onDone: buildOutpostSubmenu,
  },
  outpost_dash: {
    title: 'Set Outpost Check Channel',
    desc: 'Pick a text channel to host the Outpost dashboard.',
    apply: async (guild, channelId) => {
      const before = await getOutpostConfig(guild.id);
      const oldChannelId = before?.channel_id || null;
      const oldMsgId = before?.dashboard_message_id || null;

      await upsertOutpostConfig({ guild_id: guild.id, channel_id: channelId, dashboard_message_id: null });

      const newChan = await guild.channels.fetch(channelId).catch(() => null);
      if (newChan) {
        const newMsg = await ensureOutpostDashboard(guild, channelId);
        await upsertOutpostConfig({ guild_id: guild.id, dashboard_message_id: newMsg.id });
      }
      if (oldChannelId && oldMsgId && oldChannelId !== channelId) {
        const oldChan = await guild.channels.fetch(oldChannelId).catch(() => null);
        if (oldChan) oldChan.messages.delete(oldMsgId).catch(() => {});
      }
    },
    onDone: buildOutpostSubmenu,
  },
  shard: {
    title: 'Set Shard Check Channel',
    desc: 'Pick a text channel where the shard tracker will post.',
    apply: async (guild, channelId) => upsertShardConfig({ guild_id: guild.id, channel_id: channelId }),
    onDone: buildShardSubmenu,
  },
  rpost_shard: {
    title: 'Set Rpost Shard Check Channel',
    desc: 'Pick a text channel where the Rpost shard tracker will post.',
    apply: async (guild, channelId) => upsertRpostShardConfig({ guild_id: guild.id, channel_id: channelId }),
    onDone: buildRpostShardSubmenu,
  },
  altmgr: {
    title: 'Set Alt Manager Channel',
    desc: 'Pick a text channel that will host the Alt Manager dashboard.',
    apply: async (guild, channelId) => {
      const before = await getAltManagerConfig(guild.id);
      const oldChannelId = before?.channel_id || null;
      const oldMsgId = before?.dashboard_message_id || null;

      await upsertAltManagerConfig({ guild_id: guild.id, channel_id: channelId, dashboard_message_id: null });

      const newChan = await guild.channels.fetch(channelId).catch(() => null);
      if (newChan) {
        const newMsg = await ensureAltManagerDashboard(guild, channelId);
        await upsertAltManagerConfig({ guild_id: guild.id, dashboard_message_id: newMsg.id });
      }
      if (oldChannelId && oldMsgId && oldChannelId !== channelId) {
        const oldChan = await guild.channels.fetch(oldChannelId).catch(() => null);
        if (oldChan) oldChan.messages.delete(oldMsgId).catch(() => {});
      }
    },
    onDone: buildAltMgrSubmenu,
  },
};

// =================== UI builders ===================
async function buildMainEmbed(guild) {
  const gcfg = await getGuildConfig(guild.id);
  const wcfg = await getConfig(guild.id);
  const ocfg = await getOutpostConfig(guild.id);
  const scfg = await getShardConfig(guild.id);
  const rcfg = await getRpostShardConfig(guild.id);
  const acfg = await getAltManagerConfig(guild.id);

  const raidChan        = gcfg?.raid_alerts_channel_id ? `<#${gcfg.raid_alerts_channel_id}>` : '*not set*';
  const outpostAlert    = gcfg?.outpost_alerts_channel_id ? `<#${gcfg.outpost_alerts_channel_id}>` : '*not set*';
  const weewooInterval  = gcfg?.weewoo_ping_interval_minutes ?? 2;
  const wallInterval    = wcfg?.interval_minutes ?? 30;
  const wallChan        = wcfg?.channel_id ? `<#${wcfg.channel_id}>` : '*not set*';
  const weewooActive    = gcfg?.weewoo_active ? 'ACTIVE' : 'idle';
  const basePaused      = gcfg?.base_alerts_paused ? 'paused' : 'live';

  const outpostInterval = ocfg?.interval_minutes ?? 30;
  const outpostChan     = ocfg?.channel_id ? `<#${ocfg.channel_id}>` : '*not set*';
  const outpostWeewoo   = gcfg?.outpost_weewoo_active ? 'ACTIVE' : 'idle';
  const outPaused       = gcfg?.outpost_alerts_paused ? 'paused' : 'live';

  const shardChan       = scfg?.channel_id ? `<#${scfg.channel_id}>` : '*not set*';
  const shardInterval   = scfg?.interval_minutes ?? 5;
  const shardStatus     = scfg?.enabled ? 'ON' : 'OFF';

  const rpostChan       = rcfg?.channel_id ? `<#${rcfg.channel_id}>` : '*not set*';
  const rpostInterval   = rcfg?.interval_minutes ?? 5;
  const rpostStatus     = rcfg?.enabled ? 'ON' : 'OFF';

  const altMgrChan      = acfg?.channel_id ? `<#${acfg.channel_id}>` : '*not set*';

  // NEW: show which alt is assigned as checker (set from Alt Manager)
  const shardCheckerId  = gcfg?.shard_checker_alt_id || 0;
  const rpostCheckerId  = gcfg?.rpost_checker_alt_id || 0;
  const shardCheckerAlt = shardCheckerId ? await getAltById(shardCheckerId).catch(() => null) : null;
  const rpostCheckerAlt = rpostCheckerId ? await getAltById(rpostCheckerId).catch(() => null) : null;

  const embed = new EmbedBuilder()
    .setTitle(PANEL_TITLE)
    .setDescription(
      `Use the buttons to configure features.\n\n` +
      `**Walls/Buffer**\n` +
      `• Status: ${weewooActive} (${basePaused})\n` +
      `• Ping Interval: ${weewooInterval} min\n` +
      `• Check Interval: ${wallInterval} min\n` +
      `• Alerts Channel: ${raidChan}\n` +
      `• Dashboard Channel: ${wallChan}\n\n` +
      `**Raiding Outpost**\n` +
      `• Status: ${outpostWeewoo} (${outPaused})\n` +
      `• Ping Interval: ${gcfg?.outpost_weewoo_ping_interval_minutes ?? 2} min\n` +
      `• Check Interval: ${outpostInterval} min\n` +
      `• Alerts Channel: ${outpostAlert}\n` +
      `• Dashboard Channel: ${outpostChan}\n\n` +
      `**Shard Tracker**\n` +
      `• Status: ${shardStatus}\n` +
      `• Interval: ${shardInterval} min\n` +
      `• Channel: ${shardChan}\n` +
      `• Checker Alt: ${shardCheckerAlt ? `**${shardCheckerAlt.label}** (#${shardCheckerAlt.id})` : '*not assigned — set in Alt Manager*'}\n\n` +
      `**Rpost Shard Tracker**\n` +
      `• Status: ${rpostStatus}\n` +
      `• Interval: ${rpostInterval} min\n` +
      `• Channel: ${rpostChan}\n` +
      `• Checker Alt: ${rpostCheckerAlt ? `**${rpostCheckerAlt.label}** (#${rpostCheckerAlt.id})` : '*not assigned — set in Alt Manager*'}\n\n` +
      `**Alt Manager**\n` +
      `• Dashboard Channel: ${altMgrChan}`
    )
    .setColor(0x5865F2)
    .setFooter({ text: `Guild: ${guild.name}` })
    .setTimestamp(new Date());

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.BTN_BUFFER_MENU).setLabel('Buffer Checks Config').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(IDS.BTN_OUTPOST_MENU).setLabel('Raiding Outpost Config').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(IDS.BTN_SHARD_MENU).setLabel('Shard Tracker Config').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(IDS.BTN_RPOST_MENU).setLabel('Rpost Shard Config').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(IDS.BTN_ALTMGR_MENU).setLabel('Alt Manager Config').setStyle(ButtonStyle.Primary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.BTN_REFRESH).setLabel('Refresh').setStyle(ButtonStyle.Secondary),
  );

  return { embed, components: [row, row2] };
}

async function buildBufferSubmenu() {
  const embed = new EmbedBuilder()
    .setTitle('⚙️ Buffer Checks Configuration')
    .setDescription('Configure all Buffer/Wall/Weewoo related settings. Choose an option below.')
    .setColor(0x5865F2);

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.BTN_RAID_CHAN).setLabel('Raid Alerts Channel').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(IDS.BTN_WALL_CHANNEL).setLabel('Wall Check Channel').setStyle(ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.BTN_INTERVAL_WEEWOO).setLabel('Weewoo Ping Interval').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(IDS.BTN_INTERVAL_WALLS).setLabel('Wall Check Interval').setStyle(ButtonStyle.Secondary),
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.BTN_START_WEEWOO).setLabel('Start Alerts').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(IDS.BTN_STOP_WEEWOO).setLabel('Stop Alerts').setStyle(ButtonStyle.Danger),
  );

  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.BTN_RESET_WALLS).setLabel('Reset Wall Checks').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(IDS.BACK).setLabel('Back').setStyle(ButtonStyle.Secondary),
  );

  return { embed, components: [row1, row2, row3, row4] };
}

async function buildOutpostSubmenu() {
  const embed = new EmbedBuilder()
    .setTitle('⚙️ Raiding Outpost Configuration')
    .setDescription('Configure Outpost status checks & alerts.')
    .setColor(0x5865F2);

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.BTN_OUTPOST_ALERT_CHAN).setLabel('Outpost Alerts Channel').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(IDS.BTN_OUTPOST_CHANNEL).setLabel('Outpost Check Channel').setStyle(ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.BTN_OUTPOST_INTERVAL_WEEWOO).setLabel('Outpost Weewoo Ping Interval').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(IDS.BTN_OUTPOST_INTERVAL).setLabel('Outpost Check Interval').setStyle(ButtonStyle.Secondary),
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.BTN_OUTPOST_START).setLabel('Start Alerts').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(IDS.BTN_OUTPOST_STOP).setLabel('Stop Alerts').setStyle(ButtonStyle.Danger),
  );

  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.BTN_RESET_OUTPOST).setLabel('Reset Outpost Checks').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(IDS.BACK).setLabel('Back').setStyle(ButtonStyle.Secondary),
  );

  return { embed, components: [row1, row2, row3, row4] };
}

async function buildShardSubmenu() {
  const embed = new EmbedBuilder()
    .setTitle('⚙️ Shard Tracker Configuration')
    .setDescription('Configure shard checking — channel, interval, and on/off.')
    .setColor(0x5865F2);

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.BTN_SHARD_CHANNEL).setLabel('Shard Check Channel').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(IDS.BTN_SHARD_INTERVAL).setLabel('Shard Check Interval').setStyle(ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.BTN_SHARD_START).setLabel('Enable Shard Checks').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(IDS.BTN_SHARD_STOP).setLabel('Disable Shard Checks').setStyle(ButtonStyle.Danger),
  );
  const rowBack = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.BACK).setLabel('Back').setStyle(ButtonStyle.Secondary),
  );

  return { embed, components: [row1, row2, rowBack] };
}

async function buildRpostShardSubmenu() {
  const embed = new EmbedBuilder()
    .setTitle('⚙️ Rpost Shard Tracker Configuration')
    .setDescription('Configure the **Rpost** shard tracker — channel, interval, and on/off.')
    .setColor(0x5865F2);

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.BTN_RPOST_CHANNEL).setLabel('Rpost Shard Channel').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(IDS.BTN_RPOST_INTERVAL).setLabel('Rpost Shard Interval').setStyle(ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.BTN_RPOST_START).setLabel('Enable Rpost Tracker').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(IDS.BTN_RPOST_STOP).setLabel('Disable Rpost Tracker').setStyle(ButtonStyle.Danger),
  );
  const rowBack = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.BACK).setLabel('Back').setStyle(ButtonStyle.Secondary),
  );

  return { embed, components: [row1, row2, rowBack] };
}

async function buildAltMgrSubmenu() {
  const embed = new EmbedBuilder()
    .setTitle('⚙️ Alt Manager Configuration')
    .setDescription('Pick the channel that will host the Alt Manager dashboard.')
    .setColor(0x5865F2);

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.BTN_ALTMGR_CHANNEL).setLabel('Alt Manager Channel').setStyle(ButtonStyle.Secondary),
  );
  const rowBack = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.BACK).setLabel('Back').setStyle(ButtonStyle.Secondary),
  );

  return { embed, components: [row1, rowBack] };
}

// =================== Channel listing (paged) ===================
async function fetchAllTextChannels(guild) {
  const all = await guild.channels.fetch().catch(() => null);
  if (!all) return [];
  return Array.from(all.values())
    .filter(ch =>
      ch && ch.type === ChannelType.GuildText &&
      ch.viewable &&
      !ch.isThread()
    )
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}

function buildPagedChannelSelectUI(targetKey, title, desc, channels, page = 0, pageSize = 25) {
  const totalPages = Math.max(1, Math.ceil(channels.length / pageSize));
  const clamped = Math.min(Math.max(0, page), totalPages - 1);
  const slice = channels.slice(clamped * pageSize, clamped * pageSize + pageSize);

  const embed = new EmbedBuilder()
    .setTitle(`⚙️ ${title}`)
    .setDescription(
      `${desc}\n\n` +
      `Page **${clamped + 1} / ${totalPages}** · ${channels.length} channels total.\n` +
      `Use the pager below to see more.\n\nPress **Back** to return.`
    )
    .setColor(0x5865F2);

  const options = slice.map(c =>
    new StringSelectMenuOptionBuilder().setLabel(`#${c.name}`).setValue(c.id)
  );

  const select = new StringSelectMenuBuilder()
    .setCustomId(`${channelPickCustomIdFor(targetKey)}:${clamped}`)
    .setPlaceholder('Select a channel…')
    .addOptions(options);

  const rowSelect = new ActionRowBuilder().addComponents(select);

  const rowPager = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${IDS.PAGE_PREV}:${targetKey}:${clamped}`)
      .setLabel('◀ Prev')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(clamped <= 0),
    new ButtonBuilder()
      .setCustomId(`${IDS.PAGE_NEXT}:${targetKey}:${clamped}`)
      .setLabel('Next ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(clamped >= totalPages - 1),
    new ButtonBuilder().setCustomId(IDS.BACK).setLabel('Back').setStyle(ButtonStyle.Secondary)
  );

  return { embed, components: [rowSelect, rowPager] };
}

function channelPickCustomIdFor(targetKey) {
  switch (targetKey) {
    case 'raid':           return IDS.PICK_RAID;
    case 'wall':           return IDS.PICK_WALL_CHANNEL;
    case 'outpost_alert':  return IDS.PICK_OUTPOST_ALERT;
    case 'outpost_dash':   return IDS.PICK_OUTPOST_CHANNEL;
    case 'shard':          return IDS.PICK_SHARD_CHANNEL;
    case 'rpost_shard':    return IDS.PICK_RPOST_CHANNEL;
    case 'altmgr':         return IDS.PICK_ALTMGR_CHANNEL;
    default:               return IDS.PICK_RAID;
  }
}

function targetKeyFromButtonId(buttonId) {
  switch (buttonId) {
    case IDS.BTN_RAID_CHAN:          return 'raid';
    case IDS.BTN_WALL_CHANNEL:       return 'wall';
    case IDS.BTN_OUTPOST_ALERT_CHAN: return 'outpost_alert';
    case IDS.BTN_OUTPOST_CHANNEL:    return 'outpost_dash';
    case IDS.BTN_SHARD_CHANNEL:      return 'shard';
    case IDS.BTN_RPOST_CHANNEL:      return 'rpost_shard';
    case IDS.BTN_ALTMGR_CHANNEL:     return 'altmgr';
    default:                         return null;
  }
}

function buildIntervalSelect(customId, title, desc, choices = [1,2,3,5,10,15,30,45,60]) {
  const embed = new EmbedBuilder().setTitle(`⚙️ ${title}`).setDescription(`${desc}\n\nPress **Back** to return.`).setColor(0x5865F2);

  const opts = choices.map(n =>
    new StringSelectMenuOptionBuilder().setLabel(`${n} minute${n === 1 ? '' : 's'}`).setValue(String(n))
  );

  const rowSelect = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder('Select interval…').addOptions(opts)
  );
  const rowBack = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.BACK).setLabel('Back').setStyle(ButtonStyle.Secondary)
  );

  return { embed, components: [rowSelect, rowBack] };
}

// =================== Panel entry ===================
// Robust: edit the same message on reload. If ID is missing/invalid, find the latest panel in channel.
async function ensureConfigPanel(guild) {
  // 1) Resolve (or create) the panel channel
  let gcfg = await getGuildConfig(guild.id).catch(() => null);
  let channel = null;

  if (gcfg?.config_panel_channel_id) {
    channel = await guild.channels.fetch(gcfg.config_panel_channel_id).catch(() => null);
  }
  if (!channel) {
    // Try to find by name first
    channel = guild.channels.cache.find(
      c => c.name === 'bot-configuration' && c.type === ChannelType.GuildText
    );
  }
  if (!channel) {
    // Create if still missing
    channel = await guild.channels.create({
      name: 'bot-configuration',
      type: ChannelType.GuildText,
      reason: 'Bot configuration panel'
    });
  }

  // Persist channel id if changed
  if (!gcfg?.config_panel_channel_id || gcfg.config_panel_channel_id !== channel.id) {
    try { await upsertGuildConfig({ guild_id: guild.id, config_panel_channel_id: channel.id }); } catch {}
    // refresh gcfg for later steps
    gcfg = await getGuildConfig(guild.id).catch(() => gcfg);
  }

  // 2) Build latest UI
  const { embed, components } = await buildMainEmbed(guild);

  // Helper: does this message look like OUR panel?
  const isOurPanel = (msg) => {
    if (!msg) return false;
    if (msg.author?.id !== guild.client.user.id) return false;
    const title = msg.embeds?.[0]?.title || '';
    return title === PANEL_TITLE;
  };

  // Try 3 ways to find the panel to edit:
  // A) Stored message id
  if (gcfg?.config_panel_message_id) {
    const existing = await channel.messages.fetch(gcfg.config_panel_message_id).catch(() => null);
    if (existing && isOurPanel(existing)) {
      try {
        await existing.edit({ embeds: [embed], components });
        return existing;
      } catch {}
    }
  }

  // B) Pinned messages
  try {
    const pinned = await channel.messages.fetchPinned().catch(() => null);
    if (pinned) {
      // Prefer most recent pinned panel by createdTimestamp
      const candidate = pinned
        .filter(isOurPanel)
        .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
        .first();
      if (candidate) {
        await candidate.edit({ embeds: [embed], components });
        try {
          await upsertGuildConfig({ guild_id: guild.id, config_panel_message_id: candidate.id });
        } catch {}
        return candidate;
      }
    }
  } catch {}

  // C) Recent history (fetch last ~50 messages)
  try {
    const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    if (recent) {
      const candidate = recent
        .filter(isOurPanel)
        .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
        .first();
      if (candidate) {
        await candidate.edit({ embeds: [embed], components });
        try {
          await upsertGuildConfig({ guild_id: guild.id, config_panel_message_id: candidate.id });
        } catch {}
        return candidate;
      }
    }
  } catch {}

  // 3) Send a new message and store its id (first-time or if the old one vanished)
  const sent = await channel.send({ embeds: [embed], components });
  try {
    await upsertGuildConfig({
      guild_id: guild.id,
      config_panel_channel_id: channel.id,
      config_panel_message_id: sent.id,
    });
  } catch {}
  return sent;
}

// =================== Interaction handler ===================
async function handleConfigInteraction(interaction) {
  const guild = interaction.guild;

  // BUTTONS
  if (interaction.isButton()) {
    // Paging buttons
    if (interaction.customId.startsWith(IDS.PAGE_PREV) || interaction.customId.startsWith(IDS.PAGE_NEXT)) {
      const [, targetKey, pageStr] = interaction.customId.split(':'); // e.g., cfg_page_next:shard:2
      const page = parseInt(pageStr || '0', 10);
      const delta = interaction.customId.startsWith(IDS.PAGE_NEXT) ? +1 : -1;

      const channels = await fetchAllTextChannels(guild);
      const target = CHANNEL_TARGETS[targetKey];
      if (!target) return false;

      const ui = buildPagedChannelSelectUI(targetKey, target.title, target.desc, channels, page + delta);
      await interaction.update({ embeds: [ui.embed], components: ui.components });
      return true;
    }

    // Main nav + open pickers
    switch (interaction.customId) {
      case IDS.BTN_BUFFER_MENU: {
        const view = await buildBufferSubmenu(guild);
        await interaction.update({ embeds: [view.embed], components: view.components });
        return true;
      }
      case IDS.BTN_OUTPOST_MENU: {
        const view = await buildOutpostSubmenu(guild);
        await interaction.update({ embeds: [view.embed], components: view.components });
        return true;
      }
      case IDS.BTN_SHARD_MENU: {
        const view = await buildShardSubmenu(guild);
        await interaction.update({ embeds: [view.embed], components: view.components });
        return true;
      }
      case IDS.BTN_RPOST_MENU: {
        const view = await buildRpostShardSubmenu(guild);
        await interaction.update({ embeds: [view.embed], components: view.components });
        return true;
      }
      case IDS.BTN_ALTMGR_MENU: {
        const view = await buildAltMgrSubmenu(guild);
        await interaction.update({ embeds: [view.embed], components: view.components });
        return true;
      }
      case IDS.BTN_REFRESH: {
        const view = await buildMainEmbed(guild);
        await interaction.update({ embeds: [view.embed], components: view.components });
        return true;
      }

      // Open channel pickers (paged)
      case IDS.BTN_RAID_CHAN:
      case IDS.BTN_WALL_CHANNEL:
      case IDS.BTN_OUTPOST_ALERT_CHAN:
      case IDS.BTN_OUTPOST_CHANNEL:
      case IDS.BTN_SHARD_CHANNEL:
      case IDS.BTN_RPOST_CHANNEL:
      case IDS.BTN_ALTMGR_CHANNEL: {
        const targetKey = targetKeyFromButtonId(interaction.customId);
        const target = CHANNEL_TARGETS[targetKey];
        const channels = await fetchAllTextChannels(guild);

        const ui = buildPagedChannelSelectUI(targetKey, target.title, target.desc, channels, 0);
        await interaction.update({ embeds: [ui.embed], components: ui.components });
        return true;
      }

      // --- Interval pickers ---
      case IDS.BTN_INTERVAL_WEEWOO: {
        const ui = buildIntervalSelect(
          IDS.PICK_INTERVAL_WEEWOO,
          'Weewoo Ping Interval',
          'How often to ping while WEEWOO is active.'
        );
        await interaction.update({ embeds: [ui.embed], components: ui.components });
        return true;
      }
      case IDS.BTN_INTERVAL_WALLS: {
        const ui = buildIntervalSelect(
          IDS.PICK_INTERVAL_WALLS,
          'Wall/Buffer Check Interval',
          'How often members should report wall/buffer checks.'
        );
        await interaction.update({ embeds: [ui.embed], components: ui.components });
        return true;
      }
      case IDS.BTN_OUTPOST_INTERVAL_WEEWOO: {
        const ui = buildIntervalSelect(
          IDS.PICK_OUTPOST_INTERVAL_WEEWOO,
          'Outpost Weewoo Ping Interval',
          'How often to ping while Outpost WEEWOO is active.'
        );
        await interaction.update({ embeds: [ui.embed], components: ui.components });
        return true;
      }
      case IDS.BTN_OUTPOST_INTERVAL: {
        const ui = buildIntervalSelect(
          IDS.PICK_OUTPOST_INTERVAL,
          'Outpost Check Interval',
          'How often members should report outpost checks.'
        );
        await interaction.update({ embeds: [ui.embed], components: ui.components });
        return true;
      }
      case IDS.BTN_SHARD_INTERVAL: {
        const ui = buildIntervalSelect(
          IDS.PICK_SHARD_INTERVAL,
          'Shard Tracker Interval',
          'How often the Shard Tracker should update.'
        );
        await interaction.update({ embeds: [ui.embed], components: ui.components });
        return true;
      }
      case IDS.BTN_RPOST_INTERVAL: {
        const ui = buildIntervalSelect(
          IDS.PICK_RPOST_INTERVAL,
          'Rpost Shard Tracker Interval',
          'How often the Rpost Shard Tracker should update.'
        );
        await interaction.update({ embeds: [ui.embed], components: ui.components });
        return true;
      }

      // Enable/disable etc
      case IDS.BTN_START_WEEWOO: {
        await upsertGuildConfig({ guild_id: guild.id, base_alerts_paused: 0, weewoo_active: 1, weewoo_last_ping_at: 0 });
        const gcfg = await getGuildConfig(guild.id);
        if (gcfg?.raid_alerts_channel_id) {
          const chan = await guild.channels.fetch(gcfg.raid_alerts_channel_id).catch(() => null);
          if (chan) await chan.send(`🔔 Base alert pings **resumed** via config.`);
        }
        const sub = await buildBufferSubmenu(guild);
        await interaction.update({ embeds: [sub.embed], components: sub.components });
        return true;
      }
      case IDS.BTN_STOP_WEEWOO: {
        await upsertGuildConfig({ guild_id: guild.id, base_alerts_paused: 1, weewoo_active: 0 });
        const gcfg = await getGuildConfig(guild.id);
        if (gcfg?.raid_alerts_channel_id) {
          const chan = await guild.channels.fetch(gcfg.raid_alerts_channel_id).catch(() => null);
          if (chan) await chan.send(`⏸️ Base alerts **paused** via config (no overdue or weewoo pings).`);
        }
        const sub = await buildBufferSubmenu(guild);
        await interaction.update({ embeds: [sub.embed], components: sub.components });
        return true;
      }
      case IDS.BTN_RESET_WALLS: {
        await resetWallChecks(guild.id);
        await upsertConfig({ guild_id: guild.id, last_notified_at: 0 });
        const sub = await buildBufferSubmenu(guild);
        await interaction.update({ embeds: [sub.embed], components: sub.components });
        return true;
      }

      case IDS.BTN_OUTPOST_START: {
        await upsertGuildConfig({ guild_id: guild.id, outpost_alerts_paused: 0, outpost_weewoo_active: 1, outpost_weewoo_last_ping_at: 0 });
        const gcfg = await getGuildConfig(guild.id);
        if (gcfg?.outpost_alerts_channel_id) {
          const chan = await guild.channels.fetch(gcfg.outpost_alerts_channel_id).catch(() => null);
          if (chan) await chan.send(`🔔 Outpost alert pings **resumed** via config.`);
        }
        const sub = await buildOutpostSubmenu(guild);
        await interaction.update({ embeds: [sub.embed], components: sub.components });
        return true;
      }
      case IDS.BTN_OUTPOST_STOP: {
        await upsertGuildConfig({ guild_id: guild.id, outpost_alerts_paused: 1, outpost_weewoo_active: 0 });
        const gcfg = await getGuildConfig(guild.id);
        if (gcfg?.outpost_alerts_channel_id) {
          const chan = await guild.channels.fetch(gcfg.outpost_alerts_channel_id).catch(() => null);
          if (chan) await chan.send(`⏸️ Outpost alerts **paused** via config (no overdue or weewoo pings).`);
        }
        const sub = await buildOutpostSubmenu(guild);
        await interaction.update({ embeds: [sub.embed], components: sub.components });
        return true;
      }
      case IDS.BTN_RESET_OUTPOST: {
        await resetOutpostChecks(guild.id);
        await upsertOutpostConfig({ guild_id: guild.id, last_notified_at: 0 });
        const sub = await buildOutpostSubmenu(guild);
        await interaction.update({ embeds: [sub.embed], components: sub.components });
        return true;
      }

      case IDS.BTN_SHARD_START: {
        await upsertShardConfig({ guild_id: guild.id, enabled: 1, last_run_at: 0 });
        // NEW: make sure the assigned Shard Checker alt is online
        const gcfg = await getGuildConfig(guild.id);
        const altId = Number(gcfg?.shard_checker_alt_id || 0);
        if (altId) {
          try { await AltRunner.loginAlt(altId); } catch (e) { console.warn('[config] shard start loginAlt:', e.message); }
        }
        const view = await buildShardSubmenu(guild);
        await interaction.update({ embeds: [view.embed], components: view.components });
        return true;
      }
      case IDS.BTN_SHARD_STOP: {
        await upsertShardConfig({ guild_id: guild.id, enabled: 0 });
        const view = await buildShardSubmenu(guild);
        await interaction.update({ embeds: [view.embed], components: view.components });
        return true;
      }

      case IDS.BTN_RPOST_START: {
        await upsertRpostShardConfig({ guild_id: guild.id, enabled: 1, last_run_at: 0 });
        // NEW: make sure the assigned Rpost Checker alt is online
        const gcfg = await getGuildConfig(guild.id);
        const altId = Number(gcfg?.rpost_checker_alt_id || 0);
        if (altId) {
          try { await AltRunner.loginAlt(altId); } catch (e) { console.warn('[config] rpost start loginAlt:', e.message); }
        }
        const view = await buildRpostShardSubmenu(guild);
        await interaction.update({ embeds: [view.embed], components: view.components });
        return true;
      }
      case IDS.BTN_RPOST_STOP: {
        await upsertRpostShardConfig({ guild_id: guild.id, enabled: 0 });
        const view = await buildRpostShardSubmenu(guild);
        await interaction.update({ embeds: [view.embed], components: view.components });
        return true;
      }

      case IDS.BACK: {
        const view = await buildMainEmbed(guild);
        await interaction.update({ embeds: [view.embed], components: view.components });
        return true;
      }
    }
    return false;
  }

  // STRING SELECTS (Intervals + Channel pickers)
  if (interaction.isStringSelectMenu()) {
    const id = interaction.customId;

    // Intervals
    if (id === IDS.PICK_INTERVAL_WEEWOO) {
      const minutes = parseInt(interaction.values?.[0] || '2', 10);
      await upsertGuildConfig({ guild_id: guild.id, weewoo_ping_interval_minutes: minutes });
      const sub = await buildBufferSubmenu(guild);
      await interaction.update({ embeds: [sub.embed], components: sub.components });
      return true;
    }
    if (id === IDS.PICK_INTERVAL_WALLS) {
      const minutes = parseInt(interaction.values?.[0] || '30', 10);
      await upsertConfig({ guild_id: guild.id, interval_minutes: minutes });
      const sub = await buildBufferSubmenu(guild);
      await interaction.update({ embeds: [sub.embed], components: sub.components });
      return true;
    }
    if (id === IDS.PICK_OUTPOST_INTERVAL_WEEWOO) {
      const minutes = parseInt(interaction.values?.[0] || '2', 10);
      await upsertGuildConfig({ guild_id: guild.id, outpost_weewoo_ping_interval_minutes: minutes });
      const sub = await buildOutpostSubmenu(guild);
      await interaction.update({ embeds: [sub.embed], components: sub.components });
      return true;
    }
    if (id === IDS.PICK_OUTPOST_INTERVAL) {
      const minutes = parseInt(interaction.values?.[0] || '30', 10);
      await upsertOutpostConfig({ guild_id: guild.id, interval_minutes: minutes });
      const sub = await buildOutpostSubmenu(guild);
      await interaction.update({ embeds: [sub.embed], components: sub.components });
      return true;
    }
    if (id === IDS.PICK_SHARD_INTERVAL) {
      const minutes = parseInt(interaction.values?.[0] || '5', 10);
      await upsertShardConfig({ guild_id: guild.id, interval_minutes: minutes });
      const sub = await buildShardSubmenu(guild);
      await interaction.update({ embeds: [sub.embed], components: sub.components });
      return true;
    }
    if (id === IDS.PICK_RPOST_INTERVAL) {
      const minutes = parseInt(interaction.values?.[0] || '5', 10);
      await upsertRpostShardConfig({ guild_id: guild.id, interval_minutes: minutes });
      const sub = await buildRpostSubmenu(guild);
      await interaction.update({ embeds: [sub.embed], components: sub.components });
      return true;
    }

    // Channel pickers (paged select)
    if (
      id.startsWith(IDS.PICK_RAID) ||
      id.startsWith(IDS.PICK_WALL_CHANNEL) ||
      id.startsWith(IDS.PICK_OUTPOST_ALERT) ||
      id.startsWith(IDS.PICK_OUTPOST_CHANNEL) ||
      id.startsWith(IDS.PICK_SHARD_CHANNEL) ||
      id.startsWith(IDS.PICK_RPOST_CHANNEL) ||
      id.startsWith(IDS.PICK_ALTMGR_CHANNEL)
    ) {
      const [firstVal] = interaction.values || [];
      if (!firstVal) {
        await interaction.reply({ content: 'No channel selected.', ephemeral: true });
        return true;
      }

      const [base] = id.split(':');
      const targetKey =
        base === IDS.PICK_RAID ? 'raid' :
        base === IDS.PICK_WALL_CHANNEL ? 'wall' :
        base === IDS.PICK_OUTPOST_ALERT ? 'outpost_alert' :
        base === IDS.PICK_OUTPOST_CHANNEL ? 'outpost_dash' :
        base === IDS.PICK_SHARD_CHANNEL ? 'shard' :
        base === IDS.PICK_RPOST_CHANNEL ? 'rpost_shard' :
        base === IDS.PICK_ALTMGR_CHANNEL ? 'altmgr' : null;

      if (!targetKey) return false;
      const target = CHANNEL_TARGETS[targetKey];
      await target.apply(guild, firstVal);

      const view = await target.onDone(guild);
      await interaction.update({ embeds: [view.embed], components: view.components });
      return true;
    }

    return false;
  }

  return false;
}

module.exports = {
  ensureConfigPanel,
  handleConfigInteraction,
};
