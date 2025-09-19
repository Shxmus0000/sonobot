// ========================================
// File: src/discord/alts/altRunner.js
// ========================================
const path = require('path');
const fs = require('fs');
const mineflayer = require('mineflayer');
const {
  getAltById,
  decryptAltRowSecrets,
  setAltStatus,
  getAltManagerConfig,
  listAlts,
  setAltIdentity,
} = require('../../database/db');

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require('discord.js');

const { installMineflayerSkinPatch } = require('../../utils/mineflayerPatches');

// ---------- Env / Tunables ----------
const HOST = process.env.MC_HOST || 'hub.mc-complex.com';
const PORT = parseInt(process.env.MC_PORT || '25565', 10);
const VERSION = process.env.MC_VERSION || '1.20';

const DEFAULT_HOME_CMD = (process.env.MC_ALT_HOME_CMD ?? '/home home').trim();
// IMPORTANT: default to the cross-network hop command
const SERVER_CMD = (process.env.MC_ALT_SERVER_CMD ?? '/server factions').trim();

const AUTO_RECONNECT = (process.env.ALT_AUTO_RECONNECT || 'true').toLowerCase() !== 'false';

const RECONNECT_MIN_MS = parseInt(process.env.ALT_RECONNECT_MIN_MS || '15000', 10);
const RECONNECT_MAX_MS = parseInt(process.env.ALT_RECONNECT_MAX_MS || '15000', 10);
const FIXED_BACKOFF = (process.env.ALT_FIXED_BACKOFF || '1') !== '0';

const SERVER_DELAY_MS  = parseInt(process.env.MC_ALT_SERVER_DELAY_MS || '8000', 10);
const HOME_DELAY_MS    = parseInt(process.env.MC_ALT_HOME_DELAY_MS || '1500', 10);
const CHECK_TIMEOUT_MS = parseInt(process.env.MC_CHECK_TIMEOUT_MS || '120000', 10);

const LOGIN_JITTER_MS = parseInt(process.env.ALT_LOGIN_JITTER_MS || '1500', 10);
const MIN_GAP_BETWEEN_LOGINS_MS = parseInt(process.env.ALT_MIN_GAP_MS || '15000', 10);
const REGISTRATION_LOCK_MS = parseInt(process.env.ALT_REGISTRATION_LOCK_MS || '15000', 10);
const LOGIN_THROTTLE_MIN_MS = parseInt(process.env.ALT_LOGIN_THROTTLE_MIN_MS || '15000', 10);

const CHAT_COOLDOWN_MS = parseInt(process.env.ALT_CHAT_COOLDOWN_MS || '900', 10);

// Per-alt token cache directory
const PROFILES_ROOT = path.join(process.cwd(), 'data', 'nmp-cache');
try { fs.mkdirSync(PROFILES_ROOT, { recursive: true }); } catch {}

// Runtime
let discordClient = null;
const rnd = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// Alt state map
const state = new Map();

// Global throttles
let networkCooldownUntil = 0;
let registrationLockUntil = 0;

// ---------- Login queue ----------
const loginQueue = [];
const queuedSet = new Set();
const queueWaiters = new Map();
let processingQueue = false;

function enqueueLogin(altId) {
  return new Promise((resolve) => {
    if (!queuedSet.has(altId)) {
      queuedSet.add(altId);
      loginQueue.push(altId);
      queueWaiters.set(altId, [resolve]);
    } else {
      const arr = queueWaiters.get(altId) || [];
      arr.push(resolve);
      queueWaiters.set(altId, arr);
    }
    if (!processingQueue) processQueue();
  });
}

