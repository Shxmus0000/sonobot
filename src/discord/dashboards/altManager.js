// ========================================
// File: src/discord/dashboards/altManager.js
// Uses device-code Microsoft auth (no password). No UUID/dup checks here.
// ========================================
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const {
  getAltManagerConfig, upsertAltManagerConfig,
  listAlts, getAltById, insertAlt, updateAlt, deleteAlt,
  decryptAltRowSecrets,
  getGuildConfig, upsertGuildConfig,
  setAltIdentity,
} = require('../../database/db');

const AltRunner = require('../alts/altRunner');

const ALT_IDS = {
  BTN_ADD: 'alt_btn_add',
  BTN_CONTROL: 'alt_btn_control',
  BTN_EDIT: 'alt_btn_edit',
  BTN_REMOVE: 'alt_btn_remove',
  BTN_REFRESH: 'alt_btn_refresh',

  BACK_MAIN: 'alt_back_main',

  SELECT_EDIT: 'alt_select_edit',
  SELECT_CONTROL: 'alt_select_control',
  SELECT_REMOVE: 'alt_select_remove',

  SUBMIT_EDIT_SELECTED: 'alt_submit_edit_selected',
  SUBMIT_CONTROL_SELECTED: 'alt_submit_control_selected',
  SUBMIT_REMOVE_SELECTED: 'alt_submit_remove_selected',

  OPEN_EDIT_DETAILS: 'alt_open_edit_details',

  CTRL_LOGIN: 'alt_ctrl_login',
  CTRL_LOGOUT: 'alt_ctrl_logout',
  CTRL_SENDCMD: 'alt_ctrl_sendcmd',
  CTRL_SWITCH_MS: 'alt_ctrl_switch_ms',
  CTRL_SET_SHARD: 'alt_ctrl_set_shard',
  CTRL_SET_RPOST: 'alt_ctrl_set_rpost',

  EDIT_SET_MS: 'alt_edit_set_ms',
  EDIT_SET_OFF: 'alt_edit_set_off',

  MODAL_ADD: 'alt_modal_add',
  MODAL_EDIT: 'alt_modal_edit',
  MODAL_CONTROL_CMD: 'alt_modal_cmd',
};

async function ensureAltManagerDashboard(guild, channelId) {
  const alts = await listAlts(guild.id);
  const guildCfg = await getGuildConfig(guild.id).catch(() => null);
  const { embed, components } = buildMainView(guild, alts, guildCfg);

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel) throw new Error('Alt Manager channel not found');

  const cfg = await getAltManagerConfig(guild.id);
  if (cfg?.dashboard_message_id) {
    try {
      const msg = await channel.messages.fetch(cfg.dashboard_message_id);
      await msg.edit({ embeds: [embed], components });
      return msg;
    } catch {}
  }
  const sent = await channel.send({ embeds: [embed], components });
  await upsertAltManagerConfig({ guild_id: guild.id, dashboard_message_id: sent.id });
  return sent;
}

