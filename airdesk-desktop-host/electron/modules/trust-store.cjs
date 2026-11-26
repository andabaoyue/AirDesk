const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TRUST_TTL_OPTIONS = Object.freeze({
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  never: null,
});

function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const payload = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(tmpPath, 0o600);
  } catch {
    // Best-effort on platforms where POSIX mode bits are partial
  }
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best-effort on platforms where POSIX mode bits are partial
  }
}

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function normalizeTrustedTokenRecord(rec, nowTs = Date.now()) {
  const rawExpires = rec && rec.expiresAt;
  const expiresAt = rawExpires === null ? null : Number.isFinite(rawExpires) ? rawExpires : nowTs + TRUST_TTL_OPTIONS['7d'];
  return {
    mode: rec && rec.mode === 'full_control' ? 'full_control' : 'view_only',
    deviceLabel: String((rec && rec.deviceLabel) || '移动设备').slice(0, 64),
    platformHint: String((rec && rec.platformHint) || 'Mobile').slice(0, 32),
    ipMasked: String((rec && rec.ipMasked) || 'LAN').slice(0, 64),
    source: rec && rec.source === 'relay' ? 'relay' : 'lan',
    createdAt: rec && Number.isFinite(rec.createdAt) ? rec.createdAt : nowTs,
    lastSeenAt: rec && Number.isFinite(rec.lastSeenAt) ? rec.lastSeenAt : nowTs,
    expiresAt,
  };
}

function isRecordValid(rec, nowTs = Date.now()) {
  if (!rec) return false;
  if (rec.expiresAt === null) return true;
  return Number.isFinite(rec.expiresAt) && rec.expiresAt > nowTs;
}