async function processQueue() {
  processingQueue = true;
  while (loginQueue.length) {
    const altId = loginQueue.shift();
    queuedSet.delete(altId);
    const resolvers = queueWaiters.get(altId) || [];
    queueWaiters.delete(altId);

    const s = getState(altId);
    const now = Date.now();
    const waitUntil = Math.max(networkCooldownUntil || 0, registrationLockUntil || 0, s.cooldownUntil || 0);
    if (waitUntil > now) {
      const delay = waitUntil - now + rnd(300, 700);
      await sleep(delay);
    }

    if (s.bot && s.bot.player && s.bot.player.username) {
      resolvers.forEach(r => r({ status: 'already-online' }));
      await sleep(300);
      continue;
    }

    const result = await connectAltNow(altId).catch(err => ({ status: 'error', error: err }));
    resolvers.forEach(r => r(result));

    await sleep(MIN_GAP_BETWEEN_LOGINS_MS + rnd(0, LOGIN_JITTER_MS));
  }
  processingQueue = false;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- State & FS helpers ----------
function getState(altId) {
  if (!state.has(altId)) {
    state.set(altId, {
      bot: null,
      reconnectTimer: null,
      backoff: RECONNECT_MIN_MS,
      guildId: null,
      label: null,
      awaitingDevice: false,
      deviceExpiresAt: 0,
      suppressed: false,
      cmdQueue: [],
      connectingAt: 0,
      authDir: null,
      cooldownUntil: 0,

      lastChatAt: 0,
      sendingQueue: false,

      // sidebar capture runtime (added)
      _sidebar: null,
      _sidebarCleanup: null,
      _sidebarArmed: false, // 🔒 do not log/parse until /home is confirmed

      // live shard/world info (added)
      worldPretty: null,
      worldUpdatedAt: 0,
    });
  }
  return state.get(altId);
}

function ensureAltAuthDir(altId) {
  const authDir = path.join(PROFILES_ROOT, `alt-${altId}`);
  try { fs.mkdirSync(authDir, { recursive: true }); } catch {}
  return authDir;
}

function wipeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch { return false; }
}

function wipeAltAuthDir(altId) {
  const s = getState(altId);
  const dir = s.authDir || path.join(PROFILES_ROOT, `alt-${altId}`);
  return wipeDir(dir);
}

async function forceWipeAltAuthCache(altId, { clearDb = true } = {}) {
  const s = getState(altId);
  if (s.bot) {
    try { s.bot.end('force-wipe-auth'); } catch {}
    s.bot = null;
  }
  const wiped = wipeAltAuthDir(altId);
  if (clearDb) {
    try { await setAltIdentity({ id: altId, mc_uuid: null, mc_last_username: null }); } catch {}
  }
  return wiped;
}

async function postToAltChannel(guildId, payload) {
  if (!discordClient) return;
  try {
    const acfg = await getAltManagerConfig(guildId);
    if (!acfg?.channel_id) return;
    const chan = await discordClient.channels.fetch(acfg.channel_id).catch(() => null);
    if (!chan) return;
    await chan.send(payload);
  } catch (e) {
    console.warn('[AltRunner] Failed to post to Alt Manager channel:', e.message);
  }
}

// ---------- Device-code helpers ----------
function extractLink(raw) {
  return (
    raw?.verification_uri_complete ||
    raw?.verificationUriComplete ||
    raw?.verification_uri ||
    raw?.verificationUri ||
    (raw?.message && (raw.message.match(/https?:\/\/\S+/)?.[0])) ||
    'https://microsoft.com/link'
  );
}
function extractUserCode(raw) {
  const direct = raw?.user_code || raw?.userCode;
  if (direct) return String(direct);
  const msg = String(raw?.message || '');
  const m = msg.match(/[A-Z0-9]{3,8}-[A-Z0-9]{3,8}/i);
  return m ? m[0].toUpperCase() : null;
}
async function sendDeviceCodeToGuild(guildId, raw, altLabel = '', expectedEmail = '') {
  const code = extractUserCode(raw) || '—';
  const link = extractLink(raw);
  const expiresIn = Number(raw?.expires_in || raw?.expiresIn || 900);
  const minutes = Math.max(1, Math.round(expiresIn / 60));
  const emailHint = expectedEmail ? `\n**Sign in with:** \`${expectedEmail}\`` : '';
  const embed = new EmbedBuilder()
    .setTitle(`🔐 Microsoft Login Required — ${altLabel || 'Alt'}`)
    .setDescription(
      [
        'This alt needs to authenticate with Microsoft.',
        '',
        `**Step 1:** Click **Open Sign-in**`,
        `**Step 2:** Enter code: \`${code}\``,
        `**Step 3:** Finish login in your browser.${emailHint}`,
        '',
        `This code expires in ~${minutes} minute${minutes === 1 ? '' : 's'}.`
      ].join('\n')
    )
    .setColor(0x5865F2)
    .setFooter({ text: 'After completing, the alt will connect automatically.' });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Open Sign-in').setURL(link)
  );
  await postToAltChannel(guildId, { embeds: [embed], components: [row] });
}

// ---------- Reconnect control ----------
function cleanUpBot(altId, reason = 'cleanup') {
  const s = getState(altId);
  if (s.reconnectTimer) { clearTimeout(s.reconnectTimer); s.reconnectTimer = null; }
  if (s.bot) {
    try { s.bot.end(reason); } catch {}
    s.bot = null;
  }
}

