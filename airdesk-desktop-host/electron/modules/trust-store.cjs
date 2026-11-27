const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TRUST_TTL_OPTIONS = Object.freeze({
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  never: null,
});

const HOST_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const HOST_ID_LENGTH = 12;
const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_ATTEMPTS = 5;
const PASSWORD_LOCK_DURATION_MS = 5 * 60 * 1000;
const CHALLENGE_TTL_MS = 60 * 1000;
const MAX_ACTIVE_CHALLENGES = 16;
const SCRYPT_PARAMS = Object.freeze({ N: 16384, r: 8, p: 1, dkLen: 32 });

function generateHostId() {
  let out = '';
  for (let i = 0; i < HOST_ID_LENGTH; i += 1) {
    out += HOST_ID_ALPHABET[crypto.randomInt(0, HOST_ID_ALPHABET.length)];
  }
  return out;
}

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
  const securityPath = path.join(userDataDir, 'host-security.json');

  let cachedIdentity = null;
  let cachedSettings = null;
  let cachedSecurity = null;
  let tokensMap = null;
  const pendingChallenges = new Map();

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
      hostId: generateHostId(),
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
      enableLocalLanAlongsideRelay:
        raw && typeof raw.enableLocalLanAlongsideRelay === 'boolean'
          ? raw.enableLocalLanAlongsideRelay
          : true,
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
      enableLocalLanAlongsideRelay:
        patch.enableLocalLanAlongsideRelay !== undefined
          ? patch.enableLocalLanAlongsideRelay
          : cur.enableLocalLanAlongsideRelay,
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

  function ensureSecurityLoaded() {
    if (cachedSecurity) return cachedSecurity;
    const raw = readJsonSafe(securityPath);
    const hasHash =
      raw &&
      typeof raw.salt === 'string' &&
      /^[0-9a-f]{32}$/i.test(raw.salt) &&
      typeof raw.hash === 'string' &&
      /^[0-9a-f]{64}$/i.test(raw.hash);
    cachedSecurity = {
      salt: hasHash ? raw.salt : null,
      hash: hasHash ? raw.hash : null,
      failedAttempts: raw && Number.isFinite(raw.failedAttempts) ? Math.max(0, raw.failedAttempts) : 0,
      lockedUntilMs: raw && Number.isFinite(raw.lockedUntilMs) ? Math.max(0, raw.lockedUntilMs) : 0,
      updatedAt: raw && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
    };
    return cachedSecurity;
  }

  function persistSecurity() {
    const sec = ensureSecurityLoaded();
    atomicWriteJson(securityPath, sec);
  }

  function formatRemainingLock(remainingSec) {
    const mins = Math.floor(remainingSec / 60);
    const secs = remainingSec % 60;
    return mins > 0 ? `${mins} 分 ${secs} 秒` : `${secs} 秒`;
  }

  function getUnattendedPasswordStatus(nowTs = Date.now()) {
    const sec = ensureSecurityLoaded();
    const enabled = Boolean(sec.salt && sec.hash);
    const locked = enabled && sec.lockedUntilMs > nowTs;
    const remainingLockSec = locked ? Math.max(1, Math.ceil((sec.lockedUntilMs - nowTs) / 1000)) : 0;
    return {
      enabled,
      locked,
      lockedUntilMs: locked ? sec.lockedUntilMs : 0,
      remainingLockSec,
      failedAttempts: locked ? sec.failedAttempts : (sec.lockedUntilMs > 0 && nowTs >= sec.lockedUntilMs ? 0 : sec.failedAttempts),
      updatedAt: sec.updatedAt || 0,
    };
  }

  function setUnattendedPassword(password) {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      return { ok: false, message: `访问密码长度不能少于 ${MIN_PASSWORD_LENGTH} 位` };
    }
    if (password.length > 128) {
      return { ok: false, message: '访问密码长度不能超过 128 位' };
    }
    const saltBuf = crypto.randomBytes(16);
    const hashBuf = crypto.scryptSync(password, saltBuf, SCRYPT_PARAMS.dkLen, {
      N: SCRYPT_PARAMS.N,
      r: SCRYPT_PARAMS.r,
      p: SCRYPT_PARAMS.p,
    });
    cachedSecurity = {
      salt: saltBuf.toString('hex'),
      hash: hashBuf.toString('hex'),
      failedAttempts: 0,
      lockedUntilMs: 0,
      updatedAt: Date.now(),
    };
    persistSecurity();
    pendingChallenges.clear();
    return { ok: true, status: getUnattendedPasswordStatus() };
  }

  function clearUnattendedPassword() {
    cachedSecurity = {
      salt: null,
      hash: null,
      failedAttempts: 0,
      lockedUntilMs: 0,
      updatedAt: Date.now(),
    };
    persistSecurity();
    pendingChallenges.clear();
    return { ok: true, status: getUnattendedPasswordStatus() };
  }

  function createPasswordChallenge({ challengeId, nowTs = Date.now() } = {}) {
    const sec = ensureSecurityLoaded();
    if (!sec.salt || !sec.hash) {
      return {
        ok: false,
        code: 'PASSWORD_DISABLED',
        message: '目标电脑未开启无人值守访问密码',
      };
    }
    if (sec.lockedUntilMs > nowTs) {
      const remainingSec = Math.max(1, Math.ceil((sec.lockedUntilMs - nowTs) / 1000));
      return {
        ok: false,
        code: 'PASSWORD_LOCKED',
        lockedUntilMs: sec.lockedUntilMs,
        remainingSec,
        message: `访问密码错误次数过多，已锁定，请 ${formatRemainingLock(remainingSec)}后再试`,
      };
    }
    if (sec.lockedUntilMs > 0 && nowTs >= sec.lockedUntilMs) {
      sec.failedAttempts = 0;
      sec.lockedUntilMs = 0;
      persistSecurity();
    }
    for (const [cid, entry] of pendingChallenges.entries()) {
      if (entry.expiresAt <= nowTs) pendingChallenges.delete(cid);
    }
    while (pendingChallenges.size >= MAX_ACTIVE_CHALLENGES) {
      const oldest = pendingChallenges.keys().next().value;
      if (oldest !== undefined) pendingChallenges.delete(oldest);
      else break;
    }
    const id = typeof challengeId === 'string' && challengeId.length > 0 ? challengeId : crypto.randomUUID();
    const nonce = crypto.randomBytes(24).toString('hex');
    pendingChallenges.set(id, {
      nonce,
      expiresAt: nowTs + CHALLENGE_TTL_MS,
    });
    return {
      ok: true,
      challengeId: id,
      nonce,
      salt: sec.salt,
      kdf: 'scrypt',
      n: SCRYPT_PARAMS.N,
      r: SCRYPT_PARAMS.r,
      p: SCRYPT_PARAMS.p,
      dkLen: SCRYPT_PARAMS.dkLen,
    };
  }

  function verifyPasswordChallenge({
    challengeId,
    proof,
    deviceLabel = '远程移动设备',
    platformHint = 'Mobile',
    ipMasked = 'WAN',
    nowTs = Date.now(),
  } = {}) {
    const id = typeof challengeId === 'string' ? challengeId : '';
    const challenge = pendingChallenges.get(id);
    // Single-use nonce: always consume immediately regardless of pass/fail
    if (id) pendingChallenges.delete(id);

    const sec = ensureSecurityLoaded();
    if (!sec.salt || !sec.hash) {
      return {
        ok: false,
        code: 'PASSWORD_DISABLED',
        message: '目标电脑未开启无人值守访问密码',
      };
    }
    if (sec.lockedUntilMs > nowTs) {
      const remainingSec = Math.max(1, Math.ceil((sec.lockedUntilMs - nowTs) / 1000));
      return {
        ok: false,
        code: 'PASSWORD_LOCKED',
        lockedUntilMs: sec.lockedUntilMs,
        remainingSec,
        message: `访问密码错误次数过多，已锁定，请 ${formatRemainingLock(remainingSec)}后再试`,
      };
    }
    if (!challenge || challenge.expiresAt <= nowTs) {
      return {
        ok: false,
        code: 'CHALLENGE_EXPIRED',
        message: '密码验证挑战已过期，请重试',
      };
    }

    const identity = getOrCreateHostIdentity();
    const expected = crypto
      .createHmac('sha256', Buffer.from(sec.hash, 'hex'))
      .update(`airdesk-pw-v1:${identity.hostId}:${id}:${challenge.nonce}`)
      .digest();
    const proofBuf =
      typeof proof === 'string' && /^[0-9a-f]{64}$/i.test(proof)
        ? Buffer.from(proof, 'hex')
        : null;

    if (proofBuf && proofBuf.length === expected.length && crypto.timingSafeEqual(proofBuf, expected)) {
      sec.failedAttempts = 0;
      sec.lockedUntilMs = 0;
      persistSecurity();
      const issued = issueToken({
        mode: 'full_control',
        deviceLabel,
        platformHint,
        ipMasked,
        source: 'relay',
      });
      return {
        ok: true,
        sessionToken: issued.sessionToken,
        mode: 'full_control',
      };
    }

    if (sec.lockedUntilMs > 0 && nowTs >= sec.lockedUntilMs) {
      sec.failedAttempts = 0;
      sec.lockedUntilMs = 0;
    }
    sec.failedAttempts = (sec.failedAttempts || 0) + 1;
    if (sec.failedAttempts >= MAX_PASSWORD_ATTEMPTS) {
      sec.lockedUntilMs = nowTs + PASSWORD_LOCK_DURATION_MS;
      persistSecurity();
      const remainingSec = Math.ceil(PASSWORD_LOCK_DURATION_MS / 1000);
      return {
        ok: false,
        code: 'PASSWORD_LOCKED',
        lockedUntilMs: sec.lockedUntilMs,
        remainingSec,
        message: `访问密码连续错误 ${MAX_PASSWORD_ATTEMPTS} 次，已锁定 5 分钟`,
      };
    }
    persistSecurity();
    const remainingAttempts = MAX_PASSWORD_ATTEMPTS - sec.failedAttempts;
    return {
      ok: false,
      code: 'PASSWORD_INVALID',
      remainingAttempts,
      message: `访问密码错误（还剩 ${remainingAttempts} 次机会）`,
    };
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
    getUnattendedPasswordStatus,
    setUnattendedPassword,
    clearUnattendedPassword,
    createPasswordChallenge,
    verifyPasswordChallenge,
  };
}

module.exports = {
  TRUST_TTL_OPTIONS,
  createTrustStore,
};
