// ========================================
// File: src/mc/rpostBot.js
// Uses the assigned Rpost Checker alt via AltRunner
// ========================================
const { getGuildConfig } = require('../database/db');
const AltRunner = require('../discord/alts/altRunner');

let discordChannel = null;
let currentGuildId = null;

// Small per-alt command mutex to avoid overlapping captures
const altLocks = new Map();
function withAltLock(altId, fn) {
  const prev = altLocks.get(altId) || Promise.resolve();
  const next = prev.then(fn, fn);
  altLocks.set(altId, next.catch(() => {}));
  return next;
}

async function getAssignedAltId(guildId) {
  const cfg = await getGuildConfig(guildId);
  const altId = cfg?.rpost_checker_alt_id ? Number(cfg.rpost_checker_alt_id) : 0;
  if (!altId) {
    throw new Error('No “Rpost Checker” alt is assigned. Use Alt Manager → Control Alt → Set as Rpost Checker.');
  }
  return altId;
}

async function ensureCheckerOnlineAndHome(guildId, timeoutMs = 25000) {
  const altId = await getAssignedAltId(guildId);

  // Kick login (AltRunner handles device-code prompts in the Alt channel)
  try { await AltRunner.loginAlt(altId); } catch {}

  // Wait until online (or throw with a helpful message)
  const ok = await AltRunner.waitForOnline(altId, timeoutMs);
  if (!ok) {
    throw new Error('Rpost Checker alt is not online yet. If device-code auth is required, complete it in the Alt Manager channel and try again.');
  }

  // Make sure we’re at /home home before running any capture
  await AltRunner.ensureHomeForAlt(altId).catch(() => {});
  return altId;
}

function captureWithMarkers(bot, rawCommand, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    if (!bot || !bot.chat) return reject(new Error('Alt bot not available'));
    const markerId = `RPOST_MARKER_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
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
      if (text.includes(endMarker)) {
        done = true;
        cleanup();
        resolve(lines.join('\n').trim() || null);
        return;
      }
      if (capturing) lines.push(text);
    };

    const tmr = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      resolve(lines.join('\n').trim() || null);
    }, timeoutMs);

    bot.on('message', onMsg);

    // Use guild chat markers to fence output
    try {
      bot.chat(`/gc ${startMarker}`);
      setTimeout(() => {
        bot.chat(rawCommand.startsWith('/') ? rawCommand : `/${rawCommand}`);
        setTimeout(() => bot.chat(`/gc ${endMarker}`), 10_000);
      }, 400);
    } catch (e) {
      cleanup();
      reject(e);
    }
  });
}

// -------------- Public API (compat) --------------
async function runInGameCommand(command, callback) {
  if (!currentGuildId) {
    throw new Error('Rpost bot has no guild context yet. Call setDiscordChannel(channel) first.');
  }

  const altId = await ensureCheckerOnlineAndHome(currentGuildId);
  const bot = AltRunner.getAltBot(altId); // provided by AltRunner
  if (!bot) throw new Error('Rpost Checker alt bot not ready.');

  // serialize per-alt to avoid marker collisions
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
  // Keep a “bot” proxy for legacy access – it exposes the underlying alt bot when available.
  bot: new Proxy({}, {
    get: (_, prop) => {
      if (!currentGuildId) return undefined;
      // best-effort: return live alt bot if present
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
