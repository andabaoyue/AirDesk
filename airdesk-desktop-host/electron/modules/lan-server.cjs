const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const dgram = require('dgram');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { WebSocketServer, WebSocket } = require('ws');

const PAIR_CODE_TTL_MS = 30 * 60 * 1000; // 30 分钟

function isOverlayIp(ip) {
  const s = String(ip || '').trim().replace(/^::ffff:/i, '');
  return /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(s) || /^fd7a:115c:a1e0:/i.test(s);
}

function createLanServerManager({
  appVersion,
  trustStore,
  getMainWindow,
  getHasActiveSession,
  getAuthoritativeControl,
  getAirDeskDownloadsDir,
  sanitizeFileName,
  allocateUniqueFilePath,
  maxFileTransferBytes,
  buildEmbeddedMobileClientHtml,
}) {
  let localHttpServer = null;
  let localWss = null;
  let localUdpDiscoverySocket = null;
  let localSignalingPort = 47820;
  let localSignalingRunning = false;
  const LOCAL_HOST_SIGNALING_SECRET = crypto.randomBytes(24).toString('hex');
  let detectedAdbUsbLanIp = '';

  let revokeAllTrustedTokensCallback = null;
  let revokeOneTrustedTokenCallback = null;
  let updateActiveTrustedTokenModeCallback = null;

  function notifyTrustedDevicesUpdated() {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('airdesk:trusted-devices-updated');
    }
  }

  function getLocalNetworkInterfaces() {
    const nets = os.networkInterfaces();
    const list = [];
    for (const [name, addrs] of Object.entries(nets)) {
      for (const addr of addrs || []) {
        if (addr.internal) continue;
        let tag = 'LAN';
        if (addr.family === 'IPv6' && addr.address.startsWith('2')) tag = 'IPv6 公网';
        else if (addr.address.startsWith('100.')) tag = 'Tailscale / 虚拟网';
        else if (
          addr.family === 'IPv4' &&
          (/rndis|usb/i.test(name) ||
            addr.address.startsWith('192.168.42.') ||
            (detectedAdbUsbLanIp && addr.address === detectedAdbUsbLanIp))
        ) {
          tag = 'USB 有线共享';
        } else if (addr.address.startsWith('172.20.10.') || addr.address.startsWith('192.168.43.')) {
          tag = '手机热点网段';
        }
        list.push({ name, family: addr.family, address: addr.address, tag });
      }
    }
    return list;
  }

  function getPreferredLanIp() {
    const ifaces = getLocalNetworkInterfaces().filter((i) => i.family === 'IPv4');
    // Prioritize USB RNDIS tethered interface, then mobile personal hotspot subnets, then private LAN
    const usbIface = ifaces.find((i) => i.tag === 'USB 有线共享');
    if (usbIface) return usbIface.address;
    const hotspot = ifaces.find(
      (i) => i.address.startsWith('172.20.10.') || i.address.startsWith('192.168.43.')
    );
    if (hotspot) return hotspot.address;
    const rfc1918 = ifaces.find(
      (i) =>
        i.address.startsWith('192.168.') ||
        i.address.startsWith('10.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(i.address)
    );
    if (rfc1918) return rfc1918.address;
    return (ifaces[0] && ifaces[0].address) || '127.0.0.1';
  }

  function getLocalSignalingInfo() {
    const ipv4List = getLocalNetworkInterfaces()
      .filter((i) => i.family === 'IPv4')
      .map((i) => ({
        tag: i.tag,
        ip: i.address,
        httpUrl: 'http://' + i.address + ':' + localSignalingPort,
        wsUrl: 'ws://' + i.address + ':' + localSignalingPort + '/ws/signaling',
      }));
    const preferredIp = getPreferredLanIp();
    const tsEntry = ipv4List.find((e) => isOverlayIp(e.ip));
    const usbEntry = ipv4List.find((e) => e.tag === 'USB 有线共享');
    const usbIp = usbEntry ? usbEntry.ip : '';
    return {
      running: localSignalingRunning,
      port: localSignalingPort,
      localHostToken: LOCAL_HOST_SIGNALING_SECRET,
      preferredHttpUrl: 'http://' + preferredIp + ':' + localSignalingPort,
      preferredWsUrl: 'ws://' + preferredIp + ':' + localSignalingPort + '/ws/signaling',
      usbIp,
      usbHttpUrl: usbIp ? 'http://' + usbIp + ':' + localSignalingPort : '',
      tailscaleIp: tsEntry ? tsEntry.ip : '',
      tailscaleHttpUrl: tsEntry ? tsEntry.httpUrl : '',
      tailscaleWsUrl: tsEntry ? tsEntry.wsUrl : '',
      endpoints: ipv4List,
    };
  }

  function checkFirewallRule(port = 47820) {
    const ruleName = 'AirDesk-' + port;
    if (process.platform !== 'win32') {
      return { supported: false, allowed: true, ruleName };
    }
    try {
      execFileSync('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=' + ruleName], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 3500,
      });
      return { supported: true, allowed: true, ruleName };
    } catch {
      return { supported: true, allowed: false, ruleName };
    }
  }

  function ensureFirewallRule(port = 47820) {
    const p = Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 47820;
    const ruleName = 'AirDesk-' + p;
    if (process.platform !== 'win32') {
      return { ok: true, firewall: { supported: false, allowed: true, ruleName } };
    }
    try {
      const exeEsc = String(process.execPath || '').replace(/'/g, "''");
      const appRuleCmd = exeEsc
        ? ' & netsh advfirewall firewall delete rule name="AirDesk-App" >nul 2>&1 & ' +
          'netsh advfirewall firewall add rule name="AirDesk-App" dir=in action=allow program="' +
          exeEsc +
          '" enable=yes profile=any'
        : '';
      const cmdArgs =
        '/c netsh advfirewall firewall delete rule name="' +
        ruleName +
        '" >nul 2>&1 & ' +
        'netsh advfirewall firewall add rule name="' +
        ruleName +
        '" dir=in action=allow protocol=TCP localport=' +
        p +
        ' profile=any & ' +
        'netsh advfirewall firewall add rule name="' +
        ruleName +
        '" dir=in action=allow protocol=UDP localport=' +
        p +
        ' profile=any' +
        appRuleCmd;
      const psScript =
        "Start-Process -FilePath 'cmd.exe' -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList '" +
        cmdArgs +
        "'";
      execFileSync('powershell.exe', ['-NoProfile', '-Command', psScript], {
        windowsHide: true,
        timeout: 30000,
      });
      const status = checkFirewallRule(p);
      return { ok: status.allowed, firewall: status };
    } catch {
      return {
        ok: false,
        firewall: checkFirewallRule(p),
        error: '用户取消了管理员授权或执行失败',
      };
    }
  }

  function setupUsbDirectConnection(port = 47820, openTetherSettings = false) {
    const p = Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 47820;
    let adbAvailable = false;
    let devices = [];
    let reverseActive = false;
    let message = '';
    detectedAdbUsbLanIp = '';

    try {
      const out = execFileSync('adb', ['devices'], {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 3000,
      });
      adbAvailable = true;
      for (const line of String(out || '').split(/\r?\n/)) {
        const m = line.trim().match(/^(\S+)\s+device$/);
        if (m) devices.push(m[1]);
      }
    } catch {
      adbAvailable = false;
    }

    if (devices.length > 0) {
      const serial = devices[0];
      try {
        execFileSync('adb', ['-s', serial, 'reverse', 'tcp:' + p, 'tcp:' + p], {
          windowsHide: true,
          timeout: 3000,
        });
        reverseActive = true;
      } catch {
        reverseActive = false;
      }

      if (openTetherSettings) {
        try {
          execFileSync(
            'adb',
            ['-s', serial, 'shell', 'am', 'start', '-n', 'com.android.settings/.TetherSettings'],
            { windowsHide: true, timeout: 3000 }
          );
        } catch {
          // Non-fatal on ROMs with custom tether activity
        }
      }

      try {
        const addrOut = execFileSync('adb', ['-s', serial, 'shell', 'ip', '-4', '-o', 'addr', 'show'], {
          windowsHide: true,
          encoding: 'utf8',
          timeout: 3000,
        });
        const phonePrefixes = [];
        for (const line of String(addrOut || '').split(/\r?\n/)) {
          if (!/\b(rndis\d*|usb\d*|ncm\d*)\b/i.test(line)) continue;
          const ipMatch = line.match(/\binet\s+(\d+\.\d+\.\d+)\.\d+/);
          if (ipMatch) phonePrefixes.push(ipMatch[1] + '.');
        }
        if (phonePrefixes.length > 0) {
          const nets = os.networkInterfaces();
          outer: for (const addrs of Object.values(nets)) {
            for (const addr of addrs || []) {
              if (addr.internal || addr.family !== 'IPv4') continue;
              if (phonePrefixes.some((prefix) => addr.address.startsWith(prefix))) {
                detectedAdbUsbLanIp = addr.address;
                break outer;
              }
            }
          }
        }
      } catch {
        // Non-fatal interface probe error
      }
    }

    const localSignaling = getLocalSignalingInfo();
    if (!adbAvailable && !localSignaling.usbIp) {
      message = '未检测到 ADB 命令或 USB 共享网卡；请插上数据线并开启手机「USB 网络共享」或 USB 调试';
    } else if (devices.length === 0 && !localSignaling.usbIp) {
      message = '未检测到已授权的 ADB 设备或 USB 共享网卡，请确认手机已开启 USB 调试/USB 网络共享';
    } else if (localSignaling.usbIp && reverseActive) {
      message = 'USB RNDIS 网卡 (' + localSignaling.usbIp + ') 与 adb reverse tcp:' + p + ' 均已就绪';
    } else if (localSignaling.usbIp) {
      message = '已检测到 USB 有线共享网卡：' + localSignaling.usbIp;
    } else if (reverseActive) {
      message =
        '已建立 adb reverse tcp:' +
        p +
        ' -> tcp:' +
        p +
        '（若未开 USB 网络共享，可点「弹出手机 USB 共享设置」开启有线直连）';
    }

    return {
      ok: Boolean(reverseActive || localSignaling.usbIp),
      adbAvailable,
      devices,
      reverseActive,
      usbIp: localSignaling.usbIp,
      usbHttpUrl: localSignaling.usbHttpUrl,
      localSignaling,
      message,
    };
  }

  function startLocalSignalingServer(port = 47820) {
    if (localSignalingRunning && localHttpServer) {
      return Promise.resolve(getLocalSignalingInfo());
    }
    localSignalingPort = Number(port) || 47820;

    return new Promise((resolve, reject) => {
      const roomsByCode = new Map();
      const socketRoom = new Map();
      const lanFileIpBuckets = new Map();
      let activeLanUploads = 0;

      const sendWs = (ws, obj) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(obj));
        }
      };

      revokeAllTrustedTokensCallback = () => {
        for (const room of new Set(roomsByCode.values())) {
          room.activeSessionToken = null;
          if (room.activeClientWs) {
            sendWs(room.activeClientWs, {
              type: 'session:permission_updated',
              controlEnabled: false,
              reason: '电脑端已清空所有免密凭证',
            });
          }
        }
        trustStore.revokeAllTokens();
        notifyTrustedDevicesUpdated();
      };

      revokeOneTrustedTokenCallback = (tokenPrefix) => {
        if (!tokenPrefix || typeof tokenPrefix !== 'string') return;
        const revokedTokens = trustStore.revokeToken(tokenPrefix);
        for (const room of new Set(roomsByCode.values())) {
          if (room.activeSessionToken && revokedTokens.includes(room.activeSessionToken)) {
            room.activeSessionToken = null;
            if (room.activeClientWs) {
              const target = room.activeClientWs;
              room.activeClientWs = null;
              socketRoom.delete(target);
              sendWs(target, { type: 'session:closed', reason: '电脑端已移除当前设备信任凭证' });
              try { target.close(); } catch {}
            }
          }
        }
        notifyTrustedDevicesUpdated();
      };

      updateActiveTrustedTokenModeCallback = (nextMode) => {
        if (nextMode !== 'full_control' && nextMode !== 'view_only') return;
        for (const room of new Set(roomsByCode.values())) {
          if (room.activeSessionToken) {
            trustStore.updateTokenMode(room.activeSessionToken, nextMode);
          }
        }
      };

      const genCode = () => {
        for (let i = 0; i < 20; i++) {
          const c = String(crypto.randomInt(100000, 1000000));
          if (!roomsByCode.has(c)) return c;
        }
        return String(crypto.randomInt(100000, 1000000));
      };

      const rotateCode = (room, reason) => {
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
      };

      const mobileHtml = buildEmbeddedMobileClientHtml();
      const manifestJson = JSON.stringify({
        name: 'AirDesk',
        short_name: 'AirDesk',
        display: 'standalone',
        // Landscape so a 16:9 desktop fills the screen when launched from the home screen.
        orientation: 'landscape',
        start_url: '/',
        background_color: '#05070A',
        theme_color: '#0B0F14',
      });

      const isLanFileRateLimited = (ip) => {
        const now = Date.now();
        const b = lanFileIpBuckets.get(ip);
        if (!b || now > b.resetAt) return false;
        return b.count >= 5;
      };

      const recordLanFileFailure = (ip) => {
        const now = Date.now();
        let b = lanFileIpBuckets.get(ip);
        if (!b || now > b.resetAt) {
          if (!b && lanFileIpBuckets.size >= 1000) {
            const oldest = lanFileIpBuckets.keys().next().value;
            if (oldest !== undefined) lanFileIpBuckets.delete(oldest);
          }
          b = { count: 0, resetAt: now + 60000 };
          lanFileIpBuckets.set(ip, b);
        }
        b.count += 1;
      };

      const verifyLanFileAuth = (req, requireWrite = false) => {
        const nowTs = Date.now();
        const clientIp = String((req.socket && req.socket.remoteAddress) || 'LAN').replace(/^::ffff:/, '');
        if (isLanFileRateLimited(clientIp)) {
          return { ok: false, status: 429, error: '尝试次数过多，请 1 分钟后再试' };
        }

        const hasActiveSession = getHasActiveSession();
        const authoritativeControlEnabled = getAuthoritativeControl();
        const tok = String(req.headers['x-airdesk-token'] || '').trim();
        if (tok && tok.length >= 16) {
          const matchedRec = trustStore.getValidTokenRecord(tok);
          if (matchedRec) {
            if (requireWrite && ((hasActiveSession && !authoritativeControlEnabled) || matchedRec.mode !== 'full_control')) {
              return { ok: false, status: 403, error: '当前为只读模式，禁止向电脑上传文件' };
            }
            return { ok: true };
          }
        }

        const pin = String(req.headers['x-airdesk-pin'] || '').replace(/\D/g, '');
        if (pin.length === 6) {
          const room = roomsByCode.get(pin);
          if (room && nowTs <= room.expiresAt) {
            if (requireWrite && hasActiveSession && !authoritativeControlEnabled) {
              return { ok: false, status: 403, error: '当前电脑处于只读模式，禁止上传文件' };
            }
            room.failedAttempts = 0;
            return { ok: true };
          }
          recordLanFileFailure(clientIp);
          for (const activeRoom of new Set(roomsByCode.values())) {
            activeRoom.failedAttempts = (activeRoom.failedAttempts || 0) + 1;
            if (activeRoom.failedAttempts >= 5) {
              rotateCode(activeRoom, 'too_many_failed_attempts');
            }
          }
        } else if (tok || req.headers['x-airdesk-pin']) {
          recordLanFileFailure(clientIp);
        }

        return { ok: false, status: 401, error: '未授权：请先免密配对或输入有效 6 位配对码' };
      };

      const server = http.createServer((req, res) => {
        const urlObj = new URL(req.url || '/', 'http://localhost');
        const urlPath = urlObj.pathname;
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }
        if (urlPath === '/api/health') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, mode: 'local_embedded_signaling', version: appVersion, port: localSignalingPort, lanFileTransfer: true }));
          return;
        }
        if (urlPath === '/api/discover') {
          const info = getLocalSignalingInfo();
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(
            JSON.stringify({
              ok: true,
              service: 'airdesk',
              version: appVersion,
              lanFileTransfer: true,
              hostname: os.hostname(),
              port: localSignalingPort,
              preferredHttpUrl: info.preferredHttpUrl,
              addresses: getLocalNetworkInterfaces()
                .filter((i) => i.family === 'IPv4')
                .map((i) => i.address),
            })
          );
          return;
        }
        if (urlPath === '/api/lan-files/list' && req.method === 'GET') {
          const auth = verifyLanFileAuth(req, false);
          if (!auth.ok) {
            res.writeHead(auth.status, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: auth.error }));
            return;
          }
          try {
            const dir = getAirDeskDownloadsDir();
            const items = fs
              .readdirSync(dir, { withFileTypes: true })
              .filter((d) => d.isFile() && !d.name.endsWith('.part'))
              .map((d) => {
                const st = fs.statSync(path.join(dir, d.name));
                return { name: d.name, size: st.size, mtimeMs: st.mtimeMs };
              })
              .sort((a, b) => b.mtimeMs - a.mtimeMs)
              .slice(0, 50);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, files: items }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
          return;
        }
        if (urlPath === '/api/lan-files/upload' && req.method === 'POST') {
          const auth = verifyLanFileAuth(req, true);
          if (!auth.ok) {
            res.writeHead(auth.status, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: auth.error }));
            return;
          }
          if (activeLanUploads >= 2) {
            res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: '当前已有文件正在上传，请稍后再试' }));
            return;
          }
          const rawName = urlObj.searchParams.get('name') || 'airdesk-file.bin';
          const dir = getAirDeskDownloadsDir();
          const safeName = sanitizeFileName(rawName);
          const { finalName, finalPath } = allocateUniqueFilePath(dir, safeName);
          const tempPath = finalPath + '.part';
          const wsOut = fs.createWriteStream(tempPath);
          activeLanUploads += 1;
          let slotReleased = false;
          const releaseUploadSlot = () => {
            if (!slotReleased) {
              slotReleased = true;
              activeLanUploads = Math.max(0, activeLanUploads - 1);
            }
          };
          let received = 0;
          let failed = false;
          let drainPending = false;

          const cleanupTemp = () => {
            releaseUploadSlot();
            try { wsOut.destroy(); } catch {}
            try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch {}
          };

          wsOut.on('error', (err) => {
            if (failed) return;
            failed = true;
            cleanupTemp();
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ ok: false, error: err.message }));
            }
            try { req.destroy(); } catch {}
          });

          req.on('data', (chunk) => {
            if (failed) return;
            received += chunk.length;
            if (received > maxFileTransferBytes) {
              failed = true;
              cleanupTemp();
              if (!res.headersSent) {
                res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, error: '文件超出 500MB 上限' }));
              }
              req.destroy();
              return;
            }
            if (!wsOut.write(chunk) && !drainPending) {
              drainPending = true;
              req.pause();
              wsOut.once('drain', () => {
                drainPending = false;
                if (!failed && !req.destroyed) req.resume();
              });
            }
          });
          req.on('aborted', () => {
            failed = true;
            cleanupTemp();
          });
          req.on('error', () => {
            failed = true;
            cleanupTemp();
          });
          req.on('end', () => {
            if (failed) return;
            wsOut.end(() => {
              releaseUploadSlot();
              try {
                fs.renameSync(tempPath, finalPath);
                const win = getMainWindow();
                if (win && !win.isDestroyed()) {
                  win.webContents.send('airdesk:lan-file-received', {
                    finalName,
                    savedPath: finalPath,
                    size: received,
                  });
                }
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: true, savedName: finalName, savedPath: finalPath, size: received }));
              } catch (err) {
                cleanupTemp();
                if (!res.headersSent) {
                  res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                  res.end(JSON.stringify({ ok: false, error: err.message }));
                }
              }
            });
          });
          return;
        }
        if (urlPath === '/api/lan-files/download' && req.method === 'GET') {
          const auth = verifyLanFileAuth(req, false);
          if (!auth.ok) {
            res.writeHead(auth.status, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: auth.error }));
            return;
          }
          const reqName = path.basename(urlObj.searchParams.get('name') || '');
          if (!reqName || reqName.endsWith('.part')) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: '无效文件名' }));
            return;
          }
          const dir = getAirDeskDownloadsDir();
          const filePath = path.join(dir, reqName);
          if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: '文件不存在' }));
            return;
          }
          const stat = fs.statSync(filePath);
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(stat.size),
            'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(reqName),
          });
          const rs = fs.createReadStream(filePath);
          rs.on('error', () => {
            try { res.destroy(); } catch {}
          });
          res.on('close', () => {
            rs.destroy();
          });
          rs.pipe(res);
          return;
        }
        if (urlPath === '/manifest.webmanifest') {
          res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-cache' });
          res.end(manifestJson);
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Frame-Options': 'DENY',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(mobileHtml);
      });

      const wss = new WebSocketServer({ server, path: '/ws/signaling', maxPayload: 256 * 1024 });

      const ttlTimer = setInterval(() => {
        const now = Date.now();
        for (const room of new Set(roomsByCode.values())) {
          if (!room.activeClientWs && !room.pendingClientWs && now >= room.expiresAt) {
            rotateCode(room, 'ttl_expired');
          }
        }
        for (const [ip, b] of lanFileIpBuckets.entries()) {
          if (now > b.resetAt) lanFileIpBuckets.delete(ip);
        }
      }, 5000);

      wss.on('connection', (ws, req) => {
        const rawIp = (req.socket && req.socket.remoteAddress) || 'LAN';
        const maskedIp = rawIp.replace(/^::ffff:/, '');

        ws.on('message', (raw) => {
          let msg;
          try {
            msg = JSON.parse(raw.toString('utf8'));
          } catch {
            return;
          }
          if (msg.type === 'ws:ping') {
            sendWs(ws, { type: 'ws:pong', ts: msg.ts });
            return;
          }
          if (msg.type === 'host:create') {
            const isLoopback = rawIp === '127.0.0.1' || rawIp === '::1' || rawIp === '::ffff:127.0.0.1';
            const candToken = typeof msg.localHostToken === 'string' ? msg.localHostToken : '';
            let hasValidSecret = false;
            if (candToken.length === LOCAL_HOST_SIGNALING_SECRET.length) {
              try {
                hasValidSecret = crypto.timingSafeEqual(
                  Buffer.from(candToken, 'utf8'),
                  Buffer.from(LOCAL_HOST_SIGNALING_SECRET, 'utf8')
                );
              } catch {}
            }
            if (!isLoopback && !hasValidSecret) {
              sendWs(ws, { type: 'error', message: 'Forbidden: host registration is restricted to local desktop host' });
              try { ws.close(1008, 'Forbidden'); } catch {}
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
              hostLabel: msg.hostLabel || os.hostname(),
              audioEnabled: Boolean(msg.audioEnabled),
              pendingClientWs: null,
              activeClientWs: null,
              activeSessionToken: null,
              failedAttempts: 0,
            };
            roomsByCode.set(code, room);
            socketRoom.set(ws, { room, role: 'host' });
            sendWs(ws, { type: 'host:created', code, expiresAt: room.expiresAt });
            return;
          }
          if (msg.type === 'client:join') {
            const isOverlayPeer = isOverlayIp(maskedIp);
            if (typeof msg.sessionToken === 'string' && msg.sessionToken.length >= 16) {
              const firstRoom = roomsByCode.values().next().value || null;
              const verify = firstRoom
                ? trustStore.verifyAndTouchToken(msg.sessionToken, {
                    ipMasked: maskedIp,
                    deviceLabel: msg.deviceLabel,
                    platformHint: msg.platformHint,
                  })
                : { ok: false };
              if (!firstRoom || !verify.ok) {
                sendWs(ws, { type: 'error', code: 'TOKEN_INVALID', message: '自动重连凭证已过期，请重新扫码或输入 6 位配对码' });
                return;
              }
              const matchedRoom = firstRoom;
              const tokenRecord = verify.record;
              if (matchedRoom.activeClientWs && matchedRoom.activeClientWs !== ws) {
                const staleWs = matchedRoom.activeClientWs;
                matchedRoom.activeClientWs = null;
                socketRoom.delete(staleWs);
                try { staleWs.close(); } catch {}
              }
              matchedRoom.activeClientWs = ws;
              matchedRoom.activeSessionToken = msg.sessionToken;
              socketRoom.set(ws, { room: matchedRoom, role: 'client' });
              sendWs(ws, {
                type: 'client:approved',
                mode: tokenRecord.mode,
                hostLabel: matchedRoom.hostLabel,
                audioEnabled: Boolean(matchedRoom.audioEnabled),
                sessionToken: msg.sessionToken,
                reconnected: true,
              });
              sendWs(matchedRoom.hostWs, {
                type: 'host:client_reconnected',
                mode: tokenRecord.mode,
                deviceLabel: tokenRecord.deviceLabel,
                ipMasked: maskedIp,
                isOverlayPeer,
              });
              return;
            }
            const clean = String(msg.code || '').replace(/\D/g, '');
            const room = roomsByCode.get(clean);
            if (!room) {
              for (const activeRoom of new Set(roomsByCode.values())) {
                activeRoom.failedAttempts = (activeRoom.failedAttempts || 0) + 1;
                if (activeRoom.failedAttempts >= 5) {
                  rotateCode(activeRoom, 'too_many_failed_attempts');
                }
              }
              sendWs(ws, { type: 'error', message: '配对码无效或已过期，请核对电脑端最新 6 位码' });
              return;
            }
            if (Date.now() > room.expiresAt) {
              rotateCode(room, 'ttl_expired');
              sendWs(ws, { type: 'error', message: '配对码无效或已过期，请核对电脑端最新 6 位码' });
              return;
            }
            if (room.activeClientWs || room.pendingClientWs) {
              sendWs(ws, { type: 'error', message: '该电脑当前已有设备正在连接' });
              return;
            }
            room.failedAttempts = 0;
            room.pendingClientWs = ws;
            room.pendingClientMeta = {
              deviceLabel: String(msg.deviceLabel || '局域网移动设备').slice(0, 64),
              platformHint: String(msg.platformHint || 'Mobile').slice(0, 32),
              ipMasked: maskedIp,
              isOverlayPeer,
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
                isOverlayPeer,
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
              if (room.activeSessionToken) {
                trustStore.updateTokenMode(room.activeSessionToken, msg.activeMode);
              }
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
            const issued = trustStore.issueToken({
              mode: approvedMode,
              deviceLabel: pendingMeta.deviceLabel || '局域网移动设备',
              platformHint: pendingMeta.platformHint || 'Mobile',
              ipMasked: pendingMeta.ipMasked || 'LAN',
              source: 'lan',
            });
            const sessionToken = issued.sessionToken;
            room.activeSessionToken = sessionToken;
            sendWs(pending, {
              type: 'client:approved',
              mode: approvedMode,
              hostLabel: room.hostLabel,
              audioEnabled: Boolean(room.audioEnabled),
              sessionToken,
            });
            return;
          }
          if (role === 'host' && msg.type === 'host:emergency_stop') {
            trustStore.revokeAllTokens();
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

      server.on('close', () => {
        clearInterval(ttlTimer);
        localSignalingRunning = false;
        revokeAllTrustedTokensCallback = null;
        revokeOneTrustedTokenCallback = null;
        updateActiveTrustedTokenModeCallback = null;
      });

      server.once('error', (err) => {
        clearInterval(ttlTimer);
        localSignalingRunning = false;
        revokeAllTrustedTokensCallback = null;
        revokeOneTrustedTokenCallback = null;
        updateActiveTrustedTokenModeCallback = null;
        reject(err);
      });

      server.listen(localSignalingPort, '0.0.0.0', () => {
        localHttpServer = server;
        localWss = wss;
        localSignalingRunning = true;
        // Start zero-dependency UDP LAN/Hotspot discovery responder on same port (non-fatal)
        try {
          if (localUdpDiscoverySocket) {
            try { localUdpDiscoverySocket.close(); } catch {}
            localUdpDiscoverySocket = null;
          }
          const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
          udp.on('error', (err) => {
            console.warn('[AirDesk Discovery UDP] Non-fatal socket error:', err.message);
          });
          udp.on('message', (buf, rinfo) => {
            const text = buf.toString('utf8', 0, Math.min(buf.length, 64)).trim();
            if (!text.startsWith('AIRDESK_DISCOVER')) return;
            const reply = Buffer.from(
              JSON.stringify({
                t: 'airdesk:here',
                service: 'airdesk',
                version: appVersion,
                hostname: os.hostname(),
                port: localSignalingPort,
                addresses: getLocalNetworkInterfaces()
                  .filter((i) => i.family === 'IPv4')
                  .map((i) => i.address),
              }),
              'utf8'
            );
            udp.send(reply, rinfo.port, rinfo.address, () => {});
          });
          udp.bind(localSignalingPort, '0.0.0.0', () => {
            try { udp.setBroadcast(true); } catch {}
          });
          localUdpDiscoverySocket = udp;
        } catch (udpErr) {
          console.warn('[AirDesk Discovery UDP] Failed to bind:', udpErr.message);
        }
        resolve(getLocalSignalingInfo());
      });
    });
  }

  function stopLocalSignalingServer() {
    revokeAllTrustedTokensCallback = null;
    revokeOneTrustedTokenCallback = null;
    updateActiveTrustedTokenModeCallback = null;
    if (localUdpDiscoverySocket) {
      try {
        localUdpDiscoverySocket.close();
      } catch {}
      localUdpDiscoverySocket = null;
    }
    if (localWss) {
      try {
        localWss.close();
      } catch {}
      localWss = null;
    }
    if (localHttpServer) {
      try {
        localHttpServer.close();
      } catch {}
      localHttpServer = null;
    }
    localSignalingRunning = false;
    return getLocalSignalingInfo();
  }

  function listTrustedDevices() {
    return trustStore.listTrustedDevices();
  }

  function revokeAllTrustedTokens() {
    if (revokeAllTrustedTokensCallback) {
      revokeAllTrustedTokensCallback();
    } else {
      trustStore.revokeAllTokens();
    }
  }

  function revokeTrustedToken(tokenPrefix) {
    if (revokeOneTrustedTokenCallback) {
      revokeOneTrustedTokenCallback(tokenPrefix);
    } else {
      trustStore.revokeToken(tokenPrefix);
    }
  }

  function updateActiveTrustedTokenMode(nextMode) {
    if (updateActiveTrustedTokenModeCallback) {
      updateActiveTrustedTokenModeCallback(nextMode);
    }
  }

  function getLocalSignalingPort() {
    return localSignalingPort;
  }

  return {
    getLocalNetworkInterfaces,
    getLocalSignalingInfo,
    getLocalSignalingPort,
    checkFirewallRule,
    ensureFirewallRule,
    setupUsbDirectConnection,
    startLocalSignalingServer,
    stopLocalSignalingServer,
    listTrustedDevices,
    revokeAllTrustedTokens,
    revokeTrustedToken,
    updateActiveTrustedTokenMode,
  };
}

module.exports = {
  createLanServerManager,
};
