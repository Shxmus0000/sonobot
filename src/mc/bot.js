// ========================================
// File: src/mc/bot.js
// Uses the assigned Shard Checker alt via AltRunner
// ========================================
const { getGuildConfig } = require('../database/db');
const AltRunner = require('../discord/alts/altRunner');

let discordChannel = null;
let currentGuildId = null;

const altLocks = new Map();
function withAltLock(altId, fn) {
  const prev = altLocks.get(altId) || Promise.resolve();
  const next = prev.then(fn, fn);
  altLocks.set(altId, next.catch(() => {}));
  return next;
}

async function getAssignedAltId(guildId) {
  const cfg = await getGuildConfig(guildId);
  const altId = cfg?.shard_checker_alt_id ? Number(cfg.shard_checker_alt_id) : 0;
  if (!altId) throw new Error('No “Shard Checker” alt is assigned. Use Alt Manager → Control Alt → Set as Shard Checker.');
  return altId;
}

async function ensureCheckerOnlineAndHome(guildId, timeoutMs = 25000) {
  const altId = await getAssignedAltId(guildId);
  try { await AltRunner.loginAlt(altId); } catch {}
  const ok = await AltRunner.waitForOnline(altId, timeoutMs);
  if (!ok) throw new Error('Shard Checker alt is not online yet. If device-code auth is required, complete it in the Alt Manager channel and try again.');
  // Make sure we’re at /home home before running any capture
  await AltRunner.ensureHomeForAlt(altId).catch(() => {});
  return altId;
}

function captureWithMarkers(bot, rawCommand, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    if (!bot || !bot.chat) return reject(new Error('Alt bot not available'));
    const markerId = `SHARD_MARKER_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const startMarker = `[START_${markerId}]`;
    const endMarker = `[END_${markerId}]`;

    const lines = [];
    let capturing = false;
    let done = false;

    const cleanup = () => {
      try { bot.removeListener('message', onMsg); } catch {}
      try { clearTimeout(tmr); } catch {}
    };

    const onMsg = (msg) => {
      if (done) return;
      const text = msg?.toString?.().trim?.() || '';
      if (!text) return;
      if (text.includes(startMarker)) { capturing = true; return; }
      if (text.includes(endMarker)) { done = true; cleanup(); resolve(lines.join('\n').trim() || null); return; }
      if (capturing) lines.push(text);
    };

    const tmr = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      resolve(lines.join('\n').trim() || null);
    }, timeoutMs);

    bot.on('message', onMsg);

    try {
      bot.chat(`/gc ${startMarker}`);
      setTimeout(() => {
        bot.chat(rawCommand.startsWith('/') ? rawCommand : `/${rawCommand}`);
        setTimeout(() => bot.chat(`/gc ${endMarker}`), 10000);
      }, 400);
    } catch (e) {
      cleanup();
      reject(e);
    }
  });
}

async function runInGameCommand(command, callback) {
  if (!currentGuildId) throw new Error('Shard bot has no guild context yet. Call setDiscordChannel(channel) first.');
  const altId = await ensureCheckerOnlineAndHome(currentGuildId);
  const bot = AltRunner.getAltBot(altId);
  if (!bot) throw new Error('Shard Checker alt bot not ready.');
  const out = await withAltLock(altId, () => captureWithMarkers(bot, command));
  if (typeof callback === 'function') callback(out);
  return out;
}

async function createBot() {
  if (!currentGuildId) return;
  await ensureCheckerOnlineAndHome(currentGuildId).catch(() => {});
}

function setDiscordChannel(channel) {
  discordChannel = channel || null;
  currentGuildId = channel?.guild?.id || null;
}

module.exports = {
  createBot,
  runInGameCommand,
  setDiscordChannel,
  bot: new Proxy({}, {
    get: (_, prop) => {
      if (!currentGuildId) return undefined;
      return (async () => {
        try {
          const altId = await getAssignedAltId(currentGuildId);
          const b = AltRunner.getAltBot(altId);
          return b?.[prop];
        } catch { return undefined; }
      })();
    }
  })
};