function createTrustStore({ userDataDir, onTrustedDevicesChanged } = {}) {
  const identityPath = path.join(userDataDir, 'host-identity.json');
  const tokensPath = path.join(userDataDir, 'trusted-tokens.json');
  const settingsPath = path.join(userDataDir, 'host-settings.json');

  let cachedIdentity = null;
  let cachedSettings = null;
  let tokensMap = null;

  function notifyChanged() {
    if (typeof onTrustedDevicesChanged === 'function') {
      try {
        onTrustedDevicesChanged();
      } catch {}
    }
  }

  function getOrCreateHostIdentity() {
    if (cachedIdentity) return cachedIdentity;
    const raw = readJsonSafe(identityPath);
    if (
      raw &&
      typeof raw.hostId === 'string' &&
      /^[a-zA-Z0-9_-]{6,32}$/.test(raw.hostId) &&
      typeof raw.hostSecret === 'string' &&
      raw.hostSecret.length >= 32
    ) {
      cachedIdentity = {
        hostId: raw.hostId,
        hostSecret: raw.hostSecret,
        createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
      };
      return cachedIdentity;
    }
    const created = {
      hostId: String(crypto.randomInt(100000000, 1000000000)),
      hostSecret: crypto.randomBytes(32).toString('hex'),
      createdAt: Date.now(),
    };
    atomicWriteJson(identityPath, created);
    cachedIdentity = created;
    return cachedIdentity;
  }

  function normalizeSettings(raw) {
    const ttlOpt =
      raw && Object.prototype.hasOwnProperty.call(TRUST_TTL_OPTIONS, raw.trustTtlOption)
        ? raw.trustTtlOption
        : '7d';
    return {
      trustTtlOption: ttlOpt,
      autoStartOnBoot: Boolean(raw && raw.autoStartOnBoot),
      autoHostOnStartup: Boolean(raw && raw.autoHostOnStartup),
    };
  }

  function getHostSettings() {
    if (cachedSettings) return { ...cachedSettings };
    cachedSettings = normalizeSettings(readJsonSafe(settingsPath));
    return { ...cachedSettings };
  }

  function updateHostSettings(patch = {}) {
    const cur = getHostSettings();
    const next = normalizeSettings({
      trustTtlOption:
        patch.trustTtlOption !== undefined ? patch.trustTtlOption : cur.trustTtlOption,
      autoStartOnBoot:
        patch.autoStartOnBoot !== undefined ? patch.autoStartOnBoot : cur.autoStartOnBoot,
      autoHostOnStartup:
        patch.autoHostOnStartup !== undefined ? patch.autoHostOnStartup : cur.autoHostOnStartup,
    });
    cachedSettings = next;
    atomicWriteJson(settingsPath, next);
    return { ...next };
  }

  function computeExpiresAt(nowTs = Date.now()) {
    const settings = getHostSettings();
    const ttlMs = TRUST_TTL_OPTIONS[settings.trustTtlOption];
    if (ttlMs === null) return null;
    return nowTs + ttlMs;
  }

  function ensureTokensLoaded() {
    if (tokensMap) return tokensMap;
    tokensMap = new Map();
    const raw = readJsonSafe(tokensPath);
    const nowTs = Date.now();
    if (raw && typeof raw === 'object') {
      for (const [tok, rec] of Object.entries(raw)) {
        if (typeof tok === 'string' && tok.length >= 16 && rec && typeof rec === 'object') {
          const normalized = normalizeTrustedTokenRecord(rec, nowTs);
          if (isRecordValid(normalized, nowTs)) {
            tokensMap.set(tok, normalized);
          }
        }
      }
    }
    return tokensMap;
  }

  function persistTokens() {
    const map = ensureTokensLoaded();
    const out = {};
    const nowTs = Date.now();
    for (const [tok, rec] of map.entries()) {
      if (isRecordValid(rec, nowTs)) {
        out[tok] = normalizeTrustedTokenRecord(rec, nowTs);
      } else {
        map.delete(tok);
      }
    }
    atomicWriteJson(tokensPath, out);
  }

  function issueToken({
    mode = 'view_only',
    deviceLabel = '移动设备',
    platformHint = 'Mobile',
    ipMasked = 'LAN',
    source = 'lan',
  } = {}) {
    const map = ensureTokensLoaded();
    const nowTs = Date.now();
    const sessionToken = crypto.randomBytes(16).toString('hex');
    const record = normalizeTrustedTokenRecord(
      {
        mode: mode === 'full_control' ? 'full_control' : 'view_only',
        deviceLabel,
        platformHint,
        ipMasked,
        source,
        createdAt: nowTs,
        lastSeenAt: nowTs,
        expiresAt: computeExpiresAt(nowTs),
      },
      nowTs
    );
    map.set(sessionToken, record);
    persistTokens();
    notifyChanged();
    return { sessionToken, record: { ...record } };
  }

  function verifyAndTouchToken(token, { ipMasked, deviceLabel, platformHint } = {}) {
    if (typeof token !== 'string' || token.length < 16) {
      return { ok: false, reason: '自动重连凭证无效，请重新输入 6 位配对码' };
    }
    const map = ensureTokensLoaded();
    const rec = map.get(token);
    const nowTs = Date.now();
    if (!rec || !isRecordValid(rec, nowTs)) {
      if (rec) {
        map.delete(token);
        persistTokens();
        notifyChanged();
      }
      return { ok: false, reason: '自动重连凭证已过期或已被撤销，请重新输入 6 位配对码' };
    }
    rec.lastSeenAt = nowTs;
    rec.expiresAt = computeExpiresAt(nowTs);
    if (ipMasked) rec.ipMasked = String(ipMasked).slice(0, 64);
    if (deviceLabel) rec.deviceLabel = String(deviceLabel).slice(0, 64);
    if (platformHint) rec.platformHint = String(platformHint).slice(0, 32);
    persistTokens();
    notifyChanged();
    return { ok: true, mode: rec.mode, record: { ...rec } };
  }

  function getValidTokenRecord(token) {
    if (typeof token !== 'string' || token.length < 16) return null;
    const map = ensureTokensLoaded();
    const rec = map.get(token);
    const nowTs = Date.now();
    if (!rec || !isRecordValid(rec, nowTs)) {
      return null;
    }
    return { ...rec };
  }

  function updateTokenMode(token, nextMode) {
    if (nextMode !== 'full_control' && nextMode !== 'view_only') return false;
    if (typeof token !== 'string' || token.length < 16) return false;
    const map = ensureTokensLoaded();
    const rec = map.get(token);
    if (!rec || !isRecordValid(rec)) return false;
    rec.mode = nextMode;
    persistTokens();
    notifyChanged();
    return true;
  }

  function listTrustedDevices() {
    const map = ensureTokensLoaded();
    const nowTs = Date.now();
    const list = [];
    let pruned = false;
    for (const [tok, rec] of map.entries()) {
      if (!isRecordValid(rec, nowTs)) {
        map.delete(tok);
        pruned = true;
        continue;
      }
      list.push({
        tokenId: tok.slice(0, 10),
        mode: rec.mode || 'view_only',
        deviceLabel: rec.deviceLabel || '移动设备',
        platformHint: rec.platformHint || 'Mobile',
        ipMasked: rec.ipMasked || 'LAN',
        source: rec.source || 'lan',
        createdAt: rec.createdAt || nowTs,
        lastSeenAt: rec.lastSeenAt || nowTs,
        expiresAt: rec.expiresAt,
      });
    }
    if (pruned) persistTokens();
    list.sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
    return list;
  }

  function revokeToken(tokenPrefix) {
    if (!tokenPrefix || typeof tokenPrefix !== 'string' || tokenPrefix.length < 6) {
      return [];
    }
    const map = ensureTokensLoaded();
    const revoked = [];
    for (const tok of Array.from(map.keys())) {
      if (tok.startsWith(tokenPrefix)) {
        map.delete(tok);
        revoked.push(tok);
      }
    }
    if (revoked.length > 0) {
      persistTokens();
      notifyChanged();
    }
    return revoked;
  }

  function revokeAllTokens() {
    const map = ensureTokensLoaded();
    const hadAny = map.size > 0;
    map.clear();
    persistTokens();
    if (hadAny) notifyChanged();
    return hadAny;
  }

  return {
    TRUST_TTL_OPTIONS,
    getOrCreateHostIdentity,
    getHostSettings,
    updateHostSettings,
    issueToken,
    verifyAndTouchToken,
    getValidTokenRecord,
    updateTokenMode,
    listTrustedDevices,
    revokeToken,
    revokeAllTokens,
  };
}

module.exports = {
  TRUST_TTL_OPTIONS,
  createTrustStore,
};