async function scheduleReconnect(altId, delayOverrideMs = null, { force = false } = {}) {
  const s = getState(altId);
  if (s.awaitingDevice || s.suppressed || !AUTO_RECONNECT) return;

  const now = Date.now();
  const until = Math.max(s.cooldownUntil || 0, networkCooldownUntil || 0, registrationLockUntil || 0);

  let base = (delayOverrideMs != null ? delayOverrideMs : s.backoff);
  if (until > now) base = Math.max(base, until - now);

  const delay = base + rnd(0, LOGIN_JITTER_MS);
  s.backoff = FIXED_BACKOFF ? RECONNECT_MIN_MS : Math.min(Math.round(Math.max(RECONNECT_MIN_MS, s.backoff) * 1.5), RECONNECT_MAX_MS);

  if (s.reconnectTimer) {
    if (!force) return;
    try { clearTimeout(s.reconnectTimer); } catch {}
    s.reconnectTimer = null;
  }

  s.reconnectTimer = setTimeout(() => {
    s.reconnectTimer = null;
    enqueueLogin(altId).catch(() => {});
  }, delay);
}

function parseKickReason(reason) {
  try {
    if (!reason) return '';
    if (typeof reason === 'string') return reason;
    if (typeof reason === 'object' && 'text' in reason) return String(reason.text);
    if (typeof reason === 'object' && 'translate' in reason) return String(reason.translate);
    return JSON.stringify(reason);
  } catch { return String(reason || ''); }
}

function waitForEventOrTimeout(emitter, event, ms) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { emitter.removeListener(event, onEvt); } catch {}
      resolve('timeout');
    }, ms);
    function onEvt(...args) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ type: 'event', args });
    }
    emitter.once(event, onEvt);
  });
}

// ---------- Command sending (safe: Mineflayer chat) ----------
function drainQueue(altId) {
  const s = getState(altId);
  if (!s.bot || !s.bot.player) return;
  if (s.sendingQueue) return;
  s.sendingQueue = true;

  const tick = () => {
    if (!s.bot || !s.bot.player) { s.sendingQueue = false; return; }
    const msg = s.cmdQueue.shift();
    if (!msg) { s.sendingQueue = false; return; }

    const now = Date.now();
    const wait = Math.max(0, (s.lastChatAt || 0) + CHAT_COOLDOWN_MS - now);

    setTimeout(() => {
      try {
        s.bot.chat(msg);
        s.lastChatAt = Date.now();
        console.log(`[AltRunner] -> sent chat: ${msg}`);
      } catch (e) {
        console.warn('[AltRunner] send chat failed:', e?.message || e);
      }
      setImmediate(tick);
    }, wait);
  };

  tick();
}

// ---------- Build Mineflayer options ----------
function buildOptionsMicrosoft({ host, port, version, username, profilesFolder, onMsaCode }) {
  const base = { host, port, version, auth: 'microsoft', username, checkTimeoutInterval: CHECK_TIMEOUT_MS, profilesFolder };
  if (onMsaCode) base.onMsaCode = onMsaCode;
  return base;
}
function buildOptionsOffline({ host, port, version, username }) {
  return { host, port, version, auth: 'offline', username, checkTimeoutInterval: CHECK_TIMEOUT_MS };
}

// ===================================================================
//  Robust "ensure home" helpers used by the trackers and on login
// ===================================================================
const HOME_CONFIRM_PATTERNS = [
  /teleport/i,
  /home/i,
  /moved you/i,
  /you (?:were|have been) (?:teleported|moved)/i,
  /now entering/i,
];

function waitForChatMatch(bot, regexes, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (!bot) return resolve(false);
    let done = false;
    const finish = (val) => { if (!done) { done = true; cleanup(); resolve(!!val); } };
    const onStr = (t) => {
      if (done) return;
      const line = String(t || '');
      if (regexes.some(r => r.test(line))) finish(true);
    };
    const onMsg = (m) => {
      if (done) return;
      const line = m?.toString?.() || '';
      if (regexes.some(r => r.test(line))) finish(true);
    };
    const cleanup = () => {
      try { bot.off('messagestr', onStr); } catch {}
      try { bot.off('message', onMsg); } catch {}
    };
    bot.on('messagestr', onStr);
    bot.on('message', onMsg);
    setTimeout(() => finish(false), timeoutMs);
  });
}

