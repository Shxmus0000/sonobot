// ========================================
// File: src/services/trackerCore.js
// Shared implementation used by shardTracker & rpostShardTracker
// ========================================
const { EmbedBuilder } = require('discord.js');
const { setTimeout: sleep } = require('timers/promises');
const AltRunner = require('../discord/alts/altRunner');

// ---------- knobs ----------
const TAB_COMPLETE_CMD = '/a ';
const MAX_LOOKUPS = 80;
const BETWEEN_LOOKUPS_MS = 250;
const LOOKUP_TIMEOUT_MS = 4500;
const FACTION_CACHE_TTL_MS = 10 * 60 * 1000;
const NO_FACTION_TAG = '__NO_FACTION__';
const EMBED_COLOR = 0x5865F2;
const STARTUP_DEBOUNCE_MS = 2000;
const BOT_WAIT_MS = 20000;

// ---------- in-memory guards ----------
const memoryLastRunMs = new Map();
const memoryPrevMsgId = new Map();

// in-memory faction cache (per-process, fine for our scale)
const factionCache = new Map();

const nowMs = () => Date.now();
const normalizePlayerName = (n) => String(n || '').trim();
const cacheKey = (n) => normalizePlayerName(n).toLowerCase();

function getCachedFaction(player) {
  const key = cacheKey(player);
  const hit = factionCache.get(key);
  if (!hit) return null;
  if (nowMs() - hit.at > FACTION_CACHE_TTL_MS) {
    factionCache.delete(key);
    return null;
  }
  return hit.faction;
}
function setCachedFaction(player, faction) {
  factionCache.set(cacheKey(player), { faction, at: nowMs() });
}

function waitForFactionHeaderOrNoFaction(mc, player, timeoutMs = LOOKUP_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let finished = false;
    const headerRe = /^\s*-{2,}\s*\[\s*(.+?)\s*\]\s*-{2,}\s*$/;
    const noFactionRe = /^✘\s+The\s+faction\s+"[^"]+"\s+does\s+not\s+exist\./i;

    const onString = (text) => {
      if (finished) return;
      const line = String(text || '').trim();
      if (!line) return;
      const m = headerRe.exec(line);
      if (m) { finished = true; cleanup(); return resolve(m[1]); }
      if (noFactionRe.test(line)) { finished = true; cleanup(); return resolve(NO_FACTION_TAG); }
    };

    const onMsg = (cm) => {
      if (finished) return;
      try {
        const line = (cm && typeof cm.toString === 'function') ? cm.toString().trim() : '';
        if (!line) return;
        const m = headerRe.exec(line);
        if (m) { finished = true; cleanup(); return resolve(m[1]); }
        if (noFactionRe.test(line)) { finished = true; cleanup(); return resolve(NO_FACTION_TAG); }
      } catch {}
    };

    const cleanup = () => {
      clearTimeout(timer);
      try { mc?.off?.('messagestr', onString); } catch {}
      try { mc?.off?.('message', onMsg); } catch {}
    };

    try { mc?.on?.('messagestr', onString); } catch {}
    try { mc?.on?.('message', onMsg); } catch {}

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true; cleanup(); resolve(null);
    }, timeoutMs);
  });
}

async function getFactionOfPlayer(mc, player) {
  const cached = getCachedFaction(player);
  if (cached) return cached;

  try { mc.chat(`/f who ${player}`); } catch { return null; }

  const result = await waitForFactionHeaderOrNoFaction(mc, player, LOOKUP_TIMEOUT_MS);
  if (result) setCachedFaction(player, result);
  return result;
}

