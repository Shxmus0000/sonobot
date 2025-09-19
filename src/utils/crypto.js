// ========================================
// File: src/utils/crypto.js
// ========================================
const crypto = require('crypto');

const ALG = 'aes-256-gcm';
function getKey() {
  const secret = process.env.ALTS_CRYPT_KEY;
  if (!secret || String(secret).length < 16) {
    throw new Error('ALTS_CRYPT_KEY environment variable is not set (or too short). Set a long random string.');
  }
  // derive a 32-byte key
  return crypto.createHash('sha256').update(String(secret)).digest();
}

/**
 * Encrypts a JS object (e.g., {u, p}) and returns a base64 string.
 * Layout: [12b IV][16b TAG][ciphertext...]
 */
function encryptLogin(obj) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  const pt = Buffer.from(JSON.stringify(obj), 'utf8');
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, tag, ct]).toString('base64');
  return payload;
}

/**
 * Decrypts the base64 payload returned by encryptLogin.
 */
function decryptLogin(payloadB64) {
  const key = getKey();
  const buf = Buffer.from(payloadB64, 'base64');
  if (buf.length < 12 + 16 + 1) throw new Error('Invalid encrypted payload');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);

  const decipher = crypto.createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
}

module.exports = { encryptLogin, decryptLogin };