async function handleAltInteraction(interaction) {
  const id = interaction.customId || '';
  const isOurs =
    id.startsWith('alt_btn_') ||
    id.startsWith('alt_select_') ||
    id.startsWith('alt_submit_') ||
    id.startsWith('alt_open_') ||
    id.startsWith('alt_ctrl_') ||
    id.startsWith('alt_edit_set_') ||
    id.startsWith('alt_modal_') ||
    id === ALT_IDS.BACK_MAIN;
  if (!isOurs) return false;

  const guild = interaction.guild;
  if (!guild) return false;

  // Buttons
  if (interaction.isButton()) {
    if (id === ALT_IDS.BTN_REFRESH) {
      const cfg = await getAltManagerConfig(guild.id);
      if (!cfg?.channel_id) {
        await interaction.reply({ content: 'Alt Manager channel not set in config panel.', flags: 64 });
        return true;
      }
      await ensureAltManagerDashboard(guild, cfg.channel_id);
      const alts = await listAlts(guild.id);
      const guildCfg = await getGuildConfig(guild.id).catch(() => null);
      const { embed, components } = buildMainView(guild, alts, guildCfg);
      await interaction.update({ embeds: [embed], components });
      return true;
    }

    if (id === ALT_IDS.BTN_ADD) {
      const modal = new ModalBuilder()
        .setCustomId(ALT_IDS.MODAL_ADD)
        .setTitle('Add Alt');

      const label = new TextInputBuilder()
        .setCustomId('label')
        .setLabel('Label (expected IGN)')
        .setPlaceholder('IGN you expect this alt to use')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const mode = new TextInputBuilder()
        .setCustomId('auth_mode')
        .setLabel('Auth Mode (offline/microsoft)')
        .setPlaceholder("Type 'microsoft' for device-code login")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue('microsoft');

      const user = new TextInputBuilder()
        .setCustomId('user')
        .setLabel('Microsoft email (optional)')
        .setPlaceholder('Shown as a hint during device login')
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

      const pass = new TextInputBuilder()
        .setCustomId('pass')
        .setLabel('Password (ignored for microsoft)')
        .setPlaceholder('Ignored; device-code is used')
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

      const mcuser = new TextInputBuilder()
        .setCustomId('mc_username')
        .setLabel('MC Username (offline only)')
        .setPlaceholder('Offline mode only')
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

      modal.addComponents(
        new ActionRowBuilder().addComponents(label),
        new ActionRowBuilder().addComponents(mode),
        new ActionRowBuilder().addComponents(user),
        new ActionRowBuilder().addComponents(pass),
        new ActionRowBuilder().addComponents(mcuser),
      );

      try { await interaction.showModal(modal); } catch {}
      return true;
    }

    if (id === ALT_IDS.BTN_EDIT) {
      const alts = await listAlts(guild.id);
      const view = buildSelectView('Edit Alt — pick one to edit', ALT_IDS.SELECT_EDIT, alts, true);
      await interaction.update(view);
      return true;
    }

    if (id === ALT_IDS.BTN_CONTROL) {
      const alts = await listAlts(guild.id);
      const view = buildSelectView('Control Alt — pick one', ALT_IDS.SELECT_CONTROL, alts, true);
      await interaction.update(view);
      return true;
    }

    if (id === ALT_IDS.BTN_REMOVE) {
      const alts = await listAlts(guild.id);
      const view = buildSelectView('Remove Alt — pick one', ALT_IDS.SELECT_REMOVE, alts, true);
      await interaction.update(view);
      return true;
    }

    if (id === ALT_IDS.BACK_MAIN) {
      const alts = await listAlts(guild.id);
      const guildCfg = await getGuildConfig(guild.id).catch(() => null);
      const { embed, components } = buildMainView(guild, alts, guildCfg);
      await interaction.update({ embeds: [embed], components });
      return true;
    }

    if (id.startsWith(ALT_IDS.SUBMIT_EDIT_SELECTED)) {
      const altId = getSuffixInt(id);
      const alt = await getAltById(altId);
      if (!alt || alt.guild_id !== guild.id) {
        await interaction.reply({ content: 'Alt not found.', flags: 64 });
        return true;
      }
      const view = buildEditActionsView(alt);
      await interaction.update(view);
      return true;
    }

    if (id.startsWith(ALT_IDS.SUBMIT_CONTROL_SELECTED)) {
      const altId = getSuffixInt(id);
      const alt = await getAltById(altId);
      if (!alt || alt.guild_id !== guild.id) {
        await interaction.reply({ content: 'Alt not found.', flags: 64 });
        return true;
      }
      const guildCfg = await getGuildConfig(guild.id).catch(() => null);
      const view = buildControlActionsView(alt, guildCfg);
      await interaction.update(view);
      return true;
    }

    if (id.startsWith(ALT_IDS.SUBMIT_REMOVE_SELECTED)) {
      const altId = getSuffixInt(id);
      const alt = await getAltById(altId);
      if (!alt || alt.guild_id !== guild.id) {
        await interaction.reply({ content: 'Alt not found.', flags: 64 });
        return true;
      }

      // If assigned as a checker, clear it
      const cfg = await getGuildConfig(guild.id).catch(() => null);
      const updates = { guild_id: guild.id };
      let needsUpdate = false;
      if (Number(cfg?.shard_checker_alt_id || 0) === altId) { updates.shard_checker_alt_id = 0; needsUpdate = true; }
      if (Number(cfg?.rpost_checker_alt_id || 0) === altId) { updates.rpost_checker_alt_id = 0; needsUpdate = true; }
      if (needsUpdate) { try { await upsertGuildConfig(updates); } catch {} }

      await deleteAlt(altId);
      await AltRunner.logoutAlt(altId);

      const alts = await listAlts(guild.id);
      const guildCfg = await getGuildConfig(guild.id).catch(() => null);
      const { embed, components } = buildMainView(guild, alts, guildCfg);
      await interaction.update({ embeds: [embed], components });
      await interaction.followUp({ content: `🗑️ Removed alt **${alt.label}**.`, flags: 64 });
      return true;
    }

    if (id.startsWith(ALT_IDS.CTRL_LOGIN)) {
      const altId = getSuffixInt(id);
      const alt = await getAltById(altId);
      if (!alt || alt.guild_id !== guild.id) {
        await interaction.reply({ content: 'Alt not found.', flags: 64 });
        return true;
      }
      try {
        await AltRunner.loginAlt(altId);
        await interaction.reply({ content: `🔌 Logging in **${alt.label}**… If sign-in is needed, I’ll post a device code here.`, flags: 64 });
      } catch (e) {
        await interaction.reply({ content: `Login failed: ${e.message}`, flags: 64 });
      }
      const guildCfg = await getGuildConfig(guild.id).catch(() => null);
      const view = buildControlActionsView(alt, guildCfg);
      await interaction.message.edit(view);
      return true;
    }

    if (id.startsWith(ALT_IDS.CTRL_LOGOUT)) {
      const altId = getSuffixInt(id);
      const alt = await getAltById(altId);
      if (!alt || alt.guild_id !== guild.id) {
        await interaction.reply({ content: 'Alt not found.', flags: 64 });
        return true;
      }
      try {
        await AltRunner.logoutAlt(altId);
        await interaction.reply({ content: `🔌 Logged out **${alt.label}**.`, flags: 64 });
      } catch (e) {
        await interaction.reply({ content: `Logout failed: ${e.message}`, flags: 64 });
      }
      const guildCfg = await getGuildConfig(guild.id).catch(() => null);
      const view = buildControlActionsView(alt, guildCfg);
      await interaction.message.edit(view);
      return true;
    }

    if (id.startsWith(ALT_IDS.CTRL_SENDCMD)) {
      const altId = getSuffixInt(id);
      const alt = await getAltById(altId);
      if (!alt || alt.guild_id !== guild.id) {
        await interaction.reply({ content: 'Alt not found.', flags: 64 });
        return true;
      }
      const modal = new ModalBuilder()
        .setCustomId(`${ALT_IDS.MODAL_CONTROL_CMD}:${altId}`)
        .setTitle(`Send Command — ${alt.label}`);

      const cmd = new TextInputBuilder()
        .setCustomId('command')
        .setLabel('Command to send')
        .setPlaceholder('e.g., /tpa Player')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(cmd));

      try { await interaction.showModal(modal); } catch {}
      return true;
    }

    if (id.startsWith(ALT_IDS.CTRL_SWITCH_MS)) {
      const altId = getSuffixInt(id);
      const alt = await getAltById(altId);
      if (!alt || alt.guild_id !== guild.id) {
        await interaction.reply({ content: 'Alt not found.', flags: 64 });
        return true;
      }
      try {
        await updateAlt({ id: altId, auth_mode: 'microsoft', mc_username: null });
        await AltRunner.forceWipeAltAuthCache(altId, { clearDb: true });
        await AltRunner.loginAlt(altId);
        await interaction.reply({ content: `🔁 Switched **${alt.label}** to **microsoft** (device-code) auth.`, flags: 64 });
      } catch (e) {
        await interaction.reply({ content: `Failed to switch: ${e.message}`, flags: 64 });
      }
      const fresh = await getAltById(altId);
      const guildCfg = await getGuildConfig(guild.id).catch(() => null);
      const view = buildControlActionsView(fresh || alt, guildCfg);
      await interaction.message.edit(view);
      return true;
    }

    // Assign checker
    if (id.startsWith(ALT_IDS.CTRL_SET_SHARD) || id.startsWith(ALT_IDS.CTRL_SET_RPOST)) {
      const altId = getSuffixInt(id);
      const alt = await getAltById(altId);
      if (!alt || alt.guild_id !== guild.id) {
        await interaction.reply({ content: 'Alt not found.', flags: 64 });
        return true;
      }

      const payload = { guild_id: guild.id };
      const which = id.startsWith(ALT_IDS.CTRL_SET_SHARD) ? 'shard' : 'rpost';
      if (which === 'shard') payload.shard_checker_alt_id = altId;
      else payload.rpost_checker_alt_id = altId;

      try {
        await upsertGuildConfig(payload);
        await interaction.reply({ content: `✅ Set **${alt.label}** as **${which === 'shard' ? 'Shard Checker' : 'Rpost Checker'}**.`, flags: 64 });

        const cfg = await getAltManagerConfig(guild.id);
        if (cfg?.channel_id) { try { await ensureAltManagerDashboard(guild, cfg.channel_id); } catch {} }

        const freshCfg = await getGuildConfig(guild.id).catch(() => null);
        const view = buildControlActionsView(alt, freshCfg);
        if (interaction.message?.editable) await interaction.message.edit(view);
      } catch (e) {
        await interaction.reply({ content: `Failed to assign: ${e.message}`, flags: 64 });
      }
      return true;
    }

    if (id.startsWith(ALT_IDS.OPEN_EDIT_DETAILS)) {
      const altId = getSuffixInt(id);
      const alt = await getAltById(altId);
      if (!alt || alt.guild_id !== guild.id) {
        await interaction.reply({ content: 'Alt not found.', flags: 64 });
        return true;
      }

      const modal = new ModalBuilder()
        .setCustomId(`${ALT_IDS.MODAL_EDIT}:${altId}`)
        .setTitle(`Edit Details — ${alt.label}`);

      const curEmail = new TextInputBuilder()
        .setCustomId('cur_email')
        .setLabel('Current email (if set)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

      const curPass = new TextInputBuilder()
        .setCustomId('cur_pass')
        .setLabel('Current password (if set)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

      const newEmail = new TextInputBuilder()
        .setCustomId('new_email')
        .setLabel('New email')
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

      const newPass = new TextInputBuilder()
        .setCustomId('new_pass')
        .setLabel('New password (ignored for microsoft)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

      const mcUser = new TextInputBuilder()
        .setCustomId('mc_username')
        .setLabel('MC Username (offline)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

      modal.addComponents(
        new ActionRowBuilder().addComponents(curEmail),
        new ActionRowBuilder().addComponents(curPass),
        new ActionRowBuilder().addComponents(newEmail),
        new ActionRowBuilder().addComponents(newPass),
        new ActionRowBuilder().addComponents(mcUser),
      );

      try { await interaction.showModal(modal); } catch {}
      return true;
    }

    if (id.startsWith(ALT_IDS.EDIT_SET_MS) || id.startsWith(ALT_IDS.EDIT_SET_OFF)) {
      const altId = getSuffixInt(id);
      const alt = await getAltById(altId);
      if (!alt || alt.guild_id !== guild.id) {
        await interaction.reply({ content: 'Alt not found.', flags: 64 });
        return true;
      }

      const targetMode = id.startsWith(ALT_IDS.EDIT_SET_MS) ? 'microsoft' : 'offline';

      try {
        await updateAlt({
          id: altId,
          auth_mode: targetMode,
          mc_username: targetMode === 'microsoft' ? null : (alt.mc_username || alt.label),
        });

        if (targetMode === 'microsoft') {
          await AltRunner.forceWipeAltAuthCache(altId, { clearDb: true });
        }

        await AltRunner.logoutAlt(altId).catch(() => {});
        await AltRunner.loginAlt(altId);

        await interaction.reply({ content: `✅ Switched **${alt.label}** auth to **${targetMode}**.`, flags: 64 });
      } catch (e) {
        await interaction.reply({ content: `Failed to switch auth: ${e.message}`, flags: 64 });
      }

      const fresh = await getAltById(altId);
      const view = buildEditActionsView(fresh || alt);
      if (interaction.message?.editable) {
        await interaction.message.edit(view);
      }
      return true;
    }

    return false;
  }

  // Select menus
  if (interaction.isStringSelectMenu()) {
    const selectedId = parseInt(interaction.values?.[0] || '0', 10);
    const alt = selectedId ? await getAltById(selectedId) : null;

    if (interaction.customId === ALT_IDS.SELECT_EDIT) {
      if (!alt) { await interaction.reply({ content: 'Pick an alt first.', flags: 64 }); return true; }
      const view = buildSelectedConfirmView('Edit Alt', alt, `${ALT_IDS.SUBMIT_EDIT_SELECTED}:${alt.id}`);
      await interaction.update(view);
      return true;
    }
    if (interaction.customId === ALT_IDS.SELECT_CONTROL) {
      if (!alt) { await interaction.reply({ content: 'Pick an alt first.', flags: 64 }); return true; }
      const guildCfg = await getGuildConfig(guild.id).catch(() => null);
      const view = buildControlActionsView(alt, guildCfg);
      await interaction.update(view);
      return true;
    }
    if (interaction.customId === ALT_IDS.SELECT_REMOVE) {
      if (!alt) { await interaction.reply({ content: 'Pick an alt first.', flags: 64 }); return true; }
      const view = buildSelectedConfirmView('Remove Alt', alt, `${ALT_IDS.SUBMIT_REMOVE_SELECTED}:${alt.id}`, 'Remove');
      await interaction.update(view);
      return true;
    }
    return false;
  }

  // Modals
  if (interaction.isModalSubmit()) {
    if (interaction.customId === ALT_IDS.MODAL_ADD) {
      await interaction.deferReply({ flags: 64 });

      const label = interaction.fields.getTextInputValue('label')?.trim();
      const auth_mode = interaction.fields.getTextInputValue('auth_mode')?.trim().toLowerCase();
      const user = interaction.fields.getTextInputValue('user')?.trim() || null;
      const pass = interaction.fields.getTextInputValue('pass')?.trim() || null;
      const mc_username = interaction.fields.getTextInputValue('mc_username')?.trim() || null;

      if (!label) { await interaction.editReply({ content: 'Label is required.' }); return true; }
      if (!['offline', 'microsoft'].includes(auth_mode)) {
        await interaction.editReply({ content: "Auth mode must be 'offline' or 'microsoft'." }); return true;
      }

      const payload = {
        guild_id: guild.id,
        label,
        auth_mode,
        mc_username: auth_mode === 'offline' ? (mc_username || user || null) : null,
        msa_label: auth_mode === 'microsoft' ? (label || null) : null,
        email_plain: auth_mode === 'microsoft' ? (user || null) : null,
        // we can store pass, but it is NOT used for microsoft device-code
        password_plain: auth_mode === 'microsoft' ? (pass || null) : null,
      };

      try {
        const id = await insertAlt(payload);
        const cfg = await getAltManagerConfig(guild.id);
        if (cfg?.channel_id) { try { await ensureAltManagerDashboard(guild, cfg.channel_id); } catch {} }
        try { await AltRunner.loginAlt(id); } catch (e) {
          await interaction.followUp?.({ content: `Added alt but login failed: ${e.message}`, flags: 64 }).catch(() => {});
        }
        await interaction.editReply({ content: `✅ Added **${label}**. If sign-in is needed, I’ll post a device code here.` });
      } catch (e) {
        await interaction.editReply({ content: `Failed to add alt: ${e.message}` });
      }
      return true;
    }

    if (interaction.customId.startsWith(ALT_IDS.MODAL_EDIT)) {
      await interaction.deferReply({ flags: 64 });

      const altId = getSuffixInt(interaction.customId);
      const alt = await getAltById(altId);
      if (!alt || alt.guild_id !== guild.id) {
        await interaction.editReply({ content: 'Alt not found.' });
        return true;
      }

      const cur_email = interaction.fields.getTextInputValue('cur_email')?.trim();
      const cur_pass  = interaction.fields.getTextInputValue('cur_pass')?.trim();
      const new_email = interaction.fields.getTextInputValue('new_email')?.trim() || null;
      const new_pass  = interaction.fields.getTextInputValue('new_pass')?.trim() || null;
      const mc_user   = interaction.fields.getTextInputValue('mc_username')?.trim() || null;

      const withSecrets = decryptAltRowSecrets(alt);
      const existingEmail = withSecrets.email_plain || null;
      const existingPass  = withSecrets.password_plain || null;

      if ((existingEmail && cur_email !== existingEmail) || (existingPass && cur_pass !== existingPass)) {
        await interaction.editReply({ content: 'Verification failed. Current email/password do not match.' });
        return true;
      }

      try {
        await updateAlt({
          id: altId,
          mc_username: mc_user !== null ? mc_user : undefined,
          email_plain: new_email !== null ? new_email : undefined,
          password_plain: new_pass !== null ? new_pass : undefined,
        });

        const credsChanged = (new_email !== null && new_email !== existingEmail) || (new_pass !== null && new_pass !== existingPass);
        if (credsChanged && (alt.auth_mode || 'microsoft') === 'microsoft') {
          await AltRunner.forceWipeAltAuthCache(altId, { clearDb: true });
          await setAltIdentity({ id: altId, mc_uuid: null, mc_last_username: null }).catch(() => {});
          await AltRunner.logoutAlt(altId).catch(() => {});
          await AltRunner.loginAlt(altId);
        }

        await interaction.editReply({ content: '✅ Alt details updated.' });

        const cfg = await getAltManagerConfig(guild.id);
        if (cfg?.channel_id) { try { await ensureAltManagerDashboard(guild, cfg.channel_id); } catch {} }
      } catch (e) {
        await interaction.editReply({ content: `Update failed: ${e.message}` });
      }
      return true;
    }

    if (interaction.customId.startsWith(ALT_IDS.MODAL_CONTROL_CMD)) {
      await interaction.deferReply({ flags: 64 });

      const altId = getSuffixInt(interaction.customId);
      const alt = await getAltById(altId);
      if (!alt || alt.guild_id !== guild.id) {
        await interaction.editReply({ content: 'Alt not found.' });
        return true;
      }
      const command = interaction.fields.getTextInputValue('command')?.trim();
      if (!command) {
        await interaction.editReply({ content: 'Please enter a command.' });
        return true;
      }

      try {
        await AltRunner.sendCommand(altId, command);
        await interaction.editReply({ content: `📨 Sent to **${alt.label}**: \`${command}\`` });
      } catch (e) {
        await interaction.editReply({ content: `Failed to send command: ${e.message}` });
      }
      return true;
    }

    return false;
  }

  return false;
}

// ---------- Views ----------
function buildMainView(guild, alts, guildCfg = null) {
  const shardId = Number(guildCfg?.shard_checker_alt_id || 0);
  const rpostId = Number(guildCfg?.rpost_checker_alt_id || 0);
  const shardAlt = shardId ? alts.find(a => a.id === shardId) : null;
  const rpostAlt = rpostId ? alts.find(a => a.id === rpostId) : null;

  const shardWorld = shardAlt ? (AltRunner.getAltWorld(shardAlt.id) || '—') : '—';
  const rpostWorld = rpostAlt ? (AltRunner.getAltWorld(rpostAlt.id) || '—') : '—';

  const assignmentLines = [
    `• Shard Checker: **${shardAlt ? shardAlt.label : '— not set —'}**${shardAlt ? ` · world: \`${shardWorld}\`` : ''}`,
    `• Rpost Checker: **${rpostAlt ? rpostAlt.label : '— not set —'}**${rpostAlt ? ` · world: \`${rpostWorld}\`` : ''}`,
  ].join('\n');

  // Show world for **every** alt in the list
  const list = alts.length
    ? alts.map(a => {
        const status = a.last_status ? `\`${a.last_status}\`` : '`unknown`';
        const seen = a.last_seen ? `<t:${a.last_seen}:R>` : '`never`';
        const mode = a.auth_mode || 'offline';
        const world = AltRunner.getAltWorld(a.id) || '—';
        return `• **${a.label}** — mode: \`${mode}\` · status: ${status} · last seen: ${seen} · world: \`${world}\``;
      }).join('\n')
    : '_No alts configured. Use **Add Alt** to create one._';

  const embed = new EmbedBuilder()
    .setTitle('🧪 Alt Manager')
    .setDescription(
      `**Assignments**\n${assignmentLines}\n\n` +
      `**Alts**\n${list}\n\n` +
      `Use the buttons to **Add**, **Control**, **Edit**, **Remove**, or **Refresh**.\n` +
      `_Microsoft alts use **device-code** sign-in; I’ll post the code + link here when needed._`
    )
    .setColor(0x2f3136);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(ALT_IDS.BTN_ADD).setLabel('Add Alt').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(ALT_IDS.BTN_CONTROL).setLabel('Control Alt').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(ALT_IDS.BTN_EDIT).setLabel('Edit Alt').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(ALT_IDS.BTN_REMOVE).setLabel('Remove Alt').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(ALT_IDS.BTN_REFRESH).setLabel('Refresh').setStyle(ButtonStyle.Secondary),
  );

  return { embed, components: [row] };
}