function bulletsFor(names, maxLen = 1024) {
  if (!names?.length) return ['_None_'];
  const bullet = (n) => `• ${n}`;
  const chunks = [];
  let buf = '';
  for (const n of names) {
    const line = bullet(n);
    if ((buf ? buf.length + 1 : 0) + line.length > maxLen) {
      chunks.push(buf);
      buf = line;
    } else {
      buf = buf ? `${buf}\n${line}` : line;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

function addFactionFields(embed, grouped) {
  const entries = Array.from(grouped.entries())
    .sort((a, b) => (b[1].length - a[1].length) || a[0].localeCompare(b[0]));

  const MAX_FIELDS = 25;
  let used = 0;

  for (let i = 0; i < entries.length; i++) {
    const [faction, members] = entries[i];
    const parts = bulletsFor(members, 1024);
    for (let j = 0; j < parts.length; j++) {
      const fname = j === 0 ? `${faction} (${members.length})` : `${faction} (cont.)`;
      embed.addFields({ name: fname, value: parts[j] });
      used++;
      if (used >= MAX_FIELDS) return used;
    }
  }
  return used;
}

/**
 * Shared runner
 * @param {Discord.Client} client
 * @param {string} guildId
 * @param {'shard'|'rpost'} kind
 * @param {object} db  { getConfig, upsertConfig, getGuildConfig }
 * @param {object} ui  { titlePrefix, footerText, altField: 'shard_checker_alt_id' | 'rpost_checker_alt_id' }
 */
async function runOnceForGuild(client, guildId, kind, db, ui) {
  const startedAtMs = nowMs();
  const startedAtSec = Math.floor(startedAtMs / 1000);

  // In-process startup guard
  const prevLocal = memoryLastRunMs.get(`${kind}:${guildId}`) || 0;
  if (startedAtMs - prevLocal < STARTUP_DEBOUNCE_MS) return;
  memoryLastRunMs.set(`${kind}:${guildId}`, startedAtMs);

  const scfg = await db.getConfig(guildId);
  if (!scfg?.enabled || !scfg?.channel_id) return;

  // Interval guard (read from DB)
  const intervalMin = Number(scfg.interval_minutes) > 0 ? Number(scfg.interval_minutes) : 5;
  const nextAllowedSec = Number(scfg.last_run_at || 0) + intervalMin * 60;
  if (startedAtSec < nextAllowedSec) return;

  // Claim the interval early so we don't double-run if the check takes long
  await db.upsertConfig({ guild_id: guildId, last_run_at: startedAtSec }).catch(() => {});

  // Resolve assigned checker alt & make sure it's online + at /home
  const gcfg = await db.getGuildConfig(guildId);
  const checkerAltId = Number(gcfg?.[ui.altField] || 0);
  if (!checkerAltId) return;

  let mc = AltRunner.getBot(checkerAltId);
  if (!mc || !mc.chat || !mc.tabComplete) {
    try { await AltRunner.loginAlt(checkerAltId); } catch {}
    mc = await AltRunner.waitForOnline(checkerAltId, BOT_WAIT_MS);
  }
  if (!mc || !mc.chat || !mc.tabComplete) {
    console.warn(`[${kind.toUpperCase()} Tracker] Alt ${checkerAltId} not connected; skipping this run.`);
    return;
  }

  // Ensure we're on the right shard & at home before querying names
  try { await AltRunner.ensureHomeForAlt(checkerAltId); } catch {}

  // Discord channel
  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;

  const channel =
    guild.channels.cache.get(scfg.channel_id) ||
    (await guild.channels.fetch(scfg.channel_id).catch(() => null));
  if (!channel) return;

  // 1) Player names via tab-complete
  let names = [];
  try {
    const completions = await mc.tabComplete(TAB_COMPLETE_CMD, true, false, 5000);
    names = (completions || [])
      .map((c) => (c?.match || '').trim())
      .filter((name) => /^[a-zA-Z0-9_]{3,16}$/.test(name));
  } catch (e) {
    console.warn(`[${kind.toUpperCase()} Tracker] tabComplete failed:`, e?.message || e);
  }
  const uniqueNames = Array.from(new Set(names)).slice(0, MAX_LOOKUPS);

  // 2) Faction lookups
  const byFaction = new Map();
  const noFaction = [];

  for (const p of uniqueNames) {
    const display = normalizePlayerName(p);
    const result = await getFactionOfPlayer(mc, p);

    if (result === NO_FACTION_TAG) {
      noFaction.push(display);
    } else if (typeof result === 'string' && result.length) {
      const arr = byFaction.get(result) || [];
      arr.push(display);
      byFaction.set(result, arr);
    }
    await sleep(BETWEEN_LOOKUPS_MS);
  }

  // 3) Build embed (title includes world/shard)
  const world = AltRunner.getAltWorld(checkerAltId) || 'Unknown';
  const totalPlayers = uniqueNames.length;
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(`${ui.titlePrefix} - ${totalPlayers} Player${totalPlayers === 1 ? '' : 's'} in ${world}`)
    .setTimestamp(new Date())
    .setFooter({ text: ui.footerText });

  const usedFields = addFactionFields(embed, byFaction);
  if (noFaction.length && usedFields < 25) {
    const parts = bulletsFor(noFaction, 1024);
    embed.addFields({ name: 'No Faction', value: parts[0] });
    for (let i = 1; i < parts.length && i + usedFields < 25; i++) {
      embed.addFields({ name: 'No Faction (cont.)', value: parts[i] });
    }
  }

  // 4) Post/edit
  let prevId = scfg.previous_message_id || memoryPrevMsgId.get(`${kind}:${guildId}`) || null;
  let msg = null;

  if (prevId) {
    const prev = await channel.messages.fetch(prevId).catch(() => null);
    if (prev) {
      msg = await prev.edit({ embeds: [embed] }).catch(() => null);
      if (!msg) {
        await prev.delete().catch(() => {});
      }
    }
  }

  if (!msg) {
    msg = await channel.send({ embeds: [embed] });
  }

  if (msg?.id) {
    memoryPrevMsgId.set(`${kind}:${guildId}`, msg.id);
    await db.upsertConfig({
      guild_id: guildId,
      previous_message_id: msg.id,
      // last_run_at already written up top; keep it as-is
    });
  }
}

module.exports = { runOnceForGuild };