// ===================================================================
//  Sidebar / Shard capture (console-only; ARMED AFTER /home confirmed)
// ===================================================================
const SIDEBAR_POS_NAMES = { 0: 'list', 1: 'sidebar', 2: 'belowName' };

function posNameOf(position) {
  if (typeof position === 'string') return position;
  return SIDEBAR_POS_NAMES[position] || String(position);
}

function textOf(x) {
  try {
    if (!x) return '';
    if (typeof x === 'string') return x;
    if (typeof x.toString === 'function') return String(x.toString());
    if (x.text) return String(x.text);
    return JSON.stringify(x);
  } catch {
    return String(x || '');
  }
}

/** Best-effort: turn a mineflayer scoreboard into ordered lines top->bottom */
function linesFromScoreboard(sb) {
  if (!sb) return [];
  let items = [];
  if (Array.isArray(sb.items)) items = sb.items;
  else if (sb.items && typeof sb.items.values === 'function') items = Array.from(sb.items.values());
  else if (sb.scores && typeof sb.scores.values === 'function') items = Array.from(sb.scores.values());
  else if (Array.isArray(sb.scores)) items = sb.scores;
  else if (sb.items && typeof sb.items === 'object') items = Object.values(sb.items);

  items.sort((a, b) => {
    const as = (a.score ?? a.value ?? 0);
    const bs = (b.score ?? b.value ?? 0);
    if (bs !== as) return bs - as;
    const an = textOf(a.displayName ?? a.name ?? '');
    const bn = textOf(b.displayName ?? b.name ?? '');
    return an.localeCompare(bn);
  });

  const rawLines = items.map(it => textOf(it.displayName ?? it.name ?? '').trim()).filter(Boolean);

  // Strip MC color codes and obvious fillers
  return rawLines
    .map(l => l.replace(/\u00A7[0-9A-FK-OR]/gi, '').trim())
    .filter(l => l && l !== '-');
}

/** --- NEW: robust normalization to detect "season" in fancy fonts --- */
const SMALLCAPS_MAP = {
  'ᴀ':'a','ʙ':'b','ᴄ':'c','ᴅ':'d','ᴇ':'e','ғ':'f','ɢ':'g','ʜ':'h','ɪ':'i','ᴊ':'j','ᴋ':'k','ʟ':'l',
  'ᴍ':'m','ɴ':'n','ᴏ':'o','ᴘ':'p','ʀ':'r','ꜱ':'s','ᴛ':'t','ᴜ':'u','ᴠ':'v','ᴡ':'w','x':'x','ʏ':'y','ᴢ':'z'
};
function normalizeForMatch(s) {
  if (!s) return '';
  const noDiacritics = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  let folded = '';
  for (const ch of noDiacritics) folded += (SMALLCAPS_MAP[ch] || ch);
  return folded.toLowerCase();
}