function buildSelectView(title, selectId, alts, withBack = false) {
  const embed = new EmbedBuilder()
    .setTitle(`🧪 Alt Manager — ${title}`)
    .setDescription('Pick an alt from the list below, then you will be prompted to continue.')
    .setColor(0x2f3136);

  const options = alts.length
    ? alts.map(a => new StringSelectMenuOptionBuilder().setLabel(a.label).setValue(String(a.id)))
    : [new StringSelectMenuOptionBuilder().setLabel('No alts available').setValue('0')];

  const select = new StringSelectMenuBuilder()
    .setCustomId(selectId)
    .setPlaceholder('Select an alt…')
    .addOptions(options)
    .setMinValues(1)
    .setMaxValues(1);

  const rows = [new ActionRowBuilder().addComponents(select)];
  if (withBack) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(ALT_IDS.BACK_MAIN).setLabel('Back').setStyle(ButtonStyle.Secondary),
    ));
  }
  return { embeds: [embed], components: rows };
}

function buildSelectedConfirmView(title, alt, submitCustomId, submitLabel = 'Submit') {
  const embed = new EmbedBuilder()
    .setTitle(`🧪 Alt Manager — ${title}`)
    .setDescription(`Selected: **${alt.label}**\nChoose what to do next.`)
    .setColor(0x2f3136);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(submitCustomId).setLabel(submitLabel).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(ALT_IDS.BACK_MAIN).setLabel('Back').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}

