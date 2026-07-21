'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SAFE_MAGIC = Buffer.from('PCZ-SAFE-1\n');
const LOCAL_MAGIC = Buffer.from('PCZ-AES-1\n');

function privateWrite(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

function createTokenVault({ tokenDir, safeStorage, platform = process.platform, serverMode = false }) {
  fs.mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(tokenDir, 0o700); } catch {}

  const safeReady = () => {
    try {
      if (!safeStorage || !safeStorage.isEncryptionAvailable()) return false;
      if (platform === 'linux' && serverMode && safeStorage.getSelectedStorageBackend() === 'basic_text') return false;
      return true;
    } catch { return false; }
  };

  function localKey() {
    const file = path.join(tokenDir, 'server.key');
    if (!fs.existsSync(file)) privateWrite(file, crypto.randomBytes(32));
    const key = fs.readFileSync(file);
    if (key.length !== 32) throw new Error('chave local de login invalida');
    return key;
  }

  function localEncrypt(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', localKey(), iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([LOCAL_MAGIC, iv, cipher.getAuthTag(), encrypted]);
  }

  function localDecrypt(data) {
    const off = LOCAL_MAGIC.length;
    const iv = data.subarray(off, off + 12);
    const tag = data.subarray(off + 12, off + 28);
    const encrypted = data.subarray(off + 28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', localKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }

  function save(slot, value) {
    if (typeof value !== 'string' || value.length < 20) return false;
    const file = path.join(tokenDir, `token-acc${slot}.bin`);
    if (safeReady()) privateWrite(file, Buffer.concat([SAFE_MAGIC, safeStorage.encryptString(value)]));
    else if (serverMode) privateWrite(file, localEncrypt(value));
    else return false;
    return true;
  }

  function load(slot) {
    const file = path.join(tokenDir, `token-acc${slot}.bin`);
    if (!fs.existsSync(file)) return null;
    const data = fs.readFileSync(file);
    if (data.subarray(0, LOCAL_MAGIC.length).equals(LOCAL_MAGIC)) return localDecrypt(data);
    if (data.subarray(0, SAFE_MAGIC.length).equals(SAFE_MAGIC)) {
      if (!safeReady()) return null;
      return safeStorage.decryptString(data.subarray(SAFE_MAGIC.length));
    }
    // Compatibilidade com tokens das versoes anteriores, gravados sem cabecalho.
    if (safeReady()) return safeStorage.decryptString(data);
    return null;
  }

  function describe() {
    let selected = 'unavailable';
    try { if (platform === 'linux' && safeStorage) selected = safeStorage.getSelectedStorageBackend(); } catch {}
    return {
      mode: safeReady() ? 'os-safe-storage' : (serverMode ? 'local-aes-256-gcm' : 'unavailable'),
      selectedBackend: selected,
    };
  }

  return { save, load, describe };
}

module.exports = { createTokenVault };