/** Heuristic: find shard/world name from the sidebar lines (skip "season" etc.) */
function guessWorldFromLines(lines) {
  if (!lines?.length) return null;

  const pairs = lines.map(l => ({ raw: l, norm: normalizeForMatch(l) }));

  // Prefer starting just after the "season" line (even if stylized)
  const seasonIdx = pairs.findIndex(p => /\bseason\b/.test(p.norm));
  const start = seasonIdx >= 0 ? Math.min(seasonIdx + 1, pairs.length - 1) : 0;

  // Words/lines to avoid when picking a world label
  const bannedNorm = /(season|server|balance|experience|xp\b|k\/d|fly\s*time|power|online\b|shield|faction|member|claim|claimed|money|coins|vote|store|discord|website|hub\b|mc-?complex|\.com)/i;

  const isCandidate = (raw, norm) => {
    if (!raw || !raw.trim()) return false;
    if (bannedNorm.test(norm)) return false;
    if (/^\s*[\[\(]/.test(raw)) return false;         // [Member] or similar
    if (/^\s*[•▪\-]/.test(raw)) return false;         // stat bullet lines
    if (/\[[^\]]+\]/.test(raw)) return false;         // anything with brackets like "hallo [#371]"
    if (/:/.test(raw)) return false;                  // stat-like "Key: Value"
    return true;
  };

  // Scan a small window after the season line first
  const windowEnd = Math.min(pairs.length, start + 6);
  const windowCandidate = pairs.slice(start, windowEnd).find(p => isCandidate(p.raw, p.norm));
  if (windowCandidate) return windowCandidate.raw;

  // Fallback: first candidate anywhere
  const anyCandidate = pairs.find(p => isCandidate(p.raw, p.norm));
  return anyCandidate ? anyCandidate.raw : null;
}

/** Attach listeners to a bot to track sidebar; logs only when ARMED after /home */
function attachSidebarCapture(altId, bot) {
  const s = getState(altId);
  s._sidebar = { currentObjective: null, lastLines: null, lastWorld: null, compute: null };

  const computeAndLog = (why, sb) => {
    try {
      // 🚦 gate until /home confirmed
      if (!getState(altId)._sidebarArmed && !String(why).startsWith('armed')) return;
      if (!sb) return;

      const lines = linesFromScoreboard(sb);
      const world = guessWorldFromLines(lines);

      const changedLines = JSON.stringify(lines) !== JSON.stringify(s._sidebar.lastLines);
      const changedWorld = world && world !== s._sidebar.lastWorld;

      if (changedLines || changedWorld) {
        console.log(
          `[AltRunner][Scoreboard] ${s.label || altId} `
          + `(${why}) — title="${textOf(sb.displayName || sb.name)}"\n`
          + `  Lines:\n  - ${lines.join('\n  - ')}`
        );
      }
      if (changedWorld) {
        s._sidebar.lastWorld = world;
        s.worldPretty = world;               // <-- cache pretty world name
        s.worldUpdatedAt = Date.now();       // <-- update timestamp
        console.log(`[AltRunner][World] ${s.label || altId} → "${world}"`);
      }
      s._sidebar.lastLines = lines;
    } catch (e) {
      console.warn('[AltRunner] sidebar parse failed:', e?.message || e);
    }
  };
  s._sidebar.compute = computeAndLog;

  const onPos = (position, sb) => {
    if (posNameOf(position) === 'sidebar') {
      s._sidebar.currentObjective = sb;
      computeAndLog('position=sidebar', sb);
    }
  };
  const onTitle = (sb) => {
    if (sb && (sb === s._sidebar.currentObjective)) computeAndLog('titleChanged', sb);
  };
  const onScoreUpdate = (sb /*, item */) => {
    if (sb && (sb === s._sidebar.currentObjective)) computeAndLog('scoreUpdated', sb);
  };
  const onScoreRemove = (sb /*, item */) => {
    if (sb && (sb === s._sidebar.currentObjective)) computeAndLog('scoreRemoved', sb);
  };
  const onCreated = (sb) => {
    if (sb?.position && posNameOf(sb.position) === 'sidebar') {
      s._sidebar.currentObjective = sb;
      computeAndLog('created', sb);
    }
  };

  bot.on('scoreboardPosition', onPos);
  bot.on('scoreboardTitleChanged', onTitle);
  bot.on('scoreUpdated', onScoreUpdate);
  bot.on('scoreRemoved', onScoreRemove);
  bot.on('scoreboardCreated', onCreated);

  // Probe in case the sidebar existed before listeners were attached.
  setTimeout(() => {
    try {
      const all = bot?.scoreboards || bot?.scoreboard || null;
      const sbs = all && typeof all === 'object' ? Object.values(all) : [];
      const sb = sbs.find(x => x && posNameOf(x.position) === 'sidebar');
      if (sb) {
        s._sidebar.currentObjective = sb;
        computeAndLog('initial-scan', sb);
      }
    } catch {}
  }, 1500);

  // Return a cleanup hook
  return () => {
    try { bot.off('scoreboardPosition', onPos); } catch {}
    try { bot.off('scoreboardTitleChanged', onTitle); } catch {}
    try { bot.off('scoreUpdated', onScoreUpdate); } catch {}
    try { bot.off('scoreRemoved', onScoreRemove); } catch {}
    try { bot.off('scoreboardCreated', onCreated); } catch {}
    s._sidebar = null;
  };
}

/** Arm the sidebar capture AFTER /home confirmed, and take an immediate snapshot */
function armSidebarCapture(altId, bot, reason = 'home-confirmed') {
  const s = getState(altId);
  s._sidebarArmed = true;
  try {
    const all = bot?.scoreboards || bot?.scoreboard || null;
    const sbs = all && typeof all === 'object' ? Object.values(all) : [];
    const sb = (s._sidebar?.currentObjective) || sbs.find(x => x && posNameOf(x.position) === 'sidebar');
    if (sb && s._sidebar?.compute) {
      s._sidebar.compute(`armed:${reason}`, sb);
    }
  } catch {}
}

async function ensureOnline(altId, timeoutMs = 25000) {
  await enqueueLogin(altId).catch(() => {});
  const bot = await waitForOnline(altId, timeoutMs);
  if (!bot) throw new Error('Alt did not come online (device-code auth may be required).');
  return bot;
}

async function ensureHomeForAlt(altId, {
  serverCmd = SERVER_CMD,
  homeCmd = DEFAULT_HOME_CMD,
  hopDelayMs = SERVER_DELAY_MS,
  attempts = 3,
  attemptGapMs = 3500,
} = {}) {
  const s = getState(altId);
  const bot = await ensureOnline(altId);
  if (!bot?.chat) return false;

  // Optional: hop to the main server first
  if (serverCmd && serverCmd.toLowerCase() !== 'none') {
    try { bot.chat(serverCmd.startsWith('/') ? serverCmd : `/${serverCmd}`); } catch {}
    await sleep(Math.max(2000, hopDelayMs));
  }

  if (!homeCmd) return true;

  for (let i = 0; i < attempts; i++) {
    try { bot.chat(homeCmd.startsWith('/') ? homeCmd : `/${homeCmd}`); } catch {}
    const ok = await waitForChatMatch(bot, HOME_CONFIRM_PATTERNS, Math.max(2500, attemptGapMs - 250));
    if (ok) {
      // ✅ Arm sidebar capture NOW that /home is confirmed.
      try { armSidebarCapture(altId, bot, 'ensureHomeForAlt-ok'); } catch {}
      return true;
    }
    await sleep(attemptGapMs);
  }
  return false;
}

// ---------- Core connect ----------
async function connectAltNow(altId) {
  const row = await getAltById(altId);
  if (!row) throw new Error('Alt not found');
  const alt = decryptAltRowSecrets(row);

  const s = getState(altId);
  s.guildId = alt.guild_id;
  s.label = alt.label;
  s.backoff = RECONNECT_MIN_MS;
  s.awaitingDevice = false;
  s.suppressed = false;

  // reset gating on (re)connect
  s._sidebarArmed = false;

  cleanUpBot(altId, 'relogin');

  const authDir = ensureAltAuthDir(altId);
  s.authDir = authDir;

  const usernameHint = (alt.email_plain || alt.label || `alt-${alt.id}`).trim();
  const useMicrosoft = (alt.auth_mode || 'microsoft') === 'microsoft';

  let opts;
  if (useMicrosoft) {
    opts = buildOptionsMicrosoft({
      host: HOST, port: PORT, version: VERSION,
      username: usernameHint,
      profilesFolder: authDir,
      onMsaCode: async (data) => {
        s.awaitingDevice = true;
        const expires = Number(data?.expires_in || data?.expiresIn || 900) * 1000;
        s.deviceExpiresAt = Date.now() + expires;
        await sendDeviceCodeToGuild(alt.guild_id, data, alt.label, alt.email_plain || '');
        await setAltStatus({ id: alt.id, status: 'auth-wait', last_seen: Math.floor(Date.now() / 1000) });
      }
    });
  } else {
    opts = buildOptionsOffline({
      host: HOST, port: PORT, version: VERSION,
      username: alt.mc_username || alt.label || `alt-${alt.id}`,
    });
  }

  console.log(`[AltRunner] Logging in alt "${alt.label}" (${alt.id}) => ${HOST}:${PORT} auth=${opts.auth}${useMicrosoft ? ' (device-code)' : ''} · username="${opts.username}"`);

  s.connectingAt = Date.now();
  const bot = mineflayer.createBot(opts);

  try { installMineflayerSkinPatch(bot); } catch (e) { console.warn('installMineflayerSkinPatch failed:', e?.message); }

  s.bot = bot;

  bot.once('spawn', async () => {
    s.awaitingDevice = false;
    s.suppressed = false;

    // Attach sidebar capture immediately, but it will be gated until /home is confirmed.
    try {
      try { s._sidebarCleanup?.(); } catch {}
      s._sidebarCleanup = attachSidebarCapture(altId, bot);
    } catch (e) {
      console.warn('[AltRunner] failed to attach sidebar capture:', e?.message || e);
    }

    registrationLockUntil = Math.max(registrationLockUntil, Date.now() + REGISTRATION_LOCK_MS);

    console.log(`[AltRunner] Alt "${alt.label}" spawned as ${bot.player?.username || 'unknown'}.`);
    await setAltStatus({ id: altId, status: 'online', last_seen: Math.floor(Date.now() / 1000) });

    try {
      bot.on('resourcePack', () => {
        try { bot.denyResourcePack(); } catch {}
        console.log('[AltRunner] Resource pack denied.');
      });
    } catch {}

    // Kick server hop; wait for it to complete; then go /home.
    const settleMs = 1500;

    // Step 1: hop to the target server (e.g., Factions)
    setTimeout(() => {
      try {
        if (SERVER_CMD && SERVER_CMD.toLowerCase() !== 'none') {
          bot.chat(SERVER_CMD.startsWith('/') ? SERVER_CMD : `/${SERVER_CMD}`);
        }
      } catch {}
    }, settleMs);

    // Step 2: after hop delay, try initial /home
    setTimeout(() => {
      try {
        if (DEFAULT_HOME_CMD) {
          bot.chat(DEFAULT_HOME_CMD.startsWith('/') ? DEFAULT_HOME_CMD : `/${DEFAULT_HOME_CMD}`);
        }
      } catch {}
    }, settleMs + Math.max(2000, SERVER_DELAY_MS + 500));

    // Step 3: redundancy pass with retries & confirmations, then ARM on success
    setTimeout(() => {
      ensureHomeForAlt(altId, { attempts: 4, attemptGapMs: 4000 })
        .then(ok => { if (ok) try { armSidebarCapture(altId, bot, 'redundancy-pass'); } catch {} })
        .catch(() => {});
    }, settleMs + Math.max(5000, SERVER_DELAY_MS + 2500));

    // Delay draining queued commands until after the first home attempt so we don't race it
    setTimeout(() => drainQueue(altId), settleMs + Math.max(2500, SERVER_DELAY_MS + 1500));
  });

  bot.on('respawn', () => setTimeout(() => drainQueue(altId), 1500));

  bot.on('end', async (reason) => {
    // Cleanup sidebar listeners on disconnect
    try { getState(altId)?._sidebarCleanup?.(); } catch {}
    try { getState(altId)._sidebarCleanup = null; } catch {}
    // Disarm on disconnect
    try { getState(altId)._sidebarArmed = false; } catch {}
    // Reset world cache
    try { getState(altId).worldPretty = null; getState(altId).worldUpdatedAt = 0; } catch {}

    console.warn(`[AltRunner] Alt "${alt.label}" disconnected: ${reason}`);
    await setAltStatus({ id: altId, status: 'offline', last_seen: Math.floor(Date.now() / 1000) });
    s.bot = null;
    if (s.awaitingDevice || s.suppressed) return;
    await scheduleReconnect(altId, RECONNECT_MIN_MS, { force: true });
  });

  bot.on('kicked', async (reasonObj) => {
    const raw = parseKickReason(reasonObj);

    // Cleanup sidebar listeners on kick
    try { getState(altId)?._sidebarCleanup?.(); } catch {}
    try { getState(altId)._sidebarCleanup = null; } catch {}
    // Disarm on kick
    try { getState(altId)._sidebarArmed = false; } catch {}
    // Reset world cache
    try { getState(altId).worldPretty = null; getState(altId).worldUpdatedAt = 0; } catch {}

    console.warn(`[AltRunner] Alt "${alt.label}" kicked: ${JSON.stringify(reasonObj)}`);
    await setAltStatus({ id: altId, status: 'error', last_seen: Math.floor(Date.now() / 1000) });

    if (/logging in too fast/i.test(raw)) {
      const until = Date.now() + LOGIN_THROTTLE_MIN_MS;
      registrationLockUntil = Math.max(registrationLockUntil, until);
      await scheduleReconnect(altId, RECONNECT_MIN_MS, { force: true });
      return;
    }

    if (/unable to register you with the network/i.test(raw)) {
      const until = Date.now() + RECONNECT_MIN_MS;
      const prevNet = networkCooldownUntil;
      const prevLock = registrationLockUntil;
      networkCooldownUntil = Math.max(networkCooldownUntil || 0, until);
      registrationLockUntil = Math.max(registrationLockUntil || 0, until);
      s.cooldownUntil = Math.max(s.cooldownUntil || 0, until);

      if (prevNet !== networkCooldownUntil || prevLock !== registrationLockUntil) {
        await postToAltChannel(alt.guild_id, {
          embeds: [
            new EmbedBuilder()
              .setTitle('⏳ Network is rate-limiting new connections')
              .setDescription(
                [
                  `**${alt.label}** got: *"Unable to register you with the network, try again later"*`,
                  `Applied a short global cooldown; will retry automatically.`
                ].join('\n')
              )
              .setColor(0xF1C40F)
          ]
        });
      }
      await scheduleReconnect(altId, RECONNECT_MIN_MS, { force: true });
      return;
    }

    await scheduleReconnect(altId, RECONNECT_MIN_MS, { force: true });
  });

  bot.on('error', async (err) => {
    const msg = String(err?.message || err);
    console.warn(`[AltRunner] Alt "${alt.label}" error: ${msg}`);

    if (/403/i.test(msg) || /forbidden/i.test(msg)) {
      await postToAltChannel(alt.guild_id, {
        embeds: [
          new EmbedBuilder()
            .setTitle('❌ Microsoft signed in, but Minecraft login was rejected (403)')
            .setDescription(
              [
                `Alt: **${alt.label}**`,
                '',
                'This usually means the account cannot obtain a **Minecraft Java** token.',
                '• Ensure this Microsoft account owns **Minecraft: Java Edition** and has an Xbox profile set up.',
              ].join('\n')
            )
            .setColor(0xED4245)
        ]
      });
    }

    if (getState(altId).awaitingDevice) {
      await setAltStatus({ id: altId, status: 'auth-wait', last_seen: Math.floor(Date.now() / 1000) });
      return;
    }

    await setAltStatus({ id: altId, status: 'error', last_seen: Math.floor(Date.now() / 1000) });
    scheduleReconnect(altId, RECONNECT_MIN_MS, { force: true });
  });
}

// ---------- Public helpers ----------
async function logoutAlt(altId) {
  const s = getState(altId);
  if (!s.bot) return;
  console.log(`[AltRunner] Logging out alt ${altId} (${s.label || ''})`);
  if (s.reconnectTimer) { clearTimeout(s.reconnectTimer); s.reconnectTimer = null; }
  try { s.bot.end('logout'); } catch {}
  s.bot = null;
  s.awaitingDevice = false;
  s.suppressed = false;
  // Cleanup sidebar if present & disarm
  try { s._sidebarCleanup?.(); } catch {}
  s._sidebarCleanup = null;
  s._sidebarArmed = false;
  // Reset world cache
  s.worldPretty = null;
  s.worldUpdatedAt = 0;
  await setAltStatus({ id: altId, status: 'offline', last_seen: Math.floor(Date.now() / 1000) });
}

async function sendCommand(altId, commandText) {
  const s = getState(altId);
  const raw = String(commandText || '').trim();
  if (!raw) throw new Error('Empty command');

  const line = raw.startsWith('/') ? raw : `/${raw}`;

  s.cmdQueue.push(line);

  if (s.bot && s.bot.player && s.bot.player.username) {
    drainQueue(altId);
    return;
  }

  if (!s.awaitingDevice && !s.reconnectTimer) {
    setTimeout(() => enqueueLogin(altId).catch(() => {}), rnd(2000, 4000));
  }
  throw new Error('Alt is offline; your command has been queued and will be sent after it reconnects.');
}

function isOnline(altId) {
  const s = getState(altId);
  return !!(s.bot && s.bot.player && s.bot.player.username);
}

function getBot(altId) {
  const s = state.get(altId);
  return s?.bot || null;
}

// Alias for legacy codepaths
const getAltBot = getBot;

/** Poll until the alt is online (returns Mineflayer bot or null on timeout) */
async function waitForOnline(altId, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start <= timeoutMs) {
    const s = state.get(altId);
    if (s?.bot?.player?.username) return s.bot;
    await sleep(250);
  }
  return null;
}

function init(client) { discordClient = client; }

async function startAllForGuild(guildId) {
  const alts = await listAlts(guildId);
  for (const alt of alts) {
    try { await enqueueLogin(alt.id); } catch (e) { console.warn(`[AltRunner] Failed to queue "${alt.label}":`, e.message); }
    await sleep(MIN_GAP_BETWEEN_LOGINS_MS + rnd(0, LOGIN_JITTER_MS));
  }
}

/** Get prettified current world/shard for an alt (null if unknown) */
function getAltWorld(altId) {
  const s = getState(altId);
  return s?.worldPretty || null;
}

module.exports = {
  init,
  loginAlt: enqueueLogin,
  logoutAlt,
  sendCommand,
  isOnline,
  forceWipeAltAuthCache,
  startAllForGuild,

  getBot,
  getAltBot, // alias for existing callers
  waitForOnline,

  // Robust home helper so every alt can be forced home
  ensureHomeForAlt,

  // Live shard/world accessor
  getAltWorld,
};
