import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

const DEFAULT_STUN_URLS = [
  'stun:stun.miwifi.com:3478',
  'stun:stun.l.google.com:19302',
];
const PAIR_CODE_TTL_MS = 30 * 60 * 1000;
const TRUSTED_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_ATTEMPTS = 8;
const PROBE_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const PROBE_RATE_LIMIT_MAX = 20;
const MAX_PROBE_HOST_IDS = 16;
const MAX_IP_BUCKETS = 10000;
const MAX_HOST_REGISTRY = 10000;
const MAX_PENDING_VERIFIES_PER_ROOM = 4;
const VERIFY_TIMEOUT_MS = 10000;
const CHALLENGE_TIMEOUT_MS = 60000;
const HOST_ID_RE = /^[a-zA-Z0-9_-]{6,32}$/;

function safeEqualStrings(a, b) {
  const sa = String(a || '');
  const sb = String(b || '');
  if (!sa || !sb) return false;
  const ha = crypto.createHash('sha256').update(sa).digest();
  const hb = crypto.createHash('sha256').update(sb).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function splitCsv(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseIntSafe(val, fallback) {
  const n = Number.parseInt(String(val || ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function buildIceServersFromConfig(cfg = {}) {
  const stunUrls = splitCsv(cfg.stunUrls);
  const turnUrls = splitCsv(cfg.turnUrls);
  const turnSecret = String(cfg.turnSecret || '').trim();
  const turnUsername = String(cfg.turnUsername || '').trim();
  const turnCredential = String(cfg.turnCredential || '').trim();
  const turnTtlSec = parseIntSafe(cfg.turnTtlSec, 86400);

  const servers = [];
  const effectiveStuns = stunUrls.length > 0 ? stunUrls : DEFAULT_STUN_URLS;
  for (const u of effectiveStuns) {
    servers.push({ urls: u });
  }

  if (turnUrls.length > 0) {
    if (turnSecret) {
      const expiry = Math.floor(Date.now() / 1000) + turnTtlSec;
      const username = `${expiry}:airdesk`;
      const hmac = crypto.createHmac('sha1', turnSecret);
      hmac.update(username);
      const credential = hmac.digest('base64');
      servers.push({
        urls: turnUrls.length === 1 ? turnUrls[0] : turnUrls,
        username,
        credential,
      });
    } else if (turnUsername && turnCredential) {
      servers.push({
        urls: turnUrls.length === 1 ? turnUrls[0] : turnUrls,
        username: turnUsername,
        credential: turnCredential,
      });
    }
  }
  return servers;
}

function sendWs(ws, obj) {
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(obj));
  } catch {
    // Ignore transient closed socket write
  }
}

export function createRelayServer(options = {}) {
  const gracePeriodMs = parseIntSafe(options.gracePeriodMs, 20000);
  const probeRateLimitMax = parseIntSafe(options.probeRateLimitMax, PROBE_RATE_LIMIT_MAX);
  const probeRateLimitWindowMs = parseIntSafe(
    options.probeRateLimitWindowMs,
    PROBE_RATE_LIMIT_WINDOW_MS
  );
  const accessKey = String(
    options.accessKey !== undefined ? options.accessKey : (process.env.RELAY_ACCESS_KEY || '')
  ).trim();
  const trustProxy = Boolean(
    options.trustProxy !== undefined
      ? options.trustProxy
      : (process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true')
  );
  const iceConfig = {
    stunUrls: options.stunUrls !== undefined ? options.stunUrls : (process.env.STUN_URLS || ''),
    turnUrls: options.turnUrls !== undefined ? options.turnUrls : (process.env.TURN_URLS || ''),
    turnSecret: options.turnSecret !== undefined ? options.turnSecret : (process.env.TURN_SECRET || ''),
    turnUsername: options.turnUsername !== undefined ? options.turnUsername : (process.env.TURN_USERNAME || ''),
    turnCredential: options.turnCredential !== undefined ? options.turnCredential : (process.env.TURN_CREDENTIAL || ''),
    turnTtlSec: options.turnTtlSec !== undefined ? options.turnTtlSec : (process.env.TURN_TTL_SEC || 86400),
  };

  const startedAt = Date.now();
  const roomsByCode = new Map();
  const roomsByHostId = new Map();
  const socketRoom = new Map();
  const wsPendingChallenge = new WeakMap();
  const ipAttemptBuckets = new Map();
  const probeIpBuckets = new Map();

  function getIceServers() {
    return buildIceServersFromConfig(iceConfig);
  }

  function clearHostGraceTimer(room) {
    if (room && room.hostGraceTimer) {
      clearTimeout(room.hostGraceTimer);
      room.hostGraceTimer = null;
    }
  }

  function clearClientGraceTimer(room) {
    if (room && room.clientGraceTimer) {
      clearTimeout(room.clientGraceTimer);
      room.clientGraceTimer = null;
    }
  }

  function finalizeHostDisconnect(room, reason) {
    clearHostGraceTimer(room);
    if (room.hostWs && room.hostWs.readyState === 1) return;
    if (room.code) roomsByCode.delete(room.code);
    if (room.activeClientWs) {
      const activeWs = room.activeClientWs;
      room.activeClientWs = null;
      room.activeSessionToken = null;
      socketRoom.delete(activeWs);
      sendWs(activeWs, { type: 'session:closed', reason });
    }
    if (room.pendingClientWs) {
      const pendingWs = room.pendingClientWs;
      room.pendingClientWs = null;
      room.pendingClientMeta = null;
      socketRoom.delete(pendingWs);
      sendWs(pendingWs, { type: 'session:closed', reason });
    }
  }

  function finalizeClientDisconnect(room, reason) {
    clearClientGraceTimer(room);
    if (room.activeClientWs && room.activeClientWs.readyState === 1) return;
    room.activeClientWs = null;
    room.activeSessionToken = null;
    if (room.hostWs && room.hostWs.readyState === 1) {
      sendWs(room.hostWs, { type: 'host:client_disconnected', reason });
    }
  }

  function hasTurnConfigured() {
    const turnUrls = splitCsv(iceConfig.turnUrls);
    return turnUrls.length > 0 && (Boolean(iceConfig.turnSecret) || (Boolean(iceConfig.turnUsername) && Boolean(iceConfig.turnCredential)));
  }

  function genCode() {
    for (let i = 0; i < 16; i += 1) {
      const code = String(crypto.randomInt(100000, 1000000));
      if (!roomsByCode.has(code)) return code;
    }
    return String(crypto.randomInt(100000, 1000000));
  }

  function rotateCode(room, reason) {
    roomsByCode.delete(room.code);
    room.code = genCode();
    room.expiresAt = Date.now() + PAIR_CODE_TTL_MS;
    room.failedAttempts = 0;
    roomsByCode.set(room.code, room);
    sendWs(room.hostWs, {
      type: 'host:code_rotated',
      code: room.code,
      expiresAt: room.expiresAt,
      reason,
    });
  }

  function checkAndRecordIpFailure(ip) {
    const now = Date.now();
    let bucket = ipAttemptBuckets.get(ip);
    if (!bucket || now > bucket.resetAt) {
      if (!bucket && ipAttemptBuckets.size >= MAX_IP_BUCKETS) {
        const oldestKey = ipAttemptBuckets.keys().next().value;
        if (oldestKey !== undefined) ipAttemptBuckets.delete(oldestKey);
      }
      bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
      ipAttemptBuckets.set(ip, bucket);
    }
    bucket.count += 1;
    return bucket.count > RATE_LIMIT_MAX_ATTEMPTS;
  }

  function isIpRateLimited(ip) {
    const now = Date.now();
    const bucket = ipAttemptBuckets.get(ip);
    if (!bucket || now > bucket.resetAt) return false;
    return bucket.count >= RATE_LIMIT_MAX_ATTEMPTS;
  }

  function checkAndRecordProbeIp(ip) {
    const now = Date.now();
    let bucket = probeIpBuckets.get(ip);
    if (!bucket || now > bucket.resetAt) {
      if (!bucket && probeIpBuckets.size >= MAX_IP_BUCKETS) {
        const oldestKey = probeIpBuckets.keys().next().value;
        if (oldestKey !== undefined) probeIpBuckets.delete(oldestKey);
      }
      bucket = { count: 0, resetAt: now + probeRateLimitWindowMs };
      probeIpBuckets.set(ip, bucket);
    }
    bucket.count += 1;
    return bucket.count > probeRateLimitMax;
  }

  const server = http.createServer((req, res) => {
    const urlPath = (req.url || '/').split('?')[0];
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (urlPath === '/health') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(
        JSON.stringify({
          ok: true,
          service: 'airdesk-relay-server',
          version: '1.0.0',
          rooms: roomsByCode.size,
          uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
          hasTurn: hasTurnConfigured(),
          requiresAccessKey: Boolean(accessKey),
        })
      );
      return;
    }

    if (urlPath === '/api/ice') {
      if (accessKey) {
        const reqKey = String(req.headers['x-airdesk-access-key'] || '').trim();
        if (!safeEqualStrings(reqKey, accessKey)) {
          res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ ok: false, error: 'Unauthorized: valid X-AirDesk-Access-Key header required' }));
          return;
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, iceServers: getIceServers(), hasTurn: hasTurnConfigured() }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(
      '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>AirDesk Public Signaling Relay</title>' +
        '<style>body{margin:0;background:#0B0F14;color:#E2E8F0;font-family:system-ui,sans-serif;padding:28px;line-height:1.6;}' +
        '.card{max-width:640px;margin:0 auto;background:#131922;border:1px solid #1E293B;border-radius:14px;padding:22px;}' +
        'code{background:#0B0F14;padding:2px 7px;border-radius:6px;color:#60A5FA;}</style></head><body>' +
        '<div class="card"><h2 style="margin-top:0;">AirDesk 公网信令服务运行中</h2>' +
        '<p>WebSocket 信令路径：<code>/ws/signaling</code> · 健康检查：<code>/health</code> · ICE 接口：<code>/api/ice</code></p>' +
        '<p>请在电脑端选择「<b>自定义远程 WSS 信令</b>」填入本服务 HTTPS 地址，然后在 AirDesk Android 端「<b>公网中继远程连接</b>」输入同地址与 6 位配对码即可跨网操控。</p>' +
        '</div></body></html>'
    );
  });

  const wss = new WebSocketServer({ server, path: '/ws/signaling', maxPayload: 256 * 1024 });

  const maintenanceTimer = setInterval(() => {
    const now = Date.now();
    for (const room of new Set(roomsByCode.values())) {
      if (room.hostWs && room.hostWs.readyState === 1 && !room.activeClientWs && !room.pendingClientWs && now >= room.expiresAt) {
        rotateCode(room, 'ttl_expired');
      }
      if (room.pendingVerifies && room.pendingVerifies.size > 0) {
        for (const [verifyId, pending] of room.pendingVerifies.entries()) {
          if (now - pending.createdAt > VERIFY_TIMEOUT_MS) {
            room.pendingVerifies.delete(verifyId);
            if (pending.ws && pending.ws.readyState === 1) {
              sendWs(pending.ws, {
                type: 'error',
                code: 'HOST_OFFLINE',
                retryable: true,
                message: '电脑端验证超时，请稍后重试',
              });
            }
          }
        }
      }
      if (room.pendingChallenges && room.pendingChallenges.size > 0) {
        for (const [cid, pending] of room.pendingChallenges.entries()) {
          if (now - pending.createdAt > CHALLENGE_TIMEOUT_MS) {
            room.pendingChallenges.delete(cid);
            if (pending.ws) wsPendingChallenge.delete(pending.ws);
            if (pending.ws && pending.ws.readyState === 1) {
              sendWs(pending.ws, {
                type: 'error',
                code: 'CHALLENGE_EXPIRED',
                message: '密码验证超时，请重试',
              });
            }
          }
        }
      }
    }
    for (const [ip, bucket] of ipAttemptBuckets.entries()) {
      if (now > bucket.resetAt) ipAttemptBuckets.delete(ip);
    }
    for (const [ip, bucket] of probeIpBuckets.entries()) {
      if (now > bucket.resetAt) probeIpBuckets.delete(ip);
    }
  }, 5000);

  wss.on('connection', (ws, req) => {
    const xff = trustProxy ? req.headers['x-forwarded-for'] : null;
    const rawIp =
      (typeof xff === 'string' && xff.split(',')[0].trim()) ||
      (req.socket && req.socket.remoteAddress) ||
      'WAN';
    const maskedIp = rawIp.replace(/^::ffff:/, '');

    ws.isAlive = true;
    ws.lastActivityAt = Date.now();
    ws.on('pong', () => {
      ws.isAlive = true;
      ws.lastActivityAt = Date.now();
    });

    ws.on('message', (raw) => {
      ws.isAlive = true;
      ws.lastActivityAt = Date.now();
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }

      if (msg.type === 'ws:ping') {
        ws.isAlive = true;
        sendWs(ws, { type: 'ws:pong', ts: msg.ts });
        return;
      }

      if (msg.type === 'client:probe_hosts') {
        if (checkAndRecordProbeIp(maskedIp)) {
          sendWs(ws, {
            type: 'error',
            code: 'PROBE_RATE_LIMITED',
            retryable: true,
            message: '探活请求过于频繁，请稍后再试',
          });
          return;
        }
        const rawIds = Array.isArray(msg.hostIds) ? msg.hostIds : [];
        const uniqueIds = [];
        const seen = new Set();
        for (const item of rawIds) {
          if (typeof item !== 'string') continue;
          const id = item.trim();
          if (!HOST_ID_RE.test(id) || seen.has(id)) continue;
          seen.add(id);
          uniqueIds.push(id);
          if (uniqueIds.length >= MAX_PROBE_HOST_IDS) break;
        }
        const hosts = {};
        for (const id of uniqueIds) {
          const room = roomsByHostId.get(id);
          const online = Boolean(room && room.hostWs && room.hostWs.readyState === 1);
          const busy = online && Boolean(room.activeClientWs && room.activeClientWs.readyState === 1);
          hosts[id] = { online, busy };
        }
        sendWs(ws, { type: 'client:hosts_status', hosts });
        return;
      }

      if (msg.type === 'host:create') {
        if (isIpRateLimited(maskedIp)) {
          sendWs(ws, { type: 'error', message: '尝试次数过多，请 1 分钟后再试' });
          try {
            ws.close(4029, 'rate limited');
          } catch {}
          return;
        }
        if (accessKey && !safeEqualStrings(String(msg.accessKey || '').trim(), accessKey)) {
          checkAndRecordIpFailure(maskedIp);
          sendWs(ws, { type: 'error', message: '中继访问密钥错误，请联系服务器管理员确认 RELAY_ACCESS_KEY' });
          try {
            ws.close(4003, 'invalid access key');
          } catch {}
          return;
        }
        const hostId = typeof msg.hostId === 'string' ? msg.hostId.trim() : '';
        const hostSecret = typeof msg.hostSecret === 'string' ? msg.hostSecret.trim() : '';
        const protoVersion = Number(msg.protoVersion) >= 2 ? 2 : 1;

        if (hostId) {
          if (!HOST_ID_RE.test(hostId) || hostSecret.length < 16) {
            checkAndRecordIpFailure(maskedIp);
            sendWs(ws, { type: 'error', message: '无效的 hostId 或 hostSecret 格式' });
            try {
              ws.close(4003, 'invalid host identity');
            } catch {}
            return;
          }
          const existing = roomsByHostId.get(hostId);
          if (existing) {
            if (!safeEqualStrings(existing.hostSecret, hostSecret)) {
              checkAndRecordIpFailure(maskedIp);
              sendWs(ws, { type: 'error', message: '主机身份密钥校验失败，拒绝认领该 hostId' });
              try {
                ws.close(4003, 'invalid host secret');
              } catch {}
              return;
            }
            clearHostGraceTimer(existing);
            const prevMeta = socketRoom.get(ws);
            if (prevMeta && prevMeta.room && prevMeta.room !== existing) {
              if (prevMeta.room.code) roomsByCode.delete(prevMeta.room.code);
              socketRoom.delete(ws);
            }
            if (existing.code) roomsByCode.delete(existing.code);
            if (existing.hostWs && existing.hostWs !== ws) {
              const oldHostWs = existing.hostWs;
              existing.hostWs = null;
              socketRoom.delete(oldHostWs);
              try {
                oldHostWs.close(4000, 'reclaimed');
              } catch {}
            }
            if (existing.pendingClientWs) {
              const oldPending = existing.pendingClientWs;
              existing.pendingClientWs = null;
              existing.pendingClientMeta = null;
              socketRoom.delete(oldPending);
              sendWs(oldPending, { type: 'session:closed', reason: '电脑端正在重新上线' });
            }
            if (existing.pendingVerifies) {
              for (const pending of existing.pendingVerifies.values()) {
                if (pending.ws && pending.ws.readyState === 1) {
                  sendWs(pending.ws, {
                    type: 'error',
                    code: 'HOST_OFFLINE',
                    retryable: true,
                    message: '目标电脑正在重新上线，请稍后重试',
                  });
                }
              }
              existing.pendingVerifies.clear();
            }
            if (existing.pendingChallenges) {
              for (const pending of existing.pendingChallenges.values()) {
                if (pending.ws) wsPendingChallenge.delete(pending.ws);
                if (pending.ws && pending.ws.readyState === 1) {
                  sendWs(pending.ws, {
                    type: 'error',
                    code: 'HOST_OFFLINE',
                    retryable: true,
                    message: '目标电脑正在重新上线，请稍后重试',
                  });
                }
              }
              existing.pendingChallenges.clear();
            }

            if (msg.resumeIfActive === true && existing.activeClientWs && existing.activeClientWs.readyState === 1) {
              const resumedCode = genCode();
              existing.code = resumedCode;
              existing.expiresAt = Date.now() + PAIR_CODE_TTL_MS;
              existing.hostWs = ws;
              existing.protoVersion = Math.max(2, protoVersion);
              existing.hostLabel = String(msg.hostLabel || existing.hostLabel || 'AirDesk Desktop').slice(0, 64);
              existing.audioEnabled = Boolean(msg.audioEnabled);
              existing.failedAttempts = 0;
              roomsByCode.set(resumedCode, existing);
              roomsByHostId.delete(hostId);
              roomsByHostId.set(hostId, existing);
              socketRoom.set(ws, { room: existing, role: 'host' });
              sendWs(existing.activeClientWs, { type: 'session:signaling_resumed', role: 'host' });
              sendWs(ws, {
                type: 'host:created',
                code: resumedCode,
                expiresAt: existing.expiresAt,
                iceServers: getIceServers(),
                hostId,
                protoVersion: existing.protoVersion,
                resumedActiveClient: true,
              });
              return;
            }

            clearClientGraceTimer(existing);
            if (existing.activeClientWs) {
              const oldClient = existing.activeClientWs;
              existing.activeClientWs = null;
              socketRoom.delete(oldClient);
              sendWs(oldClient, { type: 'session:closed', reason: '电脑端正在重新上线' });
            }
          } else if (roomsByHostId.size >= MAX_HOST_REGISTRY) {
            let evictKey = null;
            for (const [k, r] of roomsByHostId.entries()) {
              if (!r.hostWs) {
                evictKey = k;
                break;
              }
            }
            if (evictKey === null) evictKey = roomsByHostId.keys().next().value;
            if (evictKey !== undefined) roomsByHostId.delete(evictKey);
          }
        }

        const prevMeta = socketRoom.get(ws);
        if (prevMeta && prevMeta.room) {
          roomsByCode.delete(prevMeta.room.code);
          socketRoom.delete(ws);
        }
        const code = genCode();
        const room = {
          code,
          expiresAt: Date.now() + PAIR_CODE_TTL_MS,
          hostWs: ws,
          hostId: hostId || null,
          hostSecret: hostId ? hostSecret : null,
          protoVersion: hostId ? Math.max(2, protoVersion) : 1,
          hostLabel: String(msg.hostLabel || 'AirDesk Desktop').slice(0, 64),
          audioEnabled: Boolean(msg.audioEnabled),
          pendingClientWs: null,
          pendingClientMeta: null,
          pendingVerifies: new Map(),
          pendingChallenges: new Map(),
          activeClientWs: null,
          activeSessionToken: null,
          hostGraceTimer: null,
          clientGraceTimer: null,
          failedAttempts: 0,
          trustedTokens: hostId ? null : new Map(),
        };
        roomsByCode.set(code, room);
        if (hostId) {
          roomsByHostId.delete(hostId);
          roomsByHostId.set(hostId, room);
        }
        socketRoom.set(ws, { room, role: 'host' });
        const createdReply = {
          type: 'host:created',
          code,
          expiresAt: room.expiresAt,
          iceServers: getIceServers(),
        };
        if (hostId) {
          createdReply.hostId = hostId;
          createdReply.protoVersion = room.protoVersion;
        }
        sendWs(ws, createdReply);
        return;
      }

      if (msg.type === 'client:join') {
        if (isIpRateLimited(maskedIp)) {
          sendWs(ws, { type: 'error', message: '尝试次数过多，请 1 分钟后再试' });
          return;
        }
        const targetHostId = typeof msg.hostId === 'string' ? msg.hostId.trim() : '';
        if (msg.authMode === 'password') {
          if (!targetHostId || !HOST_ID_RE.test(targetHostId)) {
            checkAndRecordIpFailure(maskedIp);
            sendWs(ws, { type: 'error', code: 'INVALID_HOST_ID', message: '请输入有效的主机 ID' });
            return;
          }
          const room = roomsByHostId.get(targetHostId);
          if (!room || !room.hostWs || room.hostWs.readyState !== 1) {
            sendWs(ws, {
              type: 'error',
              code: 'HOST_OFFLINE',
              retryable: true,
              message: '目标电脑暂不在线（等待恢复）',
            });
            return;
          }
          for (const [cid, pending] of room.pendingChallenges.entries()) {
            if (!pending.ws || pending.ws.readyState !== 1) {
              room.pendingChallenges.delete(cid);
              if (pending.ws) wsPendingChallenge.delete(pending.ws);
            }
          }
          if (room.pendingChallenges.size >= MAX_PENDING_VERIFIES_PER_ROOM) {
            sendWs(ws, {
              type: 'error',
              retryable: true,
              message: '电脑端正在处理过多验证请求，请稍后再试',
            });
            return;
          }
          const prevChal = wsPendingChallenge.get(ws);
          if (prevChal && prevChal.room && prevChal.room.pendingChallenges) {
            prevChal.room.pendingChallenges.delete(prevChal.challengeId);
          }
          const challengeId = crypto.randomUUID();
          const clientMeta = {
            deviceLabel: String(msg.deviceLabel || '远程移动设备').slice(0, 64),
            platformHint: String(msg.platformHint || 'Mobile').slice(0, 32),
            ipMasked: maskedIp,
          };
          room.pendingChallenges.set(challengeId, {
            ws,
            deviceLabel: clientMeta.deviceLabel,
            platformHint: clientMeta.platformHint,
            ipMasked: maskedIp,
            createdAt: Date.now(),
            nonceIssued: false,
            responseSent: false,
          });
          wsPendingChallenge.set(ws, { room, challengeId });
          ws.once('close', () => {
            room.pendingChallenges.delete(challengeId);
            wsPendingChallenge.delete(ws);
          });
          sendWs(room.hostWs, {
            type: 'host:password_challenge_request',
            challengeId,
            client: clientMeta,
          });
          return;
        }
        if (typeof msg.sessionToken === 'string' && msg.sessionToken.length >= 16 && targetHostId) {
          const room = roomsByHostId.get(targetHostId);
          if (!room || !room.hostWs || room.hostWs.readyState !== 1) {
            sendWs(ws, {
              type: 'error',
              code: 'HOST_OFFLINE',
              retryable: true,
              message: '目标电脑暂不在线（等待恢复）',
            });
            return;
          }
          for (const [vid, pending] of room.pendingVerifies.entries()) {
            if (!pending.ws || pending.ws.readyState !== 1) {
              room.pendingVerifies.delete(vid);
            }
          }
          if (room.pendingVerifies.size >= MAX_PENDING_VERIFIES_PER_ROOM) {
            sendWs(ws, {
              type: 'error',
              retryable: true,
              message: '电脑端正在处理过多验证请求，请稍后再试',
            });
            return;
          }
          const verifyId = crypto.randomUUID();
          const attachExisting = msg.attachExisting === true;
          const clientMeta = {
            deviceLabel: String(msg.deviceLabel || '远程移动设备').slice(0, 64),
            platformHint: String(msg.platformHint || 'Mobile').slice(0, 32),
            ipMasked: maskedIp,
          };
          room.pendingVerifies.set(verifyId, {
            ws,
            sessionToken: msg.sessionToken,
            attachExisting,
            deviceLabel: clientMeta.deviceLabel,
            platformHint: clientMeta.platformHint,
            ipMasked: maskedIp,
            createdAt: Date.now(),
          });
          ws.once('close', () => {
            room.pendingVerifies.delete(verifyId);
          });
          sendWs(room.hostWs, {
            type: 'host:verify_token',
            verifyId,
            sessionToken: msg.sessionToken,
            attachExisting,
            client: clientMeta,
          });
          return;
        }
        if (typeof msg.sessionToken === 'string' && msg.sessionToken.length >= 16) {
          let matchedRoom = null;
          let tokenRecord = null;
          const nowTs = Date.now();
          for (const candidateRoom of new Set(roomsByCode.values())) {
            const rec = candidateRoom.trustedTokens && candidateRoom.trustedTokens.get(msg.sessionToken);
            if (rec && rec.expiresAt > nowTs) {
              matchedRoom = candidateRoom;
              tokenRecord = rec;
              break;
            }
          }
          if (!matchedRoom || !tokenRecord) {
            checkAndRecordIpFailure(maskedIp);
            sendWs(ws, {
              type: 'error',
              code: 'TOKEN_INVALID',
              message: '自动重连凭证已过期，请重新输入 6 位配对码',
            });
            return;
          }
          if (matchedRoom.activeClientWs && matchedRoom.activeClientWs !== ws) {
            const staleWs = matchedRoom.activeClientWs;
            matchedRoom.activeClientWs = null;
            socketRoom.delete(staleWs);
            try {
              staleWs.close();
            } catch {}
          }
          matchedRoom.activeClientWs = ws;
          matchedRoom.activeSessionToken = msg.sessionToken;
          socketRoom.set(ws, { room: matchedRoom, role: 'client' });
          tokenRecord.expiresAt = nowTs + TRUSTED_TOKEN_TTL_MS;
          tokenRecord.lastSeenAt = nowTs;
          tokenRecord.ipMasked = maskedIp;
          if (msg.deviceLabel) tokenRecord.deviceLabel = String(msg.deviceLabel).slice(0, 64);
          if (msg.platformHint) tokenRecord.platformHint = String(msg.platformHint).slice(0, 32);

          const iceServers = getIceServers();
          sendWs(ws, {
            type: 'client:approved',
            mode: tokenRecord.mode,
            hostLabel: matchedRoom.hostLabel,
            audioEnabled: Boolean(matchedRoom.audioEnabled),
            sessionToken: msg.sessionToken,
            iceServers,
            reconnected: true,
          });
          sendWs(matchedRoom.hostWs, {
            type: 'host:client_reconnected',
            mode: tokenRecord.mode,
            deviceLabel: tokenRecord.deviceLabel,
            ipMasked: maskedIp,
          });
          return;
        }

        const clean = String(msg.code || '').replace(/\D/g, '');
        const room = roomsByCode.get(clean);
        if (!room) {
          checkAndRecordIpFailure(maskedIp);
          sendWs(ws, { type: 'error', message: '配对码无效或已过期，请核对电脑端最新 6 位码' });
          return;
        }

        if (Date.now() > room.expiresAt) {
          rotateCode(room, 'ttl_expired');
          sendWs(ws, { type: 'error', message: '配对码已过期，请使用电脑端最新 6 位码' });
          return;
        }

        if (room.activeClientWs || room.pendingClientWs) {
          sendWs(ws, { type: 'error', message: '该电脑当前已有设备正在连接' });
          return;
        }

        room.failedAttempts = 0;
        room.pendingClientWs = ws;
        room.pendingClientMeta = {
          deviceLabel: String(msg.deviceLabel || '远程移动设备').slice(0, 64),
          platformHint: String(msg.platformHint || 'Mobile').slice(0, 32),
          ipMasked: maskedIp,
        };
        socketRoom.set(ws, { room, role: 'client' });
        sendWs(ws, { type: 'client:waiting_approval', hostLabel: room.hostLabel });
        sendWs(room.hostWs, {
          type: 'host:approval_request',
          client: {
            clientId: crypto.randomUUID(),
            deviceLabel: room.pendingClientMeta.deviceLabel,
            platformHint: room.pendingClientMeta.platformHint,
            ipMasked: maskedIp,
            requestedAt: Date.now(),
          },
        });
        return;
      }

      if (msg.type === 'client:password_response') {
        const entry = wsPendingChallenge.get(ws);
        if (!entry || !entry.room || !entry.room.pendingChallenges) return;
        if (msg.challengeId !== entry.challengeId) return;
        const pending = entry.room.pendingChallenges.get(entry.challengeId);
        if (!pending || pending.ws !== ws || !pending.nonceIssued || pending.responseSent) return;
        pending.responseSent = true;
        if (!entry.room.hostWs || entry.room.hostWs.readyState !== 1) {
          entry.room.pendingChallenges.delete(entry.challengeId);
          wsPendingChallenge.delete(ws);
          sendWs(ws, {
            type: 'error',
            code: 'HOST_OFFLINE',
            retryable: true,
            message: '目标电脑暂不在线（等待恢复）',
          });
          return;
        }
        sendWs(entry.room.hostWs, {
          type: 'host:password_verify',
          challengeId: entry.challengeId,
          proof: typeof msg.proof === 'string' ? msg.proof : '',
          client: {
            deviceLabel: pending.deviceLabel,
            platformHint: pending.platformHint,
            ipMasked: pending.ipMasked,
          },
        });
        return;
      }

      const meta = socketRoom.get(ws);
      if (!meta) return;
      const { room, role } = meta;

      if (role === 'host' && msg.type === 'host:update_config') {
        if (typeof msg.audioEnabled === 'boolean') {
          room.audioEnabled = msg.audioEnabled;
        }
        if (msg.activeMode === 'full_control' || msg.activeMode === 'view_only') {
          if (room.trustedTokens && room.activeSessionToken && room.trustedTokens.has(room.activeSessionToken)) {
            room.trustedTokens.get(room.activeSessionToken).mode = msg.activeMode;
          }
        }
        if (msg.revokeAllTokens === true) {
          if (room.trustedTokens) room.trustedTokens.clear();
          room.activeSessionToken = null;
        }
        return;
      }

      if (role === 'host' && msg.type === 'host:password_challenge_reply') {
        const challengeId = typeof msg.challengeId === 'string' ? msg.challengeId : '';
        const pending = room.pendingChallenges && room.pendingChallenges.get(challengeId);
        if (!pending) return;
        if (!pending.ws || pending.ws.readyState !== 1) {
          room.pendingChallenges.delete(challengeId);
          wsPendingChallenge.delete(pending.ws);
          return;
        }
        if (msg.ok !== true) {
          room.pendingChallenges.delete(challengeId);
          wsPendingChallenge.delete(pending.ws);
          if (msg.code === 'PASSWORD_LOCKED' || msg.code === 'PASSWORD_DISABLED') {
            checkAndRecordIpFailure(pending.ipMasked);
          }
          sendWs(pending.ws, {
            type: 'error',
            code: msg.code || 'PASSWORD_AUTH_UNAVAILABLE',
            message: msg.message || '无法发起访问密码验证',
          });
          return;
        }
        pending.nonceIssued = true;
        pending.responseSent = false;
        sendWs(pending.ws, {
          type: 'client:password_challenge',
          challengeId,
          hostId: room.hostId,
          hostLabel: room.hostLabel,
          nonce: msg.nonce,
          salt: msg.salt,
          kdf: msg.kdf || 'scrypt',
          n: msg.n || 16384,
          r: msg.r || 8,
          p: msg.p || 1,
          dkLen: msg.dkLen || 32,
        });
        return;
      }

      if (role === 'host' && msg.type === 'host:password_verified') {
        const challengeId = typeof msg.challengeId === 'string' ? msg.challengeId : '';
        const pending = room.pendingChallenges && room.pendingChallenges.get(challengeId);
        if (!pending) return;
        room.pendingChallenges.delete(challengeId);
        wsPendingChallenge.delete(pending.ws);
        if (!pending.ws || pending.ws.readyState !== 1) return;

        if (msg.approved !== true) {
          checkAndRecordIpFailure(pending.ipMasked);
          sendWs(pending.ws, {
            type: 'error',
            code: msg.code || 'PASSWORD_INVALID',
            message: msg.message || '访问密码校验失败',
          });
          return;
        }

        // Only kick previous active client after password approval and confirmed OPEN socket
        if (room.activeClientWs && room.activeClientWs !== pending.ws) {
          const staleWs = room.activeClientWs;
          room.activeClientWs = null;
          socketRoom.delete(staleWs);
          try {
            staleWs.close();
          } catch {}
        }
        room.activeClientWs = pending.ws;
        room.activeSessionToken = msg.sessionToken || null;
        socketRoom.set(pending.ws, { room, role: 'client' });

        const approvedMode = msg.mode === 'full_control' ? 'full_control' : 'view_only';
        const approvedPayload = {
          type: 'client:approved',
          mode: approvedMode,
          hostLabel: room.hostLabel,
          audioEnabled: Boolean(room.audioEnabled),
          sessionToken: msg.sessionToken,
          iceServers: getIceServers(),
        };
        if (room.hostId) approvedPayload.hostId = room.hostId;
        sendWs(pending.ws, approvedPayload);
        sendWs(room.hostWs, {
          type: 'host:client_reconnected',
          mode: approvedMode,
          deviceLabel: pending.deviceLabel,
          ipMasked: pending.ipMasked,
        });
        return;
      }

      if (role === 'host' && msg.type === 'host:token_verified') {
        const verifyId = typeof msg.verifyId === 'string' ? msg.verifyId : '';
        const pending = room.pendingVerifies && room.pendingVerifies.get(verifyId);
        if (!pending) return;
        room.pendingVerifies.delete(verifyId);
        if (!pending.ws || pending.ws.readyState !== 1) return;

        if (msg.approved !== true) {
          checkAndRecordIpFailure(pending.ipMasked);
          sendWs(pending.ws, {
            type: 'error',
            code: 'TOKEN_INVALID',
            message: msg.reason || '自动重连凭证已过期或已被撤销，请重新输入 6 位配对码',
          });
          return;
        }

        clearClientGraceTimer(room);
        const isReattach = Boolean(pending.attachExisting && msg.reattached === true);
        if (room.activeClientWs && room.activeClientWs !== pending.ws) {
          const staleWs = room.activeClientWs;
          room.activeClientWs = null;
          socketRoom.delete(staleWs);
          if (!isReattach) {
            sendWs(staleWs, { type: 'session:closed', reason: '另一台已信任设备已接管连接' });
          }
          try {
            staleWs.close();
          } catch {}
        }
        room.activeClientWs = pending.ws;
        room.activeSessionToken = pending.sessionToken;
        socketRoom.set(pending.ws, { room, role: 'client' });

        const approvedMode = msg.mode === 'full_control' ? 'full_control' : 'view_only';
        const approvedPayload = {
          type: 'client:approved',
          mode: approvedMode,
          hostLabel: room.hostLabel,
          audioEnabled: Boolean(room.audioEnabled),
          sessionToken: pending.sessionToken,
          iceServers: getIceServers(),
          reconnected: true,
          reattached: isReattach,
        };
        if (room.hostId) approvedPayload.hostId = room.hostId;
        sendWs(pending.ws, approvedPayload);
        sendWs(room.hostWs, {
          type: isReattach ? 'host:client_reattached' : 'host:client_reconnected',
          mode: approvedMode,
          deviceLabel: pending.deviceLabel,
          ipMasked: pending.ipMasked,
        });
        return;
      }

      if (role === 'host' && msg.type === 'host:approval_decision') {
        const pending = room.pendingClientWs;
        const pendingMeta = room.pendingClientMeta || {};
        room.pendingClientWs = null;
        room.pendingClientMeta = null;
        if (!pending) return;

        if (!msg.approved) {
          sendWs(pending, { type: 'client:rejected', reason: '电脑端已拒绝本次连接请求' });
          socketRoom.delete(pending);
          return;
        }

        room.activeClientWs = pending;
        const approvedMode = msg.mode || 'view_only';
        const sessionToken =
          typeof msg.sessionToken === 'string' && msg.sessionToken.length >= 16
            ? msg.sessionToken
            : crypto.randomBytes(16).toString('hex');
        room.activeSessionToken = sessionToken;
        if (room.trustedTokens) {
          const nowTs = Date.now();
          room.trustedTokens.set(sessionToken, {
            mode: approvedMode,
            deviceLabel: pendingMeta.deviceLabel || '远程移动设备',
            platformHint: pendingMeta.platformHint || 'Mobile',
            ipMasked: pendingMeta.ipMasked || 'WAN',
            createdAt: nowTs,
            lastSeenAt: nowTs,
            expiresAt: nowTs + TRUSTED_TOKEN_TTL_MS,
          });
        }

        const approvedPayload = {
          type: 'client:approved',
          mode: approvedMode,
          hostLabel: room.hostLabel,
          audioEnabled: Boolean(room.audioEnabled),
          sessionToken,
          iceServers: getIceServers(),
        };
        if (room.hostId) approvedPayload.hostId = room.hostId;
        sendWs(pending, approvedPayload);
        return;
      }

      if (role === 'host' && msg.type === 'host:emergency_stop') {
        if (room.trustedTokens) room.trustedTokens.clear();
        room.activeSessionToken = null;
        if (room.activeClientWs) {
          sendWs(room.activeClientWs, {
            type: 'session:permission_updated',
            controlEnabled: false,
            reason: '电脑端已触发物理急停 (Ctrl+Alt+Esc)，已切换至只读观看模式',
          });
        }
        return;
      }

      if (msg.type === 'rtc:offer' || msg.type === 'rtc:answer' || msg.type === 'rtc:ice') {
        const peer = role === 'host' ? room.activeClientWs : room.hostWs;
        if (peer) sendWs(peer, msg);
        return;
      }

      if (msg.type === 'session:close') {
        clearHostGraceTimer(room);
        clearClientGraceTimer(room);
        const peer = role === 'host' ? room.activeClientWs || room.pendingClientWs : room.hostWs;
        if (peer) {
          sendWs(peer, {
            type: role === 'host' ? 'session:closed' : 'host:client_disconnected',
            reason: msg.reason || '对方已断开连接',
          });
        }
        if (role === 'host') {
          if (room.activeClientWs) {
            const activeWs = room.activeClientWs;
            room.activeClientWs = null;
            room.activeSessionToken = null;
            socketRoom.delete(activeWs);
            try {
              activeWs.close();
            } catch {}
          }
          if (room.pendingClientWs) {
            const pendingWs = room.pendingClientWs;
            room.pendingClientWs = null;
            room.pendingClientMeta = null;
            socketRoom.delete(pendingWs);
            try {
              pendingWs.close();
            } catch {}
          }
        } else {
          if (room.activeClientWs === ws) {
            room.activeClientWs = null;
            room.activeSessionToken = null;
          }
          if (room.pendingClientWs === ws) {
            room.pendingClientWs = null;
            room.pendingClientMeta = null;
          }
          socketRoom.delete(ws);
        }
      }
    });

    ws.on('close', () => {
      const meta = socketRoom.get(ws);
      if (!meta) return;
      socketRoom.delete(ws);
      const { room, role } = meta;
      if (role === 'host') {
        if (room.hostWs !== ws) return;
        room.hostWs = null;
        if (room.code) roomsByCode.delete(room.code);
        if (room.pendingClientWs) {
          const pendingWs = room.pendingClientWs;
          room.pendingClientWs = null;
          room.pendingClientMeta = null;
          socketRoom.delete(pendingWs);
          sendWs(pendingWs, { type: 'session:closed', reason: '电脑端已关闭共享' });
        }
        if (room.pendingVerifies && room.pendingVerifies.size > 0) {
          for (const pending of room.pendingVerifies.values()) {
            if (pending.ws && pending.ws.readyState === 1) {
              sendWs(pending.ws, {
                type: 'error',
                code: 'HOST_OFFLINE',
                retryable: true,
                message: '目标电脑暂不在线（等待恢复）',
              });
            }
          }
          room.pendingVerifies.clear();
        }
        if (room.pendingChallenges && room.pendingChallenges.size > 0) {
          for (const pending of room.pendingChallenges.values()) {
            if (pending.ws) wsPendingChallenge.delete(pending.ws);
            if (pending.ws && pending.ws.readyState === 1) {
              sendWs(pending.ws, {
                type: 'error',
                code: 'HOST_OFFLINE',
                retryable: true,
                message: '目标电脑暂不在线（等待恢复）',
              });
            }
          }
          room.pendingChallenges.clear();
        }
        if (room.hostId && room.activeClientWs && room.activeClientWs.readyState === 1) {
          clearHostGraceTimer(room);
          room.hostGraceTimer = setTimeout(() => {
            finalizeHostDisconnect(room, '电脑端连接超时');
          }, gracePeriodMs);
        } else {
          finalizeHostDisconnect(room, '电脑端已关闭共享');
        }
      } else {
        const wasActive = room.activeClientWs === ws;
        const wasPending = room.pendingClientWs === ws;
        if (wasActive) {
          room.activeClientWs = null;
          if (room.hostId && room.hostWs && room.hostWs.readyState === 1) {
            clearClientGraceTimer(room);
            room.clientGraceTimer = setTimeout(() => {
              finalizeClientDisconnect(room, '控制设备连接超时');
            }, gracePeriodMs);
          } else {
            finalizeClientDisconnect(room, '控制设备已断开');
          }
        } else if (wasPending) {
          room.pendingClientWs = null;
          room.pendingClientMeta = null;
          sendWs(room.hostWs, { type: 'host:pending_cancelled', reason: '请求连接的设备已断开' });
        }
      }
    });
  });

  const pingInterval = setInterval(() => {
    const now = Date.now();
    for (const client of wss.clients) {
      if (client.isAlive === false || now - (client.lastActivityAt || 0) > 75000) {
        try {
          client.terminate();
        } catch {}
        continue;
      }
      client.isAlive = false;
      try {
        client.ping();
      } catch {}
    }
  }, 30000);

  async function close() {
    clearInterval(maintenanceTimer);
    clearInterval(pingInterval);
    for (const room of new Set([...roomsByCode.values(), ...roomsByHostId.values()])) {
      clearHostGraceTimer(room);
      clearClientGraceTimer(room);
    }
    for (const client of wss.clients) {
      try {
        client.terminate();
      } catch {}
    }
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }

  return { server, wss, roomsByCode, roomsByHostId, close, getIceServers };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = parseIntSafe(process.env.PORT, 47820);
  const host = process.env.HOST || '0.0.0.0';
  const relay = createRelayServer();
  relay.server.listen(port, host, () => {
    console.log(`[airdesk-relay-server] listening on http://${host}:${port} (ws path: /ws/signaling)`);
    if (!String(process.env.RELAY_ACCESS_KEY || '').trim()) {
      console.warn(
        '[SECURITY WARNING] RELAY_ACCESS_KEY is empty! Any host on the network can create rooms and query /api/ice without authentication. Set RELAY_ACCESS_KEY before exposing to public networks.'
      );
    }
  });
}
