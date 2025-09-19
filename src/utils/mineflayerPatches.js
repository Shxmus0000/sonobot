// ========================================
// Mineflayer skin JSON hardening (1.19+ / 1.20+)
// - Sanitizes malformed base64 "textures" before Mineflayer parses.
// - Hooks low-level 'packet' + named events as backup.
// - Swallows only the known JSON parse crash in entities plugin.
// ========================================
let installedProcessGuards = false;

function installMineflayerSkinPatch(bot) {
  if (!bot || !bot._client) return;
  const client = bot._client;

  const sanitizeTextures = (obj) => {
    try {
      const visit = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) return node.forEach(visit);

        if (Array.isArray(node.properties)) {
          for (const p of node.properties) {
            if (p && p.name === 'textures' && typeof p.value === 'string') {
              try {
                const s = Buffer.from(p.value, 'base64').toString('utf8');
                JSON.parse(s);
              } catch {
                const fallback = Buffer.from(JSON.stringify({ textures: {} }), 'utf8').toString('base64');
                p.value = fallback;
              }
            }
          }
        }
        for (const k of Object.keys(node)) visit(node[k]);
      };
      visit(obj);
    } catch {}
  };

  const onPacket = (data, meta) => {
    try {
      if (!meta || meta.state !== 'play') return;
      if (meta.name === 'player_info' || meta.name === 'player_info_update') {
        sanitizeTextures(data);
      }
    } catch {}
  };

  try {
    if (typeof client.prependListener === 'function') client.prependListener('packet', onPacket);
    else client.on('packet', onPacket);
  } catch { client.on('packet', onPacket); }

  try { client.prependListener('player_info', sanitizeTextures); } catch { client.on('player_info', sanitizeTextures); }
  try { client.prependListener('player_info_update', sanitizeTextures); } catch { client.on('player_info_update', sanitizeTextures); }

  if (!installedProcessGuards) {
    installedProcessGuards = true;

    const skinErrRe = /plugins[\/\\]entities\.js|extractSkinInformation|is not valid JSON/;

    const maybeSwallow = (err) => {
      if (!err) return false;
      const msg = String(err.message || err || '');
      const stk = String(err.stack || '');
      if (skinErrRe.test(msg) || skinErrRe.test(stk)) {
        console.warn('[MineflayerPatch] Ignored invalid skin JSON from server.');
        return true;
      }
      return false;
    };

    process.on('uncaughtException', (err) => {
      if (maybeSwallow(err)) return;
      throw err;
    });

    process.on('unhandledRejection', (reason) => {
      if (reason instanceof Error && maybeSwallow(reason)) return;
      // let others propagate
    });
  }
}

module.exports = { installMineflayerSkinPatch };
