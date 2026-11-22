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
const MAX_IP_BUCKETS = 10000;

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
  const socketRoom = new Map();
  const ipAttemptBuckets = new Map();

  function getIceServers() {
    return buildIceServersFromConfig(iceConfig);
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
      if (!room.activeClientWs && !room.pendingClientWs && now >= room.expiresAt) {
        rotateCode(room, 'ttl_expired');
      }
    }
    for (const [ip, bucket] of ipAttemptBuckets.entries()) {
      if (now > bucket.resetAt) ipAttemptBuckets.delete(ip);
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
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (raw) => {
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
          hostLabel: String(msg.hostLabel || 'AirDesk Desktop').slice(0, 64),
          audioEnabled: Boolean(msg.audioEnabled),
          pendingClientWs: null,
          pendingClientMeta: null,
          activeClientWs: null,
          activeSessionToken: null,
          failedAttempts: 0,
          trustedTokens: new Map(),
        };
        roomsByCode.set(code, room);
        socketRoom.set(ws, { room, role: 'host' });
        sendWs(ws, {
          type: 'host:created',
          code,
          expiresAt: room.expiresAt,
          iceServers: getIceServers(),
        });
        return;
      }

      if (msg.type === 'client:join') {
        if (isIpRateLimited(maskedIp)) {
          sendWs(ws, { type: 'error', message: '尝试次数过多，请 1 分钟后再试' });
          return;
        }
        if (typeof msg.sessionToken === 'string' && msg.sessionToken.length >= 16) {
          let matchedRoom = null;
          let tokenRecord = null;
          const nowTs = Date.now();
          for (const candidateRoom of new Set(roomsByCode.values())) {
            const rec = candidateRoom.trustedTokens.get(msg.sessionToken);
            if (rec && rec.expiresAt > nowTs) {
              matchedRoom = candidateRoom;
              tokenRecord = rec;
              break;
            }
          }
          if (!matchedRoom || !tokenRecord) {
            checkAndRecordIpFailure(maskedIp);
            sendWs(ws, { type: 'error', message: '自动重连凭证已过期，请重新输入 6 位配对码' });
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

      const meta = socketRoom.get(ws);
      if (!meta) return;
      const { room, role } = meta;

      if (role === 'host' && msg.type === 'host:update_config') {
        if (typeof msg.audioEnabled === 'boolean') {
          room.audioEnabled = msg.audioEnabled;
        }
        if (msg.activeMode === 'full_control' || msg.activeMode === 'view_only') {
          if (room.activeSessionToken && room.trustedTokens.has(room.activeSessionToken)) {
            room.trustedTokens.get(room.activeSessionToken).mode = msg.activeMode;
          }
        }
        if (msg.revokeAllTokens === true) {
          room.trustedTokens.clear();
          room.activeSessionToken = null;
        }
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
        const sessionToken = crypto.randomBytes(16).toString('hex');
        room.activeSessionToken = sessionToken;
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

        sendWs(pending, {
          type: 'client:approved',
          mode: approvedMode,
          hostLabel: room.hostLabel,
          audioEnabled: Boolean(room.audioEnabled),
          sessionToken,
          iceServers: getIceServers(),
        });
        return;
      }

      if (role === 'host' && msg.type === 'host:emergency_stop') {
        room.trustedTokens.clear();
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
        const peer = role === 'host' ? room.activeClientWs || room.pendingClientWs : room.hostWs;
        if (peer) {
          sendWs(peer, {
            type: role === 'host' ? 'session:closed' : 'host:client_disconnected',
            reason: msg.reason || '对方已断开连接',
          });
        }
        if (role === 'client') {
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
        roomsByCode.delete(room.code);
        if (room.activeClientWs) {
          sendWs(room.activeClientWs, { type: 'session:closed', reason: '电脑端已关闭共享' });
        }
        if (room.pendingClientWs) {
          sendWs(room.pendingClientWs, { type: 'session:closed', reason: '电脑端已关闭共享' });
        }
      } else {
        const wasActive = room.activeClientWs === ws;
        const wasPending = room.pendingClientWs === ws;
        if (wasActive) {
          room.activeClientWs = null;
          room.activeSessionToken = null;
          sendWs(room.hostWs, { type: 'host:client_disconnected', reason: '控制设备已断开' });
        } else if (wasPending) {
          room.pendingClientWs = null;
          room.pendingClientMeta = null;
          sendWs(room.hostWs, { type: 'host:pending_cancelled', reason: '请求连接的设备已断开' });
        }
      }
    });
  });

  const pingInterval = setInterval(() => {
    for (const client of wss.clients) {
      if (client.isAlive === false) {
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
    for (const client of wss.clients) {
      try {
        client.terminate();
      } catch {}
    }
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }

  return { server, wss, roomsByCode, close, getIceServers };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = parseIntSafe(process.env.PORT, 47820);
  const host = process.env.HOST || '0.0.0.0';
  const relay = createRelayServer();
  relay.server.listen(port, host, () => {
    console.log(`[airdesk-relay-server] listening on http://${host}:${port} (ws path: /ws/signaling)`);
  });
}
