const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const ELEVATED_SERVICE_NAME = 'AirDeskElevatedInput';
const ELEVATED_PIPE_PATH = '\\\\.\\pipe\\AirDeskElevatedInput';
const ELEVATED_INSTALL_EXE = 'C:\\ProgramData\\AirDesk\\airdesk-elevated-service.exe';
const ELEVATED_SECRET_PATH = 'C:\\ProgramData\\AirDesk\\pipe.secret';

function createNativeHelperManager({
  app,
  appRootDir,
  getMainWindow,
  getIsQuitting,
  getAuthoritativeControl,
  getHasActiveSession,
  onPhysicalOverride,
  activePressedKeys,
  activePressedMouseButtons,
}) {
  let nativeHelper = null;
  let elevatedPipeClient = null;
  let elevatedPipeConnecting = false;
  let elevatedPipeAuthenticated = false;
  let elevatedCompactProto = false;
  let lastSecureDesktopActive = false;
  let helperRestartTimestamps = [];
  let helperRespawnTimer = null;

  function resolveNativeAssetPath(filename) {
    const baseDir = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'native')
      : path.join(appRootDir, 'native');
    return path.join(baseDir, filename);
  }

  function formatCompactPointerLine(payload) {
    if (!payload || typeof payload !== 'object') return null;
    if (payload.t === 'm:rel') {
      const dx = Number(payload.dx) || 0;
      const dy = Number(payload.dy) || 0;
      return 'R ' + dx + ' ' + dy + '\n';
    }
    if (payload.t === 'm:abs' && Number.isFinite(payload.px) && Number.isFinite(payload.py)) {
      return 'A ' + payload.px + ' ' + payload.py + '\n';
    }
    if (payload.t === 'm:whl') {
      const dx = Number.isFinite(payload.dx) ? payload.dx : 0;
      const dy = Number.isFinite(payload.dy) ? payload.dy : 0;
      return 'W ' + dx + ' ' + dy + '\n';
    }
    return null;
  }

  function sendToHelper(payload) {
    if (
      elevatedPipeClient &&
      elevatedPipeAuthenticated &&
      elevatedPipeClient.writable &&
      !elevatedPipeClient.destroyed &&
      !elevatedPipeClient.writableEnded
    ) {
      const line =
        (process.platform === 'win32' && elevatedCompactProto && formatCompactPointerLine(payload)) ||
        JSON.stringify(payload) + '\n';
      try {
        elevatedPipeClient.write(line, () => {});
        return;
      } catch (err) {
        if (err && err.code !== 'EPIPE') {
          console.error('[AirDesk Elevated Pipe] Write error:', err.message);
        }
      }
    }
    if (
      !nativeHelper ||
      nativeHelper.killed ||
      !nativeHelper.stdin ||
      !nativeHelper.stdin.writable ||
      nativeHelper.stdin.destroyed ||
      nativeHelper.stdin.writableEnded
    ) {
      return;
    }
    const line =
      (process.platform === 'win32' && formatCompactPointerLine(payload)) ||
      JSON.stringify(payload) + '\n';
    try {
      nativeHelper.stdin.write(line, () => {});
    } catch (err) {
      if (err && err.code !== 'EPIPE') {
        console.error('[AirDesk Helper] Write error:', err.message);
      }
    }
  }

  function releaseHeldMouseButtons(reason) {
    if (activePressedMouseButtons.size === 0) return;
    for (const button of Array.from(activePressedMouseButtons)) {
      sendToHelper({ t: 'm:btn', button, state: 'up' });
    }
    activePressedMouseButtons.clear();
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('airdesk:inputs-released', { reason });
    }
  }

  function releaseAllInputs(reason) {
    if (activePressedKeys.size > 0) {
      for (const code of Array.from(activePressedKeys)) {
        sendToHelper({ t: 'k:up', code });
      }
      activePressedKeys.clear();
    }
    releaseHeldMouseButtons(reason);
    sendToHelper({ t: 'k:release_all', reason });
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('airdesk:inputs-released', { reason });
    }
  }

  function cleanupStaleWinHelpers(userDataDir, keepFilename) {
    try {
      for (const entry of fs.readdirSync(userDataDir)) {
        if (entry.startsWith('airdesk-win-helper-') && entry.endsWith('.exe') && entry !== keepFilename) {
          fs.unlinkSync(path.join(userDataDir, entry));
        }
      }
    } catch {
      // Non-fatal cleanup error
    }
  }

  function scheduleHelperRespawn() {
    if (getIsQuitting() || helperRespawnTimer) return;
    const now = Date.now();
    helperRestartTimestamps = helperRestartTimestamps.filter((ts) => now - ts < 60000);
    if (helperRestartTimestamps.length >= 5) {
      console.error('[AirDesk Helper] Crashed too many times within 60s; halting respawn.');
      return;
    }
    helperRestartTimestamps.push(now);
    const delayMs = Math.min(8000, 800 * Math.pow(2, helperRestartTimestamps.length - 1));
    helperRespawnTimer = setTimeout(() => {
      helperRespawnTimer = null;
      if (!getIsQuitting()) spawnNativeHelper();
    }, delayMs);
  }

  function resolveWinHelperExePath() {
    if (process.platform !== 'win32') return null;
    const prebuiltExe = resolveNativeAssetPath('airdesk-win-helper.exe');
    if (fs.existsSync(prebuiltExe)) {
      return prebuiltExe;
    }
    const csFile = resolveNativeAssetPath('win-input-helper.cs');
    if (!fs.existsSync(csFile)) {
      console.warn('[AirDesk] win-input-helper.cs missing at:', csFile);
      return null;
    }
    // Hash-based cache guarantees code updates always trigger clean recompilation
    const sourceHash = crypto
      .createHash('sha256')
      .update(fs.readFileSync(csFile))
      .digest('hex')
      .slice(0, 12);
    const userDataDir = app.getPath('userData');
    const exeName = 'airdesk-win-helper-' + sourceHash + '.exe';
    const compiledExe = path.join(userDataDir, exeName);

    if (!fs.existsSync(compiledExe)) {
      const cscCandidates = [
        'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
        'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
      ];
      const cscPath = cscCandidates.find((p) => fs.existsSync(p));
      if (!cscPath) {
        console.warn('[AirDesk] Built-in .NET csc.exe not found. Native input disabled.');
        return null;
      }
      try {
        execFileSync(
          cscPath,
          [
            '/nologo',
            '/optimize+',
            '/r:System.Web.Extensions.dll',
            '/out:' + compiledExe,
            csFile,
          ],
          { windowsHide: true }
        );
        cleanupStaleWinHelpers(userDataDir, exeName);
      } catch (err) {
        console.error('[AirDesk] Failed to compile win-input-helper.cs:', err.message);
        return null;
      }
    }
    return compiledExe;
  }

  function handleHelperJsonEvent(evt) {
    if (!evt || typeof evt !== 'object') return;
    if (evt.event === 'elevated_ready') {
      elevatedPipeAuthenticated = true;
      elevatedCompactProto = evt.compactProto === true;
      return;
    }
    const win = getMainWindow();
    if (evt.event === 'secure_desktop') {
      const active = Boolean(evt.active);
      lastSecureDesktopActive = active;
      const elevatedConnected = Boolean(
        elevatedPipeClient &&
          elevatedPipeAuthenticated &&
          elevatedPipeClient.writable &&
          !elevatedPipeClient.destroyed
      );
      if (active) {
        releaseAllInputs('secure_desktop_entered');
      }
      if (win && !win.isDestroyed()) {
        win.webContents.send('airdesk:secure-desktop', {
          active,
          elevatedConnected,
        });
      }
      return;
    }
    if (evt.event === 'physical_mouse_override') {
      if (!getHasActiveSession() || !getAuthoritativeControl()) return;
      const silencedUntil = Date.now() + 3000;
      if (onPhysicalOverride) onPhysicalOverride(silencedUntil);
      releaseHeldMouseButtons('physical_mouse_override');
      if (win && !win.isDestroyed()) {
        win.webContents.send('airdesk:physical-override', {
          silencedUntil,
        });
      }
    } else if (evt.event === 'permission_warning' && win && !win.isDestroyed()) {
      win.webContents.send('airdesk:inputs-released', {
        reason: evt.message || 'missing_os_permission',
      });
    }
  }

  function spawnNativeHelper() {
    if (nativeHelper && !nativeHelper.killed) return;

    if (process.platform === 'win32') {
      const exeToRun = resolveWinHelperExePath();
      if (!exeToRun) return;

      nativeHelper = spawn(exeToRun, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } else if (process.platform === 'darwin') {
      const prebuiltMac = resolveNativeAssetPath('airdesk-mac-helper');
      if (fs.existsSync(prebuiltMac)) {
        nativeHelper = spawn(prebuiltMac, [], { stdio: ['pipe', 'pipe', 'pipe'] });
      } else {
        const swiftFile = resolveNativeAssetPath('mac-input-helper.swift');
        if (!fs.existsSync(swiftFile)) return;
        nativeHelper = spawn('swift', [swiftFile], { stdio: ['pipe', 'pipe', 'pipe'] });
      }
    } else {
      console.info('[AirDesk] Linux helper placeholder — integrate xdotool/uinput as needed.');
      return;
    }

    nativeHelper.on('error', (err) => {
      console.error('[AirDesk Helper] Process error:', err.message);
      nativeHelper = null;
      if (!getIsQuitting() && !(elevatedPipeClient && elevatedPipeClient.writable)) {
        scheduleHelperRespawn();
      }
    });
    if (nativeHelper.stdin) nativeHelper.stdin.on('error', () => {});
    if (nativeHelper.stdout) nativeHelper.stdout.on('error', () => {});
    if (nativeHelper.stderr) nativeHelper.stderr.on('error', () => {});

    let stdoutBuffer = '';
    nativeHelper.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          handleHelperJsonEvent(JSON.parse(line));
        } catch {
          // Ignore non-JSON helper stdout
        }
      }
    });

    nativeHelper.on('exit', (code) => {
      console.warn('[AirDesk Helper] Exited with code:', code);
      nativeHelper = null;
      if (!getIsQuitting() && !(elevatedPipeClient && elevatedPipeClient.writable)) {
        scheduleHelperRespawn();
      }
    });
  }

  function getElevatedServiceStatus() {
    if (process.platform !== 'win32') {
      return { supported: false, installed: false, running: false, pipeConnected: false };
    }
    const pipeConnected = Boolean(
      elevatedPipeClient && elevatedPipeAuthenticated && elevatedPipeClient.writable
    );
    try {
      const out = execFileSync('sc.exe', ['query', ELEVATED_SERVICE_NAME], {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 3000,
      });
      const running = /STATE\s*:\s*4\b/i.test(String(out || ''));
      return { supported: true, installed: true, running, pipeConnected };
    } catch {
      return { supported: true, installed: false, running: false, pipeConnected };
    }
  }

  function disconnectElevatedPipe() {
    elevatedPipeAuthenticated = false;
    elevatedCompactProto = false;
    if (elevatedPipeClient) {
      try {
        elevatedPipeClient.removeAllListeners();
        elevatedPipeClient.destroy();
      } catch {}
      elevatedPipeClient = null;
    }
  }

  function connectElevatedPipe(timeoutMs = 2500) {
    if (process.platform !== 'win32') return Promise.resolve(false);
    if (elevatedPipeClient && elevatedPipeAuthenticated && elevatedPipeClient.writable) {
      return Promise.resolve(true);
    }
    if (elevatedPipeConnecting) return Promise.resolve(false);

    elevatedPipeConnecting = true;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        elevatedPipeConnecting = false;
        clearTimeout(timer);
        resolve(ok);
      };

      const client = net.createConnection(ELEVATED_PIPE_PATH);
      let buf = '';
      const timer = setTimeout(() => {
        if (elevatedPipeClient === client) {
          elevatedPipeClient = null;
          elevatedPipeAuthenticated = false;
          elevatedCompactProto = false;
        }
        try { client.destroy(); } catch {}
        finish(false);
      }, timeoutMs);

      client.on('connect', () => {
        let secret = '';
        try {
          if (fs.existsSync(ELEVATED_SECRET_PATH)) {
            secret = fs.readFileSync(ELEVATED_SECRET_PATH, 'utf8').trim();
          }
        } catch {}
        if (!secret || secret.length < 16) {
          try { client.destroy(); } catch {}
          finish(false);
          return;
        }
        try {
          client.write(JSON.stringify({ t: 'auth', secret }) + '\n');
        } catch {
          try { client.destroy(); } catch {}
          finish(false);
          return;
        }
        elevatedPipeAuthenticated = false;
        elevatedCompactProto = false;
        elevatedPipeClient = client;
      });

      client.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const evt = JSON.parse(line);
            handleHelperJsonEvent(evt);
            if (evt && evt.event === 'elevated_ready') {
              if (helperRespawnTimer) {
                clearTimeout(helperRespawnTimer);
                helperRespawnTimer = null;
              }
              if (nativeHelper && !nativeHelper.killed) {
                try { nativeHelper.kill(); } catch {}
                nativeHelper = null;
              }
              finish(true);
            }
          } catch {}
        }
      });

      client.on('error', () => {
        if (elevatedPipeClient === client) {
          elevatedPipeClient = null;
          elevatedPipeAuthenticated = false;
          elevatedCompactProto = false;
        }
        finish(false);
      });

      client.on('close', () => {
        const wasActive = elevatedPipeClient === client;
        if (wasActive) {
          elevatedPipeClient = null;
          elevatedPipeAuthenticated = false;
          elevatedCompactProto = false;
        }
        finish(false);
        if (wasActive && !getIsQuitting() && (!nativeHelper || nativeHelper.killed)) {
          spawnNativeHelper();
        }
      });
    });
  }

  function compileElevatedServiceBinary() {
    const prebuiltExe = resolveNativeAssetPath('airdesk-elevated-service.exe');
    if (fs.existsSync(prebuiltExe)) {
      return { ok: true, exePath: prebuiltExe };
    }
    const csFile = resolveNativeAssetPath('win-elevated-service.cs');
    if (!fs.existsSync(csFile)) {
      return { ok: false, error: '缺少 win-elevated-service.cs 源码文件' };
    }
    const cscCandidates = [
      'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
      'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
    ];
    const cscPath = cscCandidates.find((p) => fs.existsSync(p));
    if (!cscPath) {
      return { ok: false, error: '未找到系统自带 .NET Framework csc.exe' };
    }
    const sourceHash = crypto
      .createHash('sha256')
      .update(fs.readFileSync(csFile))
      .digest('hex')
      .slice(0, 12);
    const outExe = path.join(app.getPath('userData'), 'airdesk-elevated-service-' + sourceHash + '.exe');
    if (!fs.existsSync(outExe)) {
      try {
        execFileSync(
          cscPath,
          [
            '/nologo',
            '/optimize+',
            '/r:System.ServiceProcess.dll',
            '/r:System.Web.Extensions.dll',
            '/out:' + outExe,
            csFile,
          ],
          { windowsHide: true, timeout: 15000 }
        );
      } catch (err) {
        return { ok: false, error: '编译后台服务失败: ' + err.message };
      }
    }
    return { ok: true, exePath: outExe };
  }

  async function installElevatedService() {
    if (process.platform !== 'win32') {
      return { ok: false, status: getElevatedServiceStatus(), error: '仅支持 Windows 系统' };
    }
    const compiled = compileElevatedServiceBinary();
    if (!compiled.ok) {
      return { ok: false, status: getElevatedServiceStatus(), error: compiled.error };
    }
    const srcEsc = compiled.exePath.replace(/'/g, "''");
    const dstEsc = ELEVATED_INSTALL_EXE.replace(/'/g, "''");
    const secretEsc = ELEVATED_SECRET_PATH.replace(/'/g, "''");
    const pipeSecret = crypto.randomBytes(32).toString('hex');
    const currentUser = (os.userInfo && os.userInfo().username) || process.env.USERNAME || '';
    const currentUserEsc = String(currentUser).replace(/'/g, "''");
    const svcEsc = ELEVATED_SERVICE_NAME;
    const icaclsGrantUser = currentUserEsc ? `"${currentUserEsc}:(R)" ` : '';
    const innerScript = [
      "$ErrorActionPreference = 'Stop'",
      "$dstDir = Split-Path -Parent '" + dstEsc + "'",
      "if (!(Test-Path $dstDir)) { New-Item -ItemType Directory -Force -Path $dstDir | Out-Null }",
      "sc.exe stop '" + svcEsc + "' | Out-Null",
      "Start-Sleep -Milliseconds 600",
      "sc.exe delete '" + svcEsc + "' | Out-Null",
      "Start-Sleep -Milliseconds 400",
      "Copy-Item -Force '" + srcEsc + "' '" + dstEsc + "'",
      "[System.IO.File]::WriteAllText('" + secretEsc + "', '" + pipeSecret + "', [System.Text.Encoding]::ASCII)",
      "icacls.exe '" + secretEsc + "' /inheritance:r /grant:r '*S-1-5-18:(F)' '*S-1-5-32-544:(F)' " + icaclsGrantUser + "| Out-Null",
      "$binArg = '\"' + '" + dstEsc + "' + '\" --service'",
      "sc.exe create '" + svcEsc + "' binPath= $binArg start= auto DisplayName= 'AirDesk Elevated Input Service' | Out-Null",
      "sc.exe description '" + svcEsc + "' 'Optional SYSTEM input bridge for AirDesk UAC & lock screen control.' | Out-Null",
      "sc.exe start '" + svcEsc + "' | Out-Null",
    ].join('; ');
    const innerB64 = Buffer.from(innerScript, 'utf16le').toString('base64');
    const outerPs =
      "Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList '-NoProfile -EncodedCommand " +
      innerB64 +
      "'";
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-Command', outerPs], {
        windowsHide: true,
        timeout: 45000,
      });
    } catch {
      return {
        ok: false,
        status: getElevatedServiceStatus(),
        error: '用户取消了管理员 UAC 授权或服务安装失败',
      };
    }

    for (let i = 0; i < 6; i++) {
      const ok = await connectElevatedPipe(1000);
      if (ok) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    const status = getElevatedServiceStatus();
    return { ok: status.running && status.pipeConnected, status };
  }

  function uninstallElevatedService() {
    if (process.platform !== 'win32') {
      return { ok: true, status: getElevatedServiceStatus() };
    }
    disconnectElevatedPipe();
    const dstEsc = ELEVATED_INSTALL_EXE.replace(/'/g, "''");
    const secretEsc = ELEVATED_SECRET_PATH.replace(/'/g, "''");
    const svcEsc = ELEVATED_SERVICE_NAME;
    const innerScript = [
      "sc.exe stop '" + svcEsc + "' | Out-Null",
      "Start-Sleep -Milliseconds 500",
      "sc.exe delete '" + svcEsc + "' | Out-Null",
      "if (Test-Path '" + dstEsc + "') { Remove-Item -Force '" + dstEsc + "' -ErrorAction SilentlyContinue }",
      "if (Test-Path '" + secretEsc + "') { Remove-Item -Force '" + secretEsc + "' -ErrorAction SilentlyContinue }",
    ].join('; ');
    const innerB64 = Buffer.from(innerScript, 'utf16le').toString('base64');
    const outerPs =
      "Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList '-NoProfile -EncodedCommand " +
      innerB64 +
      "'";
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-Command', outerPs], {
        windowsHide: true,
        timeout: 30000,
      });
    } catch {
      return {
        ok: false,
        status: getElevatedServiceStatus(),
        error: '用户取消了管理员 UAC 授权或卸载失败',
      };
    }
    spawnNativeHelper();
    const status = getElevatedServiceStatus();
    return { ok: !status.installed, status };
  }

  function isHelperReady() {
    return Boolean(
      (elevatedPipeClient && elevatedPipeAuthenticated && elevatedPipeClient.writable) ||
        (nativeHelper && !nativeHelper.killed)
    );
  }

  function getLastSecureDesktopActive() {
    return lastSecureDesktopActive;
  }

  function shutdown() {
    if (helperRespawnTimer) {
      clearTimeout(helperRespawnTimer);
      helperRespawnTimer = null;
    }
    disconnectElevatedPipe();
    const helperProc = nativeHelper;
    nativeHelper = null;
    if (helperProc && !helperProc.killed) {
      try {
        if (helperProc.stdin && !helperProc.stdin.destroyed && !helperProc.stdin.writableEnded) {
          helperProc.stdin.end();
        }
      } catch {}
      const killTimer = setTimeout(() => {
        try {
          if (!helperProc.killed) helperProc.kill();
        } catch {}
      }, 120);
      if (typeof killTimer.unref === 'function') killTimer.unref();
    }
  }

  return {
    resolveWinHelperExePath,
    spawnNativeHelper,
    getElevatedServiceStatus,
    connectElevatedPipe,
    disconnectElevatedPipe,
    installElevatedService,
    uninstallElevatedService,
    sendToHelper,
    releaseHeldMouseButtons,
    releaseAllInputs,
    isHelperReady,
    getLastSecureDesktopActive,
    shutdown,
  };
}

module.exports = {
  createNativeHelperManager,
};