function buildControlActionsView(alt, guildCfg = null) {
  const status = alt.last_status ? `\`${alt.last_status}\`` : '`unknown`';
  const shardId = Number(guildCfg?.shard_checker_alt_id || 0);
  const rpostId = Number(guildCfg?.rpost_checker_alt_id || 0);

  const isShard = alt.id === shardId;
  const isRpost = alt.id === rpostId;
  const world = AltRunner.getAltWorld(alt.id) || '—';

  const assignedLine = [
    isShard ? '• Assigned: **Shard Checker**' : null,
    isRpost ? '• Assigned: **Rpost Checker**' : null,
  ].filter(Boolean).join('\n') || '• Not assigned as a checker';

  const embed = new EmbedBuilder()
    .setTitle(`🧪 Control Alt — ${alt.label}`)
    .setDescription(`Status: ${status}\nWorld: \`${world}\`\n${assignedLine}\n\nChoose an action:`)
    .setColor(0x2f3136);

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${ALT_IDS.CTRL_LOGIN}:${alt.id}`).setLabel('Login').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${ALT_IDS.CTRL_LOGOUT}:${alt.id}`).setLabel('Logout').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`${ALT_IDS.CTRL_SENDCMD}:${alt.id}`).setLabel('Send Command').setStyle(ButtonStyle.Primary),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${ALT_IDS.CTRL_SET_SHARD}:${alt.id}`)
      .setLabel(isShard ? 'Set as Shard Checker ✓' : 'Set as Shard Checker')
      .setStyle(isShard ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(isShard),
    new ButtonBuilder()
      .setCustomId(`${ALT_IDS.CTRL_SET_RPOST}:${alt.id}`)
      .setLabel(isRpost ? 'Set as Rpost Checker ✓' : 'Set as Rpost Checker')
      .setStyle(isRpost ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(isRpost),
    new ButtonBuilder().setCustomId(`${ALT_IDS.CTRL_SWITCH_MS}:${alt.id}`).setLabel('Switch to Microsoft Auth').setStyle(ButtonStyle.Secondary),
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(ALT_IDS.BACK_MAIN).setLabel('Back').setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row1, row2, row3] };
}

function buildEditActionsView(alt) {
  const mode = (alt.auth_mode || 'offline').toLowerCase();
  const isMs = mode === 'microsoft';

  const modeLine = `• Current auth mode: \`${mode}\``;
  const tips = isMs
    ? 'Microsoft alts use **device-code** flow (no password here).'
    : 'Offline mode uses the MC Username field only.';

  const embed = new EmbedBuilder()
    .setTitle(`🧪 Edit Alt — ${alt.label}`)
    .setDescription(`${modeLine}\n${tips}\n\nWhat would you like to edit?`)
    .setColor(0x2f3136);

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${ALT_IDS.EDIT_SET_MS}:${alt.id}`)
      .setLabel(isMs ? 'Microsoft Auth ✓' : 'Switch to Microsoft Auth')
      .setStyle(isMs ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(isMs),
    new ButtonBuilder()
      .setCustomId(`${ALT_IDS.EDIT_SET_OFF}:${alt.id}`)
      .setLabel(!isMs ? 'Offline Auth ✓' : 'Switch to Offline Auth')
      .setStyle(!isMs ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(!isMs),
    new ButtonBuilder()
      .setCustomId(`${ALT_IDS.OPEN_EDIT_DETAILS}:${alt.id}`)
      .setLabel('Edit Account Details')
      .setStyle(ButtonStyle.Primary),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(ALT_IDS.BACK_MAIN).setLabel('Back').setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row1, row2] };
}

// ---------- helpers ----------
function getSuffixInt(customId) {
  const parts = String(customId).split(':');
  const val = parts[1] ? parseInt(parts[1], 10) : NaN;
  return Number.isFinite(val) ? val : 0;
}

module.exports = {
  ensureAltManagerDashboard,
  handleAltManagerInteraction: handleAltInteraction,
  handleAltInteraction,
  ALT_IDS,
};
