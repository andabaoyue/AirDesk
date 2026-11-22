const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  desktopCapturer,
  globalShortcut,
  powerSaveBlocker,
  clipboard,
  screen,
  shell,
} = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const http = require('http');
const dgram = require('dgram');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { spawn, execFileSync } = require('child_process');
const { WebSocketServer, WebSocket } = require('ws');
const QRCode = require('qrcode');
const APP_VERSION = require('../package.json').version;

// Prevent uncaught EPIPE if parent terminal/pipe closes before Electron exits
if (process.stdout && typeof process.stdout.on === 'function') {
  process.stdout.on('error', () => {});
}
if (process.stderr && typeof process.stderr.on === 'function') {
  process.stderr.on('error', () => {});
}

// Force Chromium WebRTC to expose real private LAN / Hotspot IPs instead of .local mDNS
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
// Unlock AMD MediaFoundation hardware H.264 encoder when blocklisted by Chromium
app.commandLine.appendSwitch('ignore-gpu-blocklist');
// Force zero playout delay + 10x pacer burst + aggressive queue drain so sudden window openings never stall
app.commandLine.appendSwitch(
  'force-fieldtrials',
  'WebRTC-ForceSendPlayoutDelay/min_ms:0,max_ms:0/' +
    'WebRTC-VideoRateControl/pacing_factor:10.0/' +
    'WebRTC-Pacer-DrainQueue/Enabled/' +
    'WebRTC-Pacer-KeyframeFlushing/Enabled/' +
    'WebRTC-FrameDropper/Disabled/'
);

// Crisp embedded 16x16 AirDesk icon for Windows Taskbar Tray & macOS Menu Bar
const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABXklEQVR42pVTx07DQBDN3Ym9ttcllTQTk5BAQIAooglRRBWiHFDEAfEj/C4nDiBxemgmxGFApKz0NHqzO+/NtlTq14ieXjEKqf8GTXrNG3itO446voKePYVbO4BT3oYqrcHKL8IM479C/eJb+O0HBJ0eR+I6voAbHcGp7sIurUPluzDDJjJeTYqQm9+6R9B5RNh95kic8m50DKe6B3tmA6qwBCvbYoG0U0DiruNLbt3v9PD2/jkWfYF8vwsWaJzBm7ueqHgAIUBt6sa5WECc8psvH7DLW1DFFSlgZ4cCTnUfbv0wmXSjE+ZUPAAdIO1/sMZQwVCAHJzKjnAgTnkuLizDyrXFvGHpoYAqrvI1TXMGQsDKLXCL5DRpsRAwg5gfiJWdT0BcHJpbRNoOk+JEgEZGV/huTb8O0484EheuKhDFBPGU6WWxyzdGtS7cf4oYyoOhfI5j9z7qV07znb8ALP8YM7c4I94AAAAASUVORK5CYII=';

const EXPECTED_RENDERER_URL = pathToFileURL(
  path.join(__dirname, '..', 'renderer', 'index.html')
).href;

const ALLOWED_INPUT_TYPES = new Set([
  'm:rel',
  'm:abs',
  'm:btn',
  'm:whl',
  'k:down',
  'k:up',
  'k:release_all',
  'text:unicode',
  'sys:sas',
  'sys:fast_win_anim',
]);
const ALLOWED_BUTTONS = new Set(['left', 'right', 'middle']);
const ALLOWED_BTN_STATES = new Set(['down', 'up']);

let mainWindow = null;
let tray = null;
let isQuitting = false;
let powerBlockerId = null;
let nativeHelper = null;
let elevatedPipeClient = null;
let elevatedPipeConnecting = false;
let helperRestartTimestamps = [];
let helperRespawnTimer = null;
let registeredShortcuts = [];

const ELEVATED_SERVICE_NAME = 'AirDeskElevatedInput';
const ELEVATED_PIPE_PATH = '\\\\.\\pipe\\AirDeskElevatedInput';
const ELEVATED_INSTALL_EXE = 'C:\\ProgramData\\AirDesk\\airdesk-elevated-service.exe';
const ELEVATED_SECRET_PATH = 'C:\\ProgramData\\AirDesk\\pipe.secret';

// Built-in local LAN/Hotspot signaling server state (zero public cloud dependency)
let localHttpServer = null;
let localWss = null;
let localUdpDiscoverySocket = null;
let localSignalingPort = 47820;
let localSignalingRunning = false;
const LOCAL_HOST_SIGNALING_SECRET = crypto.randomBytes(24).toString('hex');

// Authoritative security & anti-stuck-key state owned strictly by Main Process
let authoritativeControlEnabled = false;
let hasActiveSession = false;
let physicalMouseSilencedUntil = 0;
let lastHeartbeatAt = 0;
let activeDisplayId = '';
let lastCursorSyncAt = 0;
let cursorSyncTimer = null;
const activePressedKeys = new Set();
const activePressedMouseButtons = new Set();

function resolveNativeAssetPath(filename) {
  const baseDir = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'native')
    : path.join(__dirname, '..', 'native');
  return path.join(baseDir, filename);
}

/**
 * Defense-in-depth IPC origin verification: strictly matches the exact renderer/index.html file URL.
 */
function validateIpcSender(event) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error('Rejected IPC: main window unavailable');
  }
  if (event.sender !== mainWindow.webContents) {
    throw new Error('Rejected IPC: untrusted webContents');
  }
  const frameUrl = (event.senderFrame && event.senderFrame.url) || '';
  if (frameUrl !== EXPECTED_RENDERER_URL) {
    throw new Error('Rejected IPC: unauthorized frame URL ' + frameUrl);
  }
}

/**
 * Secondary validation inside Main Process so security never relies solely on preload.cjs.
 */
function validateInputPayload(msg) {
  if (!msg || typeof msg !== 'object' || !ALLOWED_INPUT_TYPES.has(msg.t)) return false;
  if (msg.t === 'm:rel') {
    return Number.isFinite(msg.dx) && Number.isFinite(msg.dy) && Math.abs(msg.dx) <= 5000 && Math.abs(msg.dy) <= 5000;
  }
  if (msg.t === 'm:abs') {
    return Number.isFinite(msg.x) && Number.isFinite(msg.y) && msg.x >= 0 && msg.x <= 1 && msg.y >= 0 && msg.y <= 1;
  }
  if (msg.t === 'm:whl') {
    const hasDy = Number.isFinite(msg.dy) && Math.abs(msg.dy) <= 500;
    const hasDx = Number.isFinite(msg.dx) && Math.abs(msg.dx) <= 500;
    return (hasDy || hasDx) && (msg.dy === undefined || hasDy) && (msg.dx === undefined || hasDx);
  }
  if (msg.t === 'm:btn') {
    return ALLOWED_BUTTONS.has(msg.button) && ALLOWED_BTN_STATES.has(msg.state);
  }
  if (msg.t === 'k:down' || msg.t === 'k:up') {
    return typeof msg.code === 'string' && msg.code.length > 0 && msg.code.length <= 32;
  }
  if (msg.t === 'text:unicode') {
    return typeof msg.text === 'string' && msg.text.length > 0 && msg.text.length <= 10000;
  }
  return true;
}

function sendToHelper(payload) {
  const line = JSON.stringify(payload) + '\n';
  if (
    elevatedPipeClient &&
    elevatedPipeClient.writable &&
    !elevatedPipeClient.destroyed &&
    !elevatedPipeClient.writableEnded
  ) {
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
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('airdesk:inputs-released', { reason });
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
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('airdesk:inputs-released', { reason });
  }
}

function getAllDisplayDescriptors() {
  const primaryId = String(screen.getPrimaryDisplay().id);
  return screen.getAllDisplays().map((d, idx) => ({
    id: String(d.id),
    label: d.label || '显示器 ' + (idx + 1) + (String(d.id) === primaryId ? '（主屏）' : ''),
    bounds: d.bounds,
    scaleFactor: d.scaleFactor,
    isPrimary: String(d.id) === primaryId,
  }));
}

function resolveTargetDisplay(displayId) {
  const all = screen.getAllDisplays();
  const targetId = displayId || activeDisplayId;
  const exact = all.find((d) => String(d.id) === targetId);
  if (exact) return exact;
  const screenMatch = String(targetId || '').match(/^screen:(\d+):/i);
  if (screenMatch) {
    const idx = Number(screenMatch[1]);
    if (Number.isInteger(idx) && idx >= 0 && idx < all.length) {
      return all[idx];
    }
  }
  return screen.getPrimaryDisplay();
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
  if (isQuitting || helperRespawnTimer) return;
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
    if (!isQuitting) spawnNativeHelper();
  }, delayMs);
}

function spawnNativeHelper() {
  if (nativeHelper && !nativeHelper.killed) return;

  if (process.platform === 'win32') {
    const prebuiltExe = resolveNativeAssetPath('airdesk-win-helper.exe');
    let exeToRun = null;

    if (fs.existsSync(prebuiltExe)) {
      exeToRun = prebuiltExe;
    } else {
      const csFile = resolveNativeAssetPath('win-input-helper.cs');
      if (!fs.existsSync(csFile)) {
        console.warn('[AirDesk] win-input-helper.cs missing at:', csFile);
        return;
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
          return;
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
          return;
        }
      }
      exeToRun = compiledExe;
    }

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
    if (!isQuitting && !(elevatedPipeClient && elevatedPipeClient.writable)) {
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
        const evt = JSON.parse(line);
        if (evt.event === 'physical_mouse_override') {
          if (!hasActiveSession || !authoritativeControlEnabled) continue;
          physicalMouseSilencedUntil = Date.now() + 3000;
          // Immediately release any held remote mouse buttons so dragging never sticks!
          releaseHeldMouseButtons('physical_mouse_override');
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('airdesk:physical-override', {
              silencedUntil: physicalMouseSilencedUntil,
            });
          }
        } else if (evt.event === 'permission_warning' && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('airdesk:inputs-released', {
            reason: evt.message || 'missing_os_permission',
          });
        }
      } catch {
        // Ignore non-JSON helper stdout
      }
    }
  });

  nativeHelper.on('exit', (code) => {
    console.warn('[AirDesk Helper] Exited with code:', code);
    nativeHelper = null;
    if (!isQuitting && !(elevatedPipeClient && elevatedPipeClient.writable)) {
      scheduleHelperRespawn();
    }
  });
}

function handleHelperJsonEvent(evt) {
  if (!evt || typeof evt !== 'object') return;
  if (evt.event === 'physical_mouse_override') {
    if (!hasActiveSession || !authoritativeControlEnabled) return;
    physicalMouseSilencedUntil = Date.now() + 3000;
    releaseHeldMouseButtons('physical_mouse_override');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('airdesk:physical-override', {
        silencedUntil: physicalMouseSilencedUntil,
      });
    }
  } else if (evt.event === 'permission_warning' && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('airdesk:inputs-released', {
      reason: evt.message || 'missing_os_permission',
    });
  }
}

function getElevatedServiceStatus() {
  if (process.platform !== 'win32') {
    return { supported: false, installed: false, running: false, pipeConnected: false };
  }
  const pipeConnected = Boolean(elevatedPipeClient && elevatedPipeClient.writable);
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
  if (elevatedPipeClient && elevatedPipeClient.writable) return Promise.resolve(true);
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
      elevatedPipeClient = client;
      if (helperRespawnTimer) {
        clearTimeout(helperRespawnTimer);
        helperRespawnTimer = null;
      }
      if (nativeHelper && !nativeHelper.killed) {
        try { nativeHelper.kill(); } catch {}
        nativeHelper = null;
      }
      finish(true);
    });

    client.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          handleHelperJsonEvent(JSON.parse(line));
        } catch {}
      }
    });

    client.on('error', () => {
      if (elevatedPipeClient === client) elevatedPipeClient = null;
      finish(false);
    });

    client.on('close', () => {
      const wasActive = elevatedPipeClient === client;
      if (wasActive) elevatedPipeClient = null;
      finish(false);
      if (wasActive && !isQuitting && (!nativeHelper || nativeHelper.killed)) {
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

function isOverlayIp(ip) {
  const s = String(ip || '').trim().replace(/^::ffff:/i, '');
  return /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(s) || /^fd7a:115c:a1e0:/i.test(s);
}

let detectedAdbUsbLanIp = '';

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

function emitCursorPosNow() {
  cursorSyncTimer = null;
  if (!hasActiveSession || !mainWindow || mainWindow.isDestroyed()) return;
  try {
    const pt = screen.getCursorScreenPoint();
    const target = resolveTargetDisplay(activeDisplayId);
    const b = target && target.bounds;
    if (!b || b.width <= 0 || b.height <= 0) return;
    const nx = Math.max(0, Math.min(1, (pt.x - b.x) / b.width));
    const ny = Math.max(0, Math.min(1, (pt.y - b.y) / b.height));
    lastCursorSyncAt = Date.now();
    mainWindow.webContents.send('airdesk:cursor-pos', { x: nx, y: ny });
  } catch {}
}

function scheduleCursorPosSync() {
  const elapsed = Date.now() - lastCursorSyncAt;
  if (elapsed >= 33) {
    if (cursorSyncTimer) {
      clearTimeout(cursorSyncTimer);
      cursorSyncTimer = null;
    }
    emitCursorPosNow();
  } else if (!cursorSyncTimer) {
    cursorSyncTimer = setTimeout(emitCursorPosNow, 33 - elapsed);
  }
}

function handleValidatedInput(msg) {
  if (!validateInputPayload(msg)) {
    return { dropped: true, reason: 'invalid_payload' };
  }

  // Always allow button/key release events even if view-only or silenced to prevent stuck state
  const isReleaseEvent =
    (msg.t === 'm:btn' && msg.state === 'up') || msg.t === 'k:up' || msg.t === 'k:release_all';

  if (!authoritativeControlEnabled && !isReleaseEvent) {
    return { dropped: true, reason: 'view_only' };
  }

  lastHeartbeatAt = Date.now();

  // During 3s physical mouse override, block remote movement/down but ALWAYS pass m:btn up
  if (
    (msg.t === 'm:rel' || msg.t === 'm:abs' || (msg.t === 'm:btn' && msg.state === 'down')) &&
    Date.now() < physicalMouseSilencedUntil
  ) {
    return { dropped: true, reason: 'physical_mouse_priority' };
  }

  if (msg.t === 'k:down' && msg.code) {
    activePressedKeys.add(msg.code);
  } else if (msg.t === 'k:up' && msg.code) {
    activePressedKeys.delete(msg.code);
  } else if (msg.t === 'm:btn' && msg.button) {
    if (msg.state === 'down') activePressedMouseButtons.add(msg.button);
    else activePressedMouseButtons.delete(msg.button);
  } else if (msg.t === 'k:release_all') {
    releaseAllInputs(msg.reason || 'client_requested');
    return { ok: true };
  }

  // Platform-accurate multi-monitor DPI & Retina coordinate mapping
  if (msg.t === 'm:abs') {
    const target = resolveTargetDisplay(msg.displayId);
    const dipPoint = {
      x: Math.round(target.bounds.x + msg.x * target.bounds.width),
      y: Math.round(target.bounds.y + msg.y * target.bounds.height),
    };
    if (process.platform === 'win32') {
      // Electron's dipToScreenPoint handles mixed-DPI multi-monitor layouts accurately
      const phys = screen.dipToScreenPoint(dipPoint);
      sendToHelper({ t: 'm:abs', px: phys.x, py: phys.y });
    } else {
      // macOS CGEvent operates in logical points (DIP), never multiplied by Retina scaleFactor
      sendToHelper({ t: 'm:abs', px: dipPoint.x, py: dipPoint.y });
    }
    scheduleCursorPosSync();
    return { ok: true };
  }

  sendToHelper(msg);
  if (msg.t === 'm:rel') {
    scheduleCursorPosSync();
  }
  return { ok: true };
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

/**
 * Self-contained lightweight mobile receiver served directly from the PC's built-in
 * LAN signaling server so phones on a personal hotspot can scan & control with ZERO internet.
 */
function buildEmbeddedMobileClientHtml() {
  return [
    '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"/>',
    '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover"/>',
    '<meta name="theme-color" content="#05070A"/>',
    '<meta name="mobile-web-app-capable" content="yes"/>',
    '<meta name="apple-mobile-web-app-capable" content="yes"/>',
    '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"/>',
    '<meta name="apple-mobile-web-app-title" content="AirDesk"/>',
    '<link rel="manifest" href="/manifest.webmanifest"/>',
    '<title>AirDesk 本地直连控制端</title>',
    '<style>',
    '*{box-sizing:border-box;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent}',
    'html,body{margin:0;height:100dvh;width:100vw;background:#05070A;color:#F1F5F9;font-family:system-ui,-apple-system,sans-serif;overflow:hidden}',
    '.join{display:flex;align-items:center;justify-content:center;height:100dvh;padding:24px}',
    '.card{max-width:400px;width:100%;background:#131922;border:1px solid #1E293B;border-radius:16px;padding:22px}',
    'input.pin{width:100%;background:#0B0F14;color:#F1F5F9;border:1px solid #334155;border-radius:10px;padding:12px;font-size:28px;letter-spacing:0.25em;text-align:center;font-family:ui-monospace,monospace;user-select:text;-webkit-user-select:text}',
    'button{background:#2563EB;color:#fff;border:0;border-radius:10px;padding:11px 14px;font-weight:600;cursor:pointer;font-size:13px}',
    'button.sec{background:rgba(19,25,34,0.88);border:1px solid #334155;color:#E2E8F0;padding:8px 10px;font-size:12px}',
    'button.danger{background:rgba(220,38,38,0.85);color:#fff;padding:8px 10px;font-size:12px}',
    '.stage-root{position:fixed;inset:0;background:#000;overflow:hidden;display:none}',
    '#videoBox{position:absolute;inset:0;touch-action:none;display:flex;align-items:center;justify-content:center}',
    'video{width:100%;height:100%;object-fit:contain;pointer-events:none}',
    '#iceOverlay{position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:rgba(5,7,10,0.72);backdrop-filter:blur(6px);z-index:20;padding:24px;text-align:center}',
    '#iceOverlayTitle{font-size:15px;font-weight:600;color:#FBBF24}',
    '#iceOverlayDesc{font-size:12px;color:#94A3B8;max-width:320px;line-height:1.5}',
    '#capsule{position:fixed;top:calc(8px + env(safe-area-inset-top));right:calc(10px + env(safe-area-inset-right));z-index:40;display:flex;align-items:center;gap:6px;padding:6px 11px;border-radius:999px;background:rgba(11,15,20,0.68);border:1px solid rgba(148,163,184,0.28);backdrop-filter:blur(10px);color:#E2E8F0;font-size:12px;cursor:pointer;transition:opacity 0.25s}',
    '#capsule.faded{opacity:0.42}',
    '.dot{width:8px;height:8px;border-radius:50%;background:#FBBF24;flex-shrink:0}',
    '.dot.ok{background:#34D399}.dot.err{background:#F87171}',
    '#menuPanel{position:fixed;top:calc(46px + env(safe-area-inset-top));right:calc(10px + env(safe-area-inset-right));z-index:45;width:250px;background:rgba(15,21,30,0.94);border:1px solid #334155;border-radius:14px;padding:12px;backdrop-filter:blur(14px);display:none;flex-direction:column;gap:8px;box-shadow:0 12px 32px rgba(0,0,0,0.55)}',
    '.menu-row{display:grid;grid-template-columns:1fr 1fr;gap:6px}',
    '#menuPanel select{width:100%;background:#0B0F14;color:#F1F5F9;border:1px solid #334155;border-radius:8px;padding:7px 8px;font-size:12px}',
    '#padOverlay{position:fixed;left:0;right:0;bottom:0;height:36%;z-index:25;background:rgba(11,15,20,0.72);backdrop-filter:blur(8px);border-top:1px solid rgba(148,163,184,0.22);display:none;flex-direction:column;padding:8px calc(8px + env(safe-area-inset-right)) calc(8px + env(safe-area-inset-bottom)) calc(8px + env(safe-area-inset-left));gap:8px}',
    '#pad{flex:1;background:rgba(19,25,34,0.65);border:1px solid rgba(148,163,184,0.2);border-radius:12px;touch-action:none;display:flex;align-items:center;justify-content:center;color:#94A3B8;font-size:12px}',
    '#btnVkb{position:fixed;right:calc(12px + env(safe-area-inset-right));bottom:calc(14px + env(safe-area-inset-bottom));z-index:42;display:none;align-items:center;justify-content:center;width:44px;height:44px;border-radius:999px;background:rgba(15,23,42,0.72);border:1px solid rgba(96,165,250,0.55);color:#93C5FD;font-size:18px;backdrop-filter:blur(8px);box-shadow:0 6px 18px rgba(0,0,0,0.45);transition:bottom 0.2s ease}',
    '#btnVkb.open{background:#2563EB;color:#fff;border-color:#60A5FA;bottom:calc(274px + env(safe-area-inset-bottom))}',
    '#vkbPanel{position:fixed;left:0;right:0;bottom:0;z-index:41;display:none;flex-direction:column;gap:5px;padding:8px calc(6px + env(safe-area-inset-right)) calc(8px + env(safe-area-inset-bottom)) calc(6px + env(safe-area-inset-left));background:rgba(9,13,20,0.88);backdrop-filter:blur(12px);border-top:1px solid rgba(148,163,184,0.25)}',
    '.vkb-row{display:flex;gap:4px;justify-content:center}',
    '.vk{flex:1;min-width:0;height:36px;padding:0 4px;border-radius:7px;background:rgba(30,41,59,0.9);border:1px solid rgba(71,85,105,0.6);color:#F1F5F9;font-size:12px;font-family:ui-monospace,monospace;display:flex;align-items:center;justify-content:center;touch-action:manipulation}',
    '.vk:active{background:#2563EB;border-color:#60A5FA}',
    '.vk.w15{flex:1.5}.vk.w2{flex:2}.vk.w4{flex:4}',
    '.vk.mod-on{background:#2563EB;border-color:#93C5FD;color:#fff}',
    '#toast{position:fixed;top:calc(52px + env(safe-area-inset-top));left:50%;transform:translateX(-50%);z-index:50;background:rgba(15,23,42,0.92);border:1px solid #334155;color:#F8FAFC;font-size:12px;padding:6px 12px;border-radius:999px;display:none;white-space:nowrap}',
'#stageView.rotated{position:fixed;top:50%;left:50%;width:100dvh;height:100vw;transform:translate(-50%,-50%) rotate(90deg);transform-origin:center center}',
'#zoomLayer{position:absolute;inset:0;transform-origin:0 0;will-change:transform}',
'#wechatGuide{position:fixed;inset:0;z-index:200;display:none;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:28px;text-align:center;background:#05070A;color:#F1F5F9}',
'#wechatGuide h2{margin:0;font-size:18px;color:#FBBF24}',
'#wechatGuide p{margin:0;font-size:13px;line-height:1.7;color:#CBD5E1;max-width:340px}',
'#wechatGuide .arrow{font-size:26px;color:#60A5FA}',
'#wechatGuide button{width:100%;max-width:300px;margin-top:6px}',
'#wechatGuide code{background:#0B0F14;border:1px solid #334155;border-radius:6px;padding:2px 6px;font-size:12px;word-break:break-all}',
    '</style></head><body>',
'<div id="wechatGuide">',
'<h2>请用系统浏览器打开</h2>',
'<div class="arrow">↗</div>',
'<p>检测到你在微信/QQ 里打开。内置浏览器会强制竖屏、拦截全屏，画面会被压成一条，无法横屏铺满。</p>',
'<p>请点右上角 <b>•••</b> → <b>在浏览器打开</b>（Safari / Chrome / Edge 均可）。</p>',
'<p id="wechatUrl" style="font-size:11px;color:#94A3B8"></p>',
'<button id="btnCopyUrl" class="sec">复制链接</button>',
'<button id="btnIgnoreWechat" class="sec" style="color:#94A3B8">仍要继续（画面可能被压缩）</button>',
'</div>',
    '<div id="joinView" class="join"><div class="card">',
    '<h2 style="margin:0 0 6px;font-size:18px">AirDesk 局域网免流量直连</h2>',
    '<p style="margin:0 0 14px;color:#94A3B8;font-size:12.5px;line-height:1.5">纯净无遮挡全屏模式 · 支持外置蓝牙/OTG 键盘直连 · 可添加到主屏幕无边框打开。</p>',
    '<input id="pin" class="pin" maxlength="6" inputmode="numeric" placeholder="000000"/>',
    '<button id="btnGo" style="width:100%;margin-top:14px">请求连接电脑</button>',
    '<p id="msg" style="color:#FBBF24;font-size:12px;margin:10px 0 0;min-height:16px"></p>',
    '</div></div>',
    '<div id="stageView" class="stage-root">',
    '<div id="videoBox"><div id="zoomLayer"><video id="vid" autoplay playsinline muted></video></div></div>',
    '<div id="iceOverlay"><div id="iceOverlayTitle">正在建立视频通道...</div><div id="iceOverlayDesc">正在通过局域网/手机热点协商 WebRTC 直连</div><button id="btnRetryIce" class="sec" style="display:none">重新连接</button></div>',
    '<div id="capsule"><span id="stDot" class="dot"></span><span id="st">连接中</span></div>',
    '<div id="menuPanel">',
    '<div class="menu-row"><button id="btnMode" class="sec">模式：直触</button><button id="btnPip" class="sec">画中画小窗</button></div>',
    '<div class="menu-row"><button id="btnAudio" class="sec">声音：静音</button><button id="btnFs" class="sec">全屏切换</button></div>',
    '<div class="menu-row"><button id="btnQuality" class="sec">画质：清晰高码</button><button id="btnImeMenu" class="sec">发中文文本</button></div>',
    '<div class="menu-row"><button id="btnClipPull" class="sec">拉电脑剪贴板</button><button id="btnClipPush" class="sec">发剪贴板给电脑</button></div>',
    '<div class="menu-row"><button id="btnSendFileWeb" class="sec">发文件给电脑</button><button id="btnJb" class="sec">缓冲：0ms</button></div>',
    '<input id="webFileInput" type="file" multiple style="display:none"/>',
    '<select id="dispSelect" style="display:none"></select>',
    '<button id="btnOut" class="danger" style="width:100%">断开连接</button>',
    '</div>',
    '<div id="padOverlay"><div id="pad">单指移动 · 轻点左键 · 双指轻点右键 · 双指滚动</div>',
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><button id="mL" class="sec">鼠标左键</button><button id="mR" class="sec">鼠标右键</button></div></div>',
    '<button id="btnVkb" title="弹出/收起虚拟键盘">⌨</button>',
    '<div id="vkbPanel">',
    '<div class="vkb-row">',
    '<button class="vk" data-k="Escape">Esc</button><button class="vk" data-k="Tab">Tab</button>',
    '<button class="vk" data-mod="ControlLeft">Ctrl</button><button class="vk" data-mod="AltLeft">Alt</button>',
    '<button class="vk" data-mod="ShiftLeft">Shift</button><button class="vk" data-mod="MetaLeft">Win</button>',
    '<button class="vk" data-k="Delete">Del</button><button class="vk" id="btnVkbIme" style="color:#93C5FD">中</button>',
    '<button class="vk" id="btnVkbClose" style="color:#FCA5A5">✕</button></div>',
    '<div class="vkb-row">',
    '<button class="vk" data-k="Digit1">1</button><button class="vk" data-k="Digit2">2</button><button class="vk" data-k="Digit3">3</button><button class="vk" data-k="Digit4">4</button><button class="vk" data-k="Digit5">5</button>',
    '<button class="vk" data-k="Digit6">6</button><button class="vk" data-k="Digit7">7</button><button class="vk" data-k="Digit8">8</button><button class="vk" data-k="Digit9">9</button><button class="vk" data-k="Digit0">0</button>',
    '<button class="vk w15" data-k="Backspace">⌫</button></div>',
    '<div class="vkb-row">',
    '<button class="vk" data-k="KeyQ">Q</button><button class="vk" data-k="KeyW">W</button><button class="vk" data-k="KeyE">E</button><button class="vk" data-k="KeyR">R</button><button class="vk" data-k="KeyT">T</button>',
    '<button class="vk" data-k="KeyY">Y</button><button class="vk" data-k="KeyU">U</button><button class="vk" data-k="KeyI">I</button><button class="vk" data-k="KeyO">O</button><button class="vk" data-k="KeyP">P</button></div>',
    '<div class="vkb-row">',
    '<button class="vk" data-k="KeyA">A</button><button class="vk" data-k="KeyS">S</button><button class="vk" data-k="KeyD">D</button><button class="vk" data-k="KeyF">F</button><button class="vk" data-k="KeyG">G</button>',
    '<button class="vk" data-k="KeyH">H</button><button class="vk" data-k="KeyJ">J</button><button class="vk" data-k="KeyK">K</button><button class="vk" data-k="KeyL">L</button><button class="vk w15" data-k="Enter">↵</button></div>',
    '<div class="vkb-row">',
    '<button class="vk" data-k="KeyZ">Z</button><button class="vk" data-k="KeyX">X</button><button class="vk" data-k="KeyC">C</button><button class="vk" data-k="KeyV">V</button><button class="vk" data-k="KeyB">B</button>',
    '<button class="vk" data-k="KeyN">N</button><button class="vk" data-k="KeyM">M</button><button class="vk" data-k="ArrowUp">↑</button><button class="vk" data-k="ArrowDown">↓</button></div>',
    '<div class="vkb-row">',
    '<button class="vk" data-k="ArrowLeft">←</button><button class="vk w4" data-k="Space">Space</button><button class="vk" data-k="ArrowRight">→</button></div>',
    '</div>',
    '<div id="toast"></div>',
    '</div>',
    '<script>',
    'const params=new URLSearchParams(location.search);const pinEl=document.getElementById("pin");',
    'if(params.get("join")){pinEl.value=params.get("join").replace(/\\D/g,"").slice(0,6);try{history.replaceState(null,"",location.pathname);}catch{}}',
    'const TOKEN_KEY="airdesk_session_token";',
    'function getTok(){try{return localStorage.getItem(TOKEN_KEY)||sessionStorage.getItem(TOKEN_KEY)||"";}catch{try{return sessionStorage.getItem(TOKEN_KEY)||"";}catch{return "";}}}',
    'function setTok(v){if(!v)return;try{localStorage.setItem(TOKEN_KEY,v);}catch{}try{sessionStorage.setItem(TOKEN_KEY,v);}catch{}}',
    'function delTok(){try{localStorage.removeItem(TOKEN_KEY);}catch{}try{sessionStorage.removeItem(TOKEN_KEY);}catch{}}',
    'let ws=null,pc=null,rdc=null,udc=null,fdc=null,rxFileMeta=null,rxFileChunks=[],rxFileBytes=0,pingTimer=null,diagTimer=null,prevInSnap=null,fadeTimer=null,toastTimer=null,pendingIce=[],lastRttMs=null,directPointerId=null;',
    'let mode="direct",ctrl=false,seq=1,pts=new Map(),gStart={t:0,m:0,f:0},iceState="new",saverMode=false,vkbEnabled=false,vkbOpen=false,lockedMods=new Set(),manualDisconnect=false,jbSettingMs=0,hostAudioEnabled=false;',
    'const JB_MODES=[{ms:0,label:"缓冲：0ms"},{ms:30,label:"缓冲：30ms"},{ms:50,label:"缓冲：50ms"}];',
    'const sendR=m=>{if(rdc&&rdc.readyState==="open")rdc.send(JSON.stringify(m));};',
    'const sendU=m=>{if(udc&&udc.readyState==="open")udc.send(JSON.stringify(m));};',
    'function toast(t){const el=document.getElementById("toast");el.textContent=t;el.style.display="block";if(toastTimer)clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.style.display="none",2600);}',
    'function pokeCapsule(){capsule.classList.remove("faded");if(fadeTimer)clearTimeout(fadeTimer);fadeTimer=setTimeout(()=>{if(menuPanel.style.display!=="flex")capsule.classList.add("faded");},3200);}',
    'function updateStatusLabel(){const ok=(iceState==="connected"||iceState==="completed");const fail=(iceState==="failed"||iceState==="disconnected");stDot.className="dot"+(ok?" ok":fail?" err":"");if(!ok){st.textContent=fail?"连接断开":"连接中...";return;}const modeText=ctrl?"可控":"只读";const rttText=lastRttMs!==null?(" "+lastRttMs+"ms"):"";st.textContent=modeText+rttText;}',
    'function updateIceOverlay(){if(iceState==="connected"||iceState==="completed"){iceOverlay.style.display="none";return;}iceOverlay.style.display="flex";if(iceState==="failed"||iceState==="disconnected"){iceOverlayTitle.textContent="视频通道已断开或被拦截 ("+iceState+")";iceOverlayTitle.style.color="#FCA5A5";iceOverlayDesc.textContent="请确认同热点/Wi-Fi、Windows 防火墙已放行公用网络，且代理 TUN 已绕过局域网网段";btnRetryIce.style.display="inline-block";}else{iceOverlayTitle.textContent="正在建立视频通道 ("+iceState+")...";iceOverlayTitle.style.color="#FBBF24";iceOverlayDesc.textContent="局域网/手机热点 0 流量直连握手中";btnRetryIce.style.display="none";}}',
    'function setVkbVisible(open){vkbOpen=Boolean(open&&vkbEnabled);vkbPanel.style.display=vkbOpen?"flex":"none";btnVkb.classList.toggle("open",vkbOpen);if(!vkbOpen)clearLockedMods();}',
    'function applyVkbFeatureFlag(enabled){vkbEnabled=Boolean(enabled);btnVkb.style.display=vkbEnabled?"flex":"none";if(!vkbEnabled)setVkbVisible(false);}',
    'function clearLockedMods(){if(!lockedMods.size)return;for(const k of Array.from(lockedMods)){sendR({t:"k:up",code:k});}lockedMods.clear();document.querySelectorAll("[data-mod]").forEach(b=>b.classList.remove("mod-on"));}',
    'function closeSocketSilently(){if(!ws)return;ws.onopen=null;ws.onmessage=null;ws.onerror=null;ws.onclose=null;try{ws.close();}catch{}ws=null;}',
    'function cleanupRtc(){if(pingTimer){clearInterval(pingTimer);pingTimer=null;}if(diagTimer){clearInterval(diagTimer);diagTimer=null;}prevInSnap=null;clearLockedMods();pendingIce=[];lastRttMs=null;iceState="new";rxFileMeta=null;rxFileChunks=[];rxFileBytes=0;if(fdc){try{fdc.close();}catch{}fdc=null;}if(rdc){try{rdc.close();}catch{}rdc=null;}if(udc){try{udc.close();}catch{}udc=null;}if(pc){try{pc.close();}catch{}pc=null;}}',
    'function getNormalizedVideoPoint(clientX,clientY){const r=vid.getBoundingClientRect();if(!r.width||!r.height)return null;const vw=vid.videoWidth||r.width,vh=vid.videoHeight||r.height;const va=vw/vh,ba=r.width/r.height;let drawW=r.width,drawH=r.height,drawLeft=r.left,drawTop=r.top;if(ba>va){drawW=r.height*va;drawLeft=r.left+(r.width-drawW)/2;}else{drawH=r.width/va;drawTop=r.top+(r.height-drawH)/2;}const x=Math.max(0,Math.min(1,(clientX-drawLeft)/drawW));const y=Math.max(0,Math.min(1,(clientY-drawTop)/drawH));return{x,y};}',
    'function connectWith(payload){manualDisconnect=false;cleanupRtc();closeSocketSilently();const proto=location.protocol==="https:"?"wss:":"ws:";const sock=new WebSocket(proto+"//"+location.host+"/ws/signaling");ws=sock;sock.onopen=()=>sock.send(JSON.stringify(Object.assign({type:"client:join",deviceLabel:"手机直连端",platformHint:"LAN Mobile"},payload)));sock.onmessage=async e=>{if(ws!==sock)return;let m;try{m=JSON.parse(e.data);}catch{return;}if(m.type==="client:waiting_approval")msg.textContent="等待电脑审批（可在电脑按 Ctrl+Alt+Y 批准）...";else if(m.type==="client:rejected"||m.type==="error"){if(payload.sessionToken){delTok();stageView.style.display="none";joinView.style.display="flex";const fallbackCode=pinEl.value.replace(/\\D/g,"");if(fallbackCode.length===6){msg.textContent="自动重连凭证失效，正在使用配对码连接...";connect();return;}}msg.textContent=m.reason||m.message||"连接被拒绝";}else if(m.type==="client:approved"){if(m.sessionToken)setTok(m.sessionToken);ctrl=m.mode==="full_control";hostAudioEnabled=Boolean(m.audioEnabled);await startRtc();}else if(m.type==="rtc:answer"&&pc){await pc.setRemoteDescription({type:"answer",sdp:m.sdp});for(const cand of pendingIce){await pc.addIceCandidate(cand).catch(()=>{});}pendingIce=[];}else if(m.type==="rtc:ice"){if(pc&&pc.remoteDescription){pc.addIceCandidate(m.candidate).catch(()=>{});}else{pendingIce.push(m.candidate);}}else if(m.type==="session:permission_updated"){ctrl=Boolean(m.controlEnabled);updateStatusLabel();toast(ctrl?"已开启操控":"已切换为只读");}else if(m.type==="session:closed"){cleanupRtc();stageView.style.display="none";joinView.style.display="flex";msg.textContent=m.reason||"电脑端已关闭共享";}};sock.onclose=()=>{if(ws!==sock)return;cleanupRtc();updateStatusLabel();updateIceOverlay();};sock.onerror=()=>{if(ws!==sock)return;msg.textContent="无法连接本地信令，请确认同热点/Wi-Fi 且防火墙已放行 47820 端口";};}',
    'function connect(){const code=pinEl.value.replace(/\\D/g,"");if(code.length===6){connectWith({code});return;}const tok=getTok();if(tok){connectWith({sessionToken:tok});return;}msg.textContent="请输入 6 位配对码";}',
    'const CLASH_RE=/^198\\.1[89]\\./;const TS_RE=/^100\\.(6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\./;const ALLOW_OVERLAY=TS_RE.test(location.hostname||"");const isVirtual=cs=>{const a=String(cs||"").split(" ")[4]||"";if(CLASH_RE.test(a))return true;if(!ALLOW_OVERLAY&&TS_RE.test(a))return true;return false;};',
    'function pickLowLatencyH264(codecs){var h264=(codecs||[]).filter(function(c){return c.mimeType&&c.mimeType.toLowerCase()==="video/h264";});var score=function(c){var f=String(c.sdpFmtpLine||"").toLowerCase();if(f.indexOf("42e01f")>=0)return 0;if(f.indexOf("42001f")>=0)return 1;if(f.indexOf("42e0")>=0||f.indexOf("4200")>=0)return 2;return 3;};h264.sort(function(a,b){return score(a)-score(b);});return h264;}',
    'function applyReceiverJitterToOne(r,ms){if(!r)return;var sec=ms/1000;try{if("jitterBufferTarget" in r)r.jitterBufferTarget=ms;}catch(e){}try{if("playoutDelayHint" in r)r.playoutDelayHint=sec;}catch(e){}try{if("jitterBufferDelayHint" in r)r.jitterBufferDelayHint=sec;}catch(e){}}',
    'function applyReceiverJitterTarget(ms){if(!pc)return;pc.getReceivers().forEach(function(r){if(r&&r.track&&r.track.kind==="video")applyReceiverJitterToOne(r,ms);});}',
    'async function collectAndSendRxDiag(){if(!pc||!rdc||rdc.readyState!=="open")return;try{const rep=await pc.getStats();let inStat=null;rep.forEach(s=>{if(s.type==="inbound-rtp"&&s.kind==="video")inStat=s;});if(!inStat)return;let rxFps=typeof inStat.framesPerSecond==="number"?+inStat.framesPerSecond.toFixed(1):null;let decodeMs=null,jbMs=null,jbTargetStatMs=null,jbMinMs=null;const framesDec=typeof inStat.framesDecoded==="number"?inStat.framesDecoded:0;const totDec=typeof inStat.totalDecodeTime==="number"?inStat.totalDecodeTime:0;const jbEmit=typeof inStat.jitterBufferEmittedCount==="number"?inStat.jitterBufferEmittedCount:0;const jbDel=typeof inStat.jitterBufferDelay==="number"?inStat.jitterBufferDelay:0;const jbTDel=typeof inStat.jitterBufferTargetDelay==="number"?inStat.jitterBufferTargetDelay:null;const jbMDel=typeof inStat.jitterBufferMinimumDelay==="number"?inStat.jitterBufferMinimumDelay:null;if(prevInSnap){const dt=(inStat.timestamp-prevInSnap.ts)/1000;const dF=framesDec-prevInSnap.framesDecoded;const dDecT=totDec-prevInSnap.totalDecodeTime;const dEmit=jbEmit-prevInSnap.jbEmit;if(dt>0&&dF>=0){rxFps=+(dF/dt).toFixed(1);if(dF>0&&dDecT>=0)decodeMs=+(dDecT/dF*1000).toFixed(2);}if(dEmit>=5){const dJb=jbDel-prevInSnap.jbDelay;if(dJb>=0)jbMs=Math.round(dJb/dEmit*1000);if(jbTDel!==null&&prevInSnap.jbTargetDelay!==null){const dT=jbTDel-prevInSnap.jbTargetDelay;if(dT>=0)jbTargetStatMs=Math.round(dT/dEmit*1000);}if(jbMDel!==null&&prevInSnap.jbMinDelay!==null){const dM=jbMDel-prevInSnap.jbMinDelay;if(dM>=0)jbMinMs=Math.round(dM/dEmit*1000);}}}prevInSnap={ts:inStat.timestamp,framesDecoded:framesDec,totalDecodeTime:totDec,jbEmit:jbEmit,jbDelay:jbDel,jbTargetDelay:jbTDel,jbMinDelay:jbMDel};sendR({t:"diag:rx",rxFps:rxFps!==null?rxFps:0,decodeMs:decodeMs,decoder:inStat.decoderImplementation||null,hw:typeof inStat.powerEfficientDecoder==="boolean"?inStat.powerEfficientDecoder:null,jbMs:jbMs,jbTargetMs:jbTargetStatMs,jbMinMs:jbMinMs,jbSettingMs:jbSettingMs,dropped:inStat.framesDropped||0,freezes:inStat.freezeCount||0,w:inStat.frameWidth||vid.videoWidth||0,h:inStat.frameHeight||vid.videoHeight||0});}catch{}}',
    'async function startRtc(){cleanupRtc();joinView.style.display="none";stageView.style.display="block";if(isPortrait())applyCssLandscape();requestLandscape();iceState="checking";updateStatusLabel();updateIceOverlay();pokeCapsule();pc=new RTCPeerConnection({iceServers:[],bundlePolicy:"max-bundle",rtcpMuxPolicy:"require"});pc.addEventListener("iceconnectionstatechange",()=>{if(!pc)return;iceState=pc.iceConnectionState;updateStatusLabel();updateIceOverlay();});var vtr=pc.addTransceiver("video",{direction:"recvonly"});if(hostAudioEnabled)pc.addTransceiver("audio",{direction:"recvonly"});applyReceiverJitterToOne(vtr&&vtr.receiver,jbSettingMs);(function(){try{var rc=RTCRtpReceiver.getCapabilities("video");if(!rc||!rc.codecs||!vtr||!vtr.setCodecPreferences)return;var h2=pickLowLatencyH264(rc.codecs);if(h2.length)vtr.setCodecPreferences(h2);}catch(e){console.warn("[AirDesk] mobile H264 (video-only) rejected:",e&&e.name,e&&e.message);}})();rdc=pc.createDataChannel("ctrl-reliable",{ordered:true});udc=pc.createDataChannel("input-unreliable",{ordered:false,maxRetransmits:0});fdc=pc.createDataChannel("file-transfer",{ordered:true});fdc.binaryType="arraybuffer";fdc.onmessage=ev=>{if(typeof ev.data==="string"){let fm;try{fm=JSON.parse(ev.data);}catch{return;}if(fm.t==="file:offer"){if(rxFileMeta){fdc.send(JSON.stringify({t:"file:reject",id:fm.id,reason:"busy"}));return;}const sz=Number(fm.size)||0;if(sz<0||sz>104857600){fdc.send(JSON.stringify({t:"file:reject",id:fm.id,reason:"Web端单文件上限100MB"}));toast("Web端单文件上限100MB，大文件请用原生App或局域网快传");return;}rxFileMeta={id:fm.id,name:fm.name||"file",size:sz,mime:fm.mime||"application/octet-stream"};rxFileChunks=[];rxFileBytes=0;toast("正在接收电脑文件："+rxFileMeta.name);fdc.send(JSON.stringify({t:"file:accept",id:fm.id}));}else if(fm.t==="file:done"&&rxFileMeta&&rxFileMeta.id===fm.id){const meta=rxFileMeta;const got=rxFileBytes;const chunks=rxFileChunks;rxFileMeta=null;rxFileChunks=[];rxFileBytes=0;if(got!==meta.size){fdc.send(JSON.stringify({t:"file:ack",id:meta.id,ok:false,message:"文件分片不完整"}));toast("接收失败：文件分片不完整");return;}const blob=new Blob(chunks,{type:meta.mime});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=meta.name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),4000);fdc.send(JSON.stringify({t:"file:ack",id:meta.id,ok:true,savedName:meta.name}));toast("已接收文件："+meta.name);}else if(fm.t==="file:cancel"){rxFileMeta=null;rxFileChunks=[];rxFileBytes=0;}}else if(rxFileMeta){const n=ev.data.byteLength||0;if(rxFileBytes+n>104857600){const badId=rxFileMeta.id;rxFileMeta=null;rxFileChunks=[];rxFileBytes=0;fdc.send(JSON.stringify({t:"file:cancel",id:badId,reason:"size_exceeded"}));return;}rxFileChunks.push(ev.data);rxFileBytes+=n;}};rdc.onopen=()=>{collectAndSendRxDiag();};rdc.onmessage=ev=>{try{const d=JSON.parse(ev.data);if(d.t==="perm"){ctrl=Boolean(d.controlEnabled);updateStatusLabel();toast(ctrl?"已开启操控":"已切换为只读");}else if(d.t==="ui:config"){applyVkbFeatureFlag(Boolean(d.virtualKeyboardEnabled));if(typeof d.audioEnabled==="boolean"&&d.audioEnabled!==hostAudioEnabled){hostAudioEnabled=d.audioEnabled;const tok=getTok();if(tok){toast(hostAudioEnabled?"电脑已开启声音，正在无感重连...":"电脑已关闭声音，切回纯画面...");connectWith({sessionToken:tok});}}}else if(d.t==="pong"&&typeof d.ts==="number"){lastRttMs=Math.max(1,Date.now()-d.ts);updateStatusLabel();}else if(d.t==="displays:list"&&Array.isArray(d.displays)){dispSelect.innerHTML="";d.displays.forEach(dp=>{const o=document.createElement("option");o.value=dp.id;o.textContent="切换屏幕："+dp.label;dispSelect.appendChild(o);});if(d.activeDisplayId)dispSelect.value=d.activeDisplayId;dispSelect.style.display=d.displays.length>1?"block":"none";}else if(d.t==="clip:data"){if(d.text&&navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(d.text).then(()=>toast("已复制电脑剪贴板")).catch(()=>prompt("电脑剪贴板内容：",d.text));}else if(d.text){prompt("电脑剪贴板内容：",d.text);}else{toast("电脑剪贴板为空");}}}catch{}};const stream=new MediaStream();pc.ontrack=ev=>{stream.addTrack(ev.track);if(ev.track&&ev.track.kind==="video")applyReceiverJitterToOne(ev.receiver,jbSettingMs);applyReceiverJitterTarget(jbSettingMs);vid.srcObject=stream;vid.play().catch(()=>{});};vid.onplaying=()=>{if(iceState!=="connected"&&iceState!=="completed"){iceState="connected";updateStatusLabel();updateIceOverlay();}};pc.onicecandidate=ev=>{if(ev.candidate&&ws&&ws.readyState===1&&!isVirtual(ev.candidate.candidate))ws.send(JSON.stringify({type:"rtc:ice",candidate:ev.candidate}));};const offer=await pc.createOffer();await pc.setLocalDescription(offer);ws.send(JSON.stringify({type:"rtc:offer",sdp:offer.sdp}));pingTimer=setInterval(()=>sendR({t:"ping",ts:Date.now()}),1000);diagTimer=setInterval(collectAndSendRxDiag,2000);}',
'const UA=navigator.userAgent||"";const IS_EMBEDDED=["MicroMessenger","QQ/","AlipayClient","Weibo"].some(function(k){return UA.indexOf(k)>=0;});',
'let forcedLandscape=false,zoomScale=1,zoomTx=0,zoomTy=0;',
'function showWechatGuide(){if(!IS_EMBEDDED)return false;wechatGuide.style.display="flex";const u=document.getElementById("wechatUrl");if(u)u.textContent=location.href;return true;}',
'btnCopyUrl.onclick=()=>{const txt=location.href;const done=()=>toast("链接已复制，粘贴到浏览器打开");if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(txt).then(done).catch(()=>{prompt("复制以下链接到浏览器打开：",txt);});}else{prompt("复制以下链接到浏览器打开：",txt);}};',
'btnIgnoreWechat.onclick=()=>{wechatGuide.style.display="none";};',
'async function requestLandscape(){',
'  if(!stageView||stageView.style.display==="none")return;',
'  try{if(screen.orientation&&screen.orientation.lock){await screen.orientation.lock("landscape");return;}}catch(e){}',
'  applyCssLandscape();',
'}',
'function isPortrait(){return window.innerHeight>window.innerWidth;}',
'function applyCssLandscape(){',
'  if(!isPortrait()){stageView.classList.remove("rotated");forcedLandscape=false;return;}',
'  stageView.classList.add("rotated");forcedLandscape=true;',
'}',
'function clearCssLandscape(){stageView.classList.remove("rotated");forcedLandscape=false;}',
'function applyZoom(){const z=document.getElementById("zoomLayer");if(z)z.style.transform="translate("+zoomTx+"px,"+zoomTy+"px) scale("+zoomScale+")";}',
'function resetZoom(){zoomScale=1;zoomTx=0;zoomTy=0;applyZoom();}',
'(function bindPinch(){',
'  let startDist=0,startScale=1,startTx=0,startTy=0,startCx=0,startCy=0,panning=false;',
'  const dist=(a,b)=>Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY);',
'  videoBox.addEventListener("touchstart",e=>{',
'    if(e.touches.length===2){panning=false;startDist=dist(e.touches[0],e.touches[1]);startScale=zoomScale;startTx=zoomTx;startTy=zoomTy;startCx=(e.touches[0].clientX+e.touches[1].clientX)/2;startCy=(e.touches[0].clientY+e.touches[1].clientY)/2;e.preventDefault();}',
'    else if(e.touches.length===1&&zoomScale>1){panning=true;startTx=zoomTx;startTy=zoomTy;startCx=e.touches[0].clientX;startCy=e.touches[0].clientY;}',
'  },{passive:false});',
'  videoBox.addEventListener("touchmove",e=>{',
'    if(e.touches.length===2&&startDist>0){',
'      const s=Math.min(3,Math.max(1,startScale*dist(e.touches[0],e.touches[1])/startDist));',
'      zoomScale=s;zoomTx=startTx;zoomTy=startTy;applyZoom();e.preventDefault();',
'    }else if(panning&&e.touches.length===1&&zoomScale>1){',
'      zoomTx=startTx+(e.touches[0].clientX-startCx);zoomTy=startTy+(e.touches[0].clientY-startCy);applyZoom();e.preventDefault();',
'    }',
'  },{passive:false});',
'  videoBox.addEventListener("touchend",e=>{if(e.touches.length<2)startDist=0;if(e.touches.length===0)panning=false;},{passive:true});',
'})();',
'window.addEventListener("orientationchange",()=>{setTimeout(()=>{if(stageView.style.display!=="none"){if(isPortrait())applyCssLandscape();else clearCssLandscape();}resetZoom();},260);});',
    'setTimeout(()=>{const blocked=showWechatGuide();const tok=getTok();if(!blocked&&tok)connectWith({sessionToken:tok});},0);',
    'btnGo.onclick=connect;',
    'btnRetryIce.onclick=()=>{const tok=getTok();if(tok)connectWith({sessionToken:tok});else{stageView.style.display="none";joinView.style.display="flex";}};',
    'capsule.onclick=()=>{const show=menuPanel.style.display!=="flex";menuPanel.style.display=show?"flex":"none";pokeCapsule();};',
    'btnOut.onclick=()=>{manualDisconnect=true;clearCssLandscape();resetZoom();cleanupRtc();closeSocketSilently();menuPanel.style.display="none";stageView.style.display="none";joinView.style.display="flex";msg.textContent="已断开连接";};',
    'btnFs.onclick=()=>{menuPanel.style.display="none";if(!document.fullscreenElement)document.documentElement.requestFullscreen().catch(()=>toast("当前浏览器不支持全屏"));else document.exitFullscreen().catch(()=>{});};',
    'btnPip.onclick=async()=>{menuPanel.style.display="none";try{if(document.pictureInPictureElement)await document.exitPictureInPicture();else if(vid.requestPictureInPicture)await vid.requestPictureInPicture();else toast("当前浏览器不支持画中画小窗");}catch{toast("无法进入画中画，请先等画面开始播放");}};',
    'btnAudio.onclick=()=>{vid.muted=!vid.muted;btnAudio.textContent=vid.muted?"声音：静音":"声音：开启";if(!vid.muted)vid.play().catch(()=>{});};',
    'btnMode.onclick=()=>{mode=mode==="direct"?"trackpad":"direct";btnMode.textContent=mode==="direct"?"模式：直触":"模式：触控板";padOverlay.style.display=mode==="trackpad"?"flex":"none";menuPanel.style.display="none";};',
    'btnQuality.onclick=()=>{saverMode=!saverMode;btnQuality.textContent=saverMode?"画质：20fps 省电":"画质：清晰高码";sendR({t:"policy",preset:saverMode?"office_saver":"balanced",maxBitrateKbps:saverMode?4000:12000});toast(saverMode?"已切换至 20fps 省电档":"已切换至清晰高码档");};',
    'dispSelect.onchange=()=>{if(dispSelect.value)sendR({t:"display:switch",displayId:dispSelect.value});menuPanel.style.display="none";};',
    'btnClipPull.onclick=()=>{sendR({t:"clip:pull"});menuPanel.style.display="none";};',
    'btnClipPush.onclick=()=>{menuPanel.style.display="none";const t=prompt("输入要发送到电脑剪贴板的文本：");if(t){sendR({t:"clip:push",text:t});toast("已发送到电脑剪贴板");}};',
    'btnJb.onclick=()=>{const idx=JB_MODES.findIndex(x=>x.ms===jbSettingMs);const next=JB_MODES[(idx+1)%JB_MODES.length];jbSettingMs=next.ms;btnJb.textContent=next.label;applyReceiverJitterTarget(jbSettingMs);toast("已切换至 "+next.label);};',
    'btnSendFileWeb.onclick=()=>{menuPanel.style.display="none";webFileInput.click();};',
    'webFileInput.onchange=async()=>{const files=Array.from(webFileInput.files||[]);webFileInput.value="";for(const f of files){toast("正在发送："+f.name);try{const res=await fetch("/api/lan-files/upload?name="+encodeURIComponent(f.name),{method:"POST",headers:{"X-AirDesk-Token":getTok(),"X-AirDesk-Pin":pinEl.value.replace(/\\D/g,"")},body:f});const j=await res.json();if(res.ok&&j.ok)toast("已发送至电脑："+j.savedName);else toast("发送失败："+(j.error||res.status));}catch(err){toast("发送失败："+err.message);}}};',
    'const openIme=()=>{if(!ctrl){toast("当前为只读模式");return;}const t=prompt("输入要发送给电脑的中文或文本：");if(t)sendR({t:"text:unicode",text:t});};',
    'btnImeMenu.onclick=()=>{menuPanel.style.display="none";openIme();};btnVkbIme.onclick=openIme;',
    'btnVkb.onclick=()=>setVkbVisible(!vkbOpen);btnVkbClose.onclick=()=>setVkbVisible(false);',
    'document.querySelectorAll("[data-mod]").forEach(b=>b.onclick=()=>{if(!ctrl){toast("当前为只读模式");return;}const k=b.dataset.mod;if(lockedMods.has(k)){lockedMods.delete(k);b.classList.remove("mod-on");sendR({t:"k:up",code:k});}else{lockedMods.add(k);b.classList.add("mod-on");sendR({t:"k:down",code:k});}});',
    'document.querySelectorAll("[data-k]").forEach(b=>b.onclick=()=>{if(!ctrl){toast("当前为只读模式");return;}const k=b.dataset.k;sendR({t:"k:down",code:k});setTimeout(()=>{sendR({t:"k:up",code:k});clearLockedMods();},45);});',
    'function pDown(e){if(!ctrl)return;e.currentTarget.setPointerCapture(e.pointerId);pts.set(e.pointerId,{x:e.clientX,y:e.clientY});if(pts.size===1)gStart={t:performance.now(),m:0,f:1};else gStart.f=Math.max(gStart.f,pts.size);}',
    'function pMove(e){if(!ctrl)return;const p=pts.get(e.pointerId);if(!p)return;const dx=e.clientX-p.x,dy=e.clientY-p.y;pts.set(e.pointerId,{x:e.clientX,y:e.clientY});gStart.m+=Math.hypot(dx,dy);if(pts.size>=2)sendU({t:"m:whl",dx:0,dy:dy*0.15});else sendU({t:"m:rel",dx:Math.round(dx*1.8),dy:Math.round(dy*1.8),seq:seq++});}',
    'function pUp(e){if(!pts.has(e.pointerId))return;pts.delete(e.pointerId);if(pts.size===0&&ctrl&&performance.now()-gStart.t<260&&gStart.m<14){const b=gStart.f>=2?"right":"left";sendR({t:"m:btn",button:b,state:"down"});setTimeout(()=>sendR({t:"m:btn",button:b,state:"up"}),45);}}',
    'pad.onpointerdown=pDown;pad.onpointermove=pMove;pad.onpointerup=pUp;pad.onpointercancel=pUp;',
    'function endDirectTouch(e){if(directPointerId!==null&&(!e||e.pointerId===directPointerId)){directPointerId=null;sendR({t:"m:btn",button:"left",state:"up"});}}',
    'videoBox.onpointerdown=e=>{menuPanel.style.display="none";pokeCapsule();if(!ctrl)return;if(mode==="direct"){const pt=getNormalizedVideoPoint(e.clientX,e.clientY);if(!pt)return;directPointerId=e.pointerId;try{videoBox.setPointerCapture(e.pointerId);}catch{}sendR({t:"m:abs",x:pt.x,y:pt.y});sendR({t:"m:btn",button:"left",state:"down"});}else pDown(e);};',
    'videoBox.onpointermove=e=>{if(!ctrl)return;if(mode==="direct"){if(directPointerId!==e.pointerId)return;const pt=getNormalizedVideoPoint(e.clientX,e.clientY);if(!pt)return;sendU({t:"m:abs",x:pt.x,y:pt.y,seq:seq++});}else pMove(e);};',
    'videoBox.onpointerup=e=>{if(mode==="direct")endDirectTouch(e);else pUp(e);};',
    'videoBox.onpointercancel=e=>{if(mode==="direct")endDirectTouch(e);else pUp(e);};',
    'const releaseL=()=>sendR({t:"m:btn",button:"left",state:"up"});const releaseR=()=>sendR({t:"m:btn",button:"right",state:"up"});',
    'mL.onpointerdown=()=>{if(ctrl)sendR({t:"m:btn",button:"left",state:"down"});};mL.onpointerup=releaseL;mL.onpointercancel=releaseL;',
    'mR.onpointerdown=()=>{if(ctrl)sendR({t:"m:btn",button:"right",state:"down"});};mR.onpointerup=releaseR;mR.onpointercancel=releaseR;',
    'const PREVENT_CODES=new Set(["Tab","Space","Backspace","Escape","AltLeft","AltRight","ArrowUp","ArrowDown","ArrowLeft","ArrowRight","F1","F2","F3","F4","F5","F6","F7","F8","F9","F10","F11","F12"]);',
    'function isTypingInField(){const el=document.activeElement;return Boolean(el&&(el.tagName==="INPUT"||el.tagName==="TEXTAREA"||el.isContentEditable));}',
    'window.addEventListener("keydown",e=>{if(!ctrl||stageView.style.display==="none"||isTypingInField()||!e.code)return;if(PREVENT_CODES.has(e.code)||e.ctrlKey||e.altKey||e.metaKey)e.preventDefault();sendR({t:"k:down",code:e.code});});',
    'window.addEventListener("keyup",e=>{if(!ctrl||stageView.style.display==="none"||isTypingInField()||!e.code)return;if(PREVENT_CODES.has(e.code)||e.ctrlKey||e.altKey||e.metaKey)e.preventDefault();sendR({t:"k:up",code:e.code});});',
    'window.addEventListener("blur",()=>{clearLockedMods();if(ctrl)sendR({t:"k:release_all",reason:"client_blur"});});',
    'document.addEventListener("visibilitychange",()=>{if(document.hidden){clearLockedMods();if(ctrl)sendR({t:"k:release_all",reason:"client_hidden"});return;}if(!manualDisconnect&&stageView.style.display!=="none"){const tok=getTok();const broken=!ws||ws.readyState!==1||!pc||iceState==="failed"||iceState==="disconnected"||iceState==="closed";if(tok&&broken){toast("切回前台，正在自动重连...");connectWith({sessionToken:tok});}}});',
    '</script></body></html>',
  ].join('');
}

const PAIR_CODE_TTL_MS = 30 * 60 * 1000; // 30 分钟
const TRUSTED_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
let revokeAllTrustedTokensCallback = null;
let revokeOneTrustedTokenCallback = null;
let listLiveTrustedTokensCallback = null;
let updateActiveTrustedTokenModeCallback = null;

function notifyTrustedDevicesUpdated() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('airdesk:trusted-devices-updated');
  }
}

function getTrustedTokensPath() {
  return path.join(app.getPath('userData'), 'trusted-tokens.json');
}

function normalizeTrustedTokenRecord(rec) {
  return {
    mode: rec.mode || 'view_only',
    deviceLabel: String(rec.deviceLabel || '局域网移动设备').slice(0, 64),
    platformHint: String(rec.platformHint || 'Mobile').slice(0, 32),
    ipMasked: String(rec.ipMasked || 'LAN').slice(0, 64),
    createdAt: Number.isFinite(rec.createdAt) ? rec.createdAt : Date.now(),
    lastSeenAt: Number.isFinite(rec.lastSeenAt) ? rec.lastSeenAt : Date.now(),
    expiresAt: rec.expiresAt,
  };
}

function loadPersistedTrustedTokens() {
  const map = new Map();
  try {
    const filePath = getTrustedTokensPath();
    if (!fs.existsSync(filePath)) return map;
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const nowTs = Date.now();
    if (raw && typeof raw === 'object') {
      for (const [tok, rec] of Object.entries(raw)) {
        if (
          typeof tok === 'string' &&
          tok.length >= 16 &&
          rec &&
          Number.isFinite(rec.expiresAt) &&
          rec.expiresAt > nowTs
        ) {
          map.set(tok, normalizeTrustedTokenRecord(rec));
        }
      }
    }
  } catch {
    // Non-fatal token load error
  }
  return map;
}

function savePersistedTrustedTokens(tokensMap) {
  try {
    const filePath = getTrustedTokensPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const out = {};
    const nowTs = Date.now();
    if (tokensMap) {
      for (const [tok, rec] of tokensMap.entries()) {
        if (rec && rec.expiresAt > nowTs) {
          out[tok] = normalizeTrustedTokenRecord(rec);
        }
      }
    }
    fs.writeFileSync(filePath, JSON.stringify(out, null, 2), 'utf8');
  } catch {
    // Non-fatal token save error
  }
}

function formatTrustedDeviceList(tokensMap) {
  const nowTs = Date.now();
  const list = [];
  if (!tokensMap) return list;
  for (const [tok, rec] of tokensMap.entries()) {
    if (!rec || rec.expiresAt <= nowTs) continue;
    list.push({
      tokenId: tok.slice(0, 10),
      mode: rec.mode || 'view_only',
      deviceLabel: rec.deviceLabel || '局域网移动设备',
      platformHint: rec.platformHint || 'Mobile',
      ipMasked: rec.ipMasked || 'LAN',
      createdAt: rec.createdAt || nowTs,
      lastSeenAt: rec.lastSeenAt || nowTs,
      expiresAt: rec.expiresAt,
    });
  }
  list.sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
  return list;
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
        if (room.trustedTokens) room.trustedTokens.clear();
        room.activeSessionToken = null;
        if (room.activeClientWs) {
          sendWs(room.activeClientWs, {
            type: 'session:permission_updated',
            controlEnabled: false,
            reason: '电脑端已清空所有免密凭证',
          });
        }
      }
      savePersistedTrustedTokens(null);
      notifyTrustedDevicesUpdated();
    };

    revokeOneTrustedTokenCallback = (tokenPrefix) => {
      if (!tokenPrefix || typeof tokenPrefix !== 'string') return;
      let updatedMap = null;
      for (const room of new Set(roomsByCode.values())) {
        if (!room.trustedTokens) continue;
        for (const tok of Array.from(room.trustedTokens.keys())) {
          if (tok.startsWith(tokenPrefix)) {
            room.trustedTokens.delete(tok);
            if (room.activeSessionToken === tok) {
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
        }
        updatedMap = room.trustedTokens;
      }
      if (updatedMap) {
        savePersistedTrustedTokens(updatedMap);
      } else {
        const persisted = loadPersistedTrustedTokens();
        for (const tok of Array.from(persisted.keys())) {
          if (tok.startsWith(tokenPrefix)) persisted.delete(tok);
        }
        savePersistedTrustedTokens(persisted);
      }
      notifyTrustedDevicesUpdated();
    };

    listLiveTrustedTokensCallback = () => {
      for (const room of new Set(roomsByCode.values())) {
        if (room.trustedTokens) return formatTrustedDeviceList(room.trustedTokens);
      }
      return formatTrustedDeviceList(loadPersistedTrustedTokens());
    };

    updateActiveTrustedTokenModeCallback = (nextMode) => {
      if (nextMode !== 'full_control' && nextMode !== 'view_only') return;
      for (const room of new Set(roomsByCode.values())) {
        if (room.activeSessionToken && room.trustedTokens && room.trustedTokens.has(room.activeSessionToken)) {
          const rec = room.trustedTokens.get(room.activeSessionToken);
          if (rec) {
            rec.mode = nextMode;
            savePersistedTrustedTokens(room.trustedTokens);
            notifyTrustedDevicesUpdated();
          }
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

      const tok = String(req.headers['x-airdesk-token'] || '').trim();
      if (tok && tok.length >= 16) {
        let matchedRec = null;
        for (const room of new Set(roomsByCode.values())) {
          const rec = room.trustedTokens && room.trustedTokens.get(tok);
          if (rec && rec.expiresAt > nowTs) {
            matchedRec = rec;
            break;
          }
        }
        if (!matchedRec) {
          const persisted = loadPersistedTrustedTokens();
          const prec = persisted.get(tok);
          if (prec && prec.expiresAt > nowTs) matchedRec = prec;
        }
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
        res.end(JSON.stringify({ ok: true, mode: 'local_embedded_signaling', version: APP_VERSION, port: localSignalingPort, lanFileTransfer: true }));
        return;
      }
      if (urlPath === '/api/discover') {
        const info = getLocalSignalingInfo();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(
          JSON.stringify({
            ok: true,
            service: 'airdesk',
            version: APP_VERSION,
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
          if (received > MAX_FILE_TRANSFER_BYTES) {
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
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('airdesk:lan-file-received', {
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
          'Content-Disposition': 'attachment; filename*=UTF-8\'\'' + encodeURIComponent(reqName),
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
            trustedTokens: loadPersistedTrustedTokens(),
          };
          roomsByCode.set(code, room);
          socketRoom.set(ws, { room, role: 'host' });
          sendWs(ws, { type: 'host:created', code, expiresAt: room.expiresAt });
          return;
        }
        if (msg.type === 'client:join') {
          const isOverlayPeer = isOverlayIp(maskedIp);
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
              sendWs(ws, { type: 'error', message: '自动重连凭证已过期，请重新扫码或输入 6 位配对码' });
              return;
            }
            if (matchedRoom.activeClientWs && matchedRoom.activeClientWs !== ws) {
              const staleWs = matchedRoom.activeClientWs;
              matchedRoom.activeClientWs = null;
              socketRoom.delete(staleWs);
              try { staleWs.close(); } catch {}
            }
            matchedRoom.activeClientWs = ws;
            matchedRoom.activeSessionToken = msg.sessionToken;
            socketRoom.set(ws, { room: matchedRoom, role: 'client' });
            tokenRecord.expiresAt = nowTs + TRUSTED_TOKEN_TTL_MS;
            tokenRecord.lastSeenAt = nowTs;
            tokenRecord.ipMasked = maskedIp;
            if (msg.deviceLabel) tokenRecord.deviceLabel = String(msg.deviceLabel).slice(0, 64);
            if (msg.platformHint) tokenRecord.platformHint = String(msg.platformHint).slice(0, 32);
            savePersistedTrustedTokens(matchedRoom.trustedTokens);
            notifyTrustedDevicesUpdated();
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
            if (room.activeSessionToken && room.trustedTokens && room.trustedTokens.has(room.activeSessionToken)) {
              room.trustedTokens.get(room.activeSessionToken).mode = msg.activeMode;
              savePersistedTrustedTokens(room.trustedTokens);
              notifyTrustedDevicesUpdated();
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
          const sessionToken = crypto.randomBytes(16).toString('hex');
          room.activeSessionToken = sessionToken;
          const nowTs = Date.now();
          room.trustedTokens.set(sessionToken, {
            mode: approvedMode,
            deviceLabel: pendingMeta.deviceLabel || '局域网移动设备',
            platformHint: pendingMeta.platformHint || 'Mobile',
            ipMasked: pendingMeta.ipMasked || 'LAN',
            createdAt: nowTs,
            lastSeenAt: nowTs,
            expiresAt: nowTs + TRUSTED_TOKEN_TTL_MS,
          });
          savePersistedTrustedTokens(room.trustedTokens);
          notifyTrustedDevicesUpdated();
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
          if (room.trustedTokens) {
            room.trustedTokens.clear();
            savePersistedTrustedTokens(room.trustedTokens);
            notifyTrustedDevicesUpdated();
          }
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
      listLiveTrustedTokensCallback = null;
      updateActiveTrustedTokenModeCallback = null;
    });

    server.once('error', (err) => {
      clearInterval(ttlTimer);
      localSignalingRunning = false;
      revokeAllTrustedTokensCallback = null;
      revokeOneTrustedTokenCallback = null;
      listLiveTrustedTokensCallback = null;
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
              version: APP_VERSION,
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
  listLiveTrustedTokensCallback = null;
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

function dispatchHotkeyAction(action, extra) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('airdesk:hotkey-action', Object.assign({ action }, extra || {}));
  }
}

function triggerEmergencyStop(reason) {
  authoritativeControlEnabled = false;
  abortAllActiveFileReceives();
  if (revokeAllTrustedTokensCallback) {
    revokeAllTrustedTokensCallback();
  } else {
    savePersistedTrustedTokens(null);
  }
  releaseAllInputs(reason || 'emergency_stop_hotkey');
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('airdesk:emergency-stop');
  }
}

function toggleAuthoritativeControlFromHotkey() {
  if (!hasActiveSession) {
    authoritativeControlEnabled = false;
    dispatchHotkeyAction('toggle-control-blocked', {
      reason: '当前尚未建立手机连接，Ctrl+Alt+L 切权仅在活跃会话期间生效',
    });
    return;
  }
  authoritativeControlEnabled = !authoritativeControlEnabled;
  if (!authoritativeControlEnabled) {
    abortAllActiveFileReceives();
    releaseAllInputs('hotkey_switched_to_view_only');
  }
  if (updateActiveTrustedTokenModeCallback) {
    updateActiveTrustedTokenModeCallback(authoritativeControlEnabled ? 'full_control' : 'view_only');
  }
  dispatchHotkeyAction('toggle-control', { controlEnabled: authoritativeControlEnabled });
}

function registerGlobalShortcuts() {
  const definitions = [
    {
      accelerator: 'CommandOrControl+Alt+S',
      label: 'Ctrl+Alt+S',
      desc: '一键启动 / 停止屏幕串流与配对',
      handler: () => dispatchHotkeyAction('toggle-stream'),
    },
    {
      accelerator: 'CommandOrControl+Alt+M',
      label: 'Ctrl+Alt+M',
      desc: '多显示器循环切换当前共享屏幕',
      handler: () => dispatchHotkeyAction('cycle-display'),
    },
    {
      accelerator: 'CommandOrControl+Alt+L',
      label: 'Ctrl+Alt+L',
      desc: '一键切换「允许操控 / 仅观看（只读）」',
      handler: () => toggleAuthoritativeControlFromHotkey(),
    },
    {
      accelerator: 'CommandOrControl+Alt+Y',
      label: 'Ctrl+Alt+Y',
      desc: '收到连接请求时快速批准（允许操控）',
      handler: () => dispatchHotkeyAction('approve-full'),
    },
    {
      accelerator: 'CommandOrControl+Alt+N',
      label: 'Ctrl+Alt+N',
      desc: '收到连接请求时快速拒绝',
      handler: () => dispatchHotkeyAction('reject-request'),
    },
    {
      accelerator: 'CommandOrControl+Alt+Escape',
      label: 'Ctrl+Alt+Esc',
      desc: '物理急停（立刻断权 + 释放所有按键）',
      handler: () => triggerEmergencyStop('emergency_stop_hotkey'),
    },
  ];

  registeredShortcuts = definitions.map((def) => {
    let ok = false;
    try {
      ok = globalShortcut.register(def.accelerator, def.handler);
    } catch {
      ok = false;
    }
    return { label: def.label, desc: def.desc, active: ok };
  });
}

function createTray() {
  try {
    const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
    tray = new Tray(icon);
    tray.setToolTip('AirDesk Desktop Host (托盘常驻 · 全局快捷键已就绪)');
    const menu = Menu.buildFromTemplate([
      {
        label: '显示 AirDesk 控制台',
        click: () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.show();
            mainWindow.focus();
          }
        },
      },
      { type: 'separator' },
      {
        label: '启动 / 停止串流 (Ctrl+Alt+S)',
        click: () => dispatchHotkeyAction('toggle-stream'),
      },
      {
        label: '切换共享显示器 (Ctrl+Alt+M)',
        click: () => dispatchHotkeyAction('cycle-display'),
      },
      {
        label: '切换操控 / 只读模式 (Ctrl+Alt+L)',
        click: () => toggleAuthoritativeControlFromHotkey(),
      },
      {
        label: '物理急停并释放按键 (Ctrl+Alt+Esc)',
        click: () => triggerEmergencyStop('tray_emergency_stop'),
      },
      { type: 'separator' },
      {
        label: '退出 AirDesk Host',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]);
    tray.setContextMenu(menu);
    tray.on('double-click', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  } catch {
    // Tray icon optional on headless systems
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1060,
    height: 740,
    minWidth: 880,
    minHeight: 620,
    backgroundColor: '#070B11',
    autoHideMenuBar: true,
    title: 'AirDesk Desktop Host',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);

  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url !== EXPECTED_RENDERER_URL) e.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Minimize to tray instead of killing active streams when closing window
  mainWindow.on('close', (e) => {
    if (!isQuitting && tray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  activeDisplayId = String(screen.getPrimaryDisplay().id);
  const svcStatus = getElevatedServiceStatus();
  const pipeOk = svcStatus.running ? await connectElevatedPipe(1200) : false;
  if (!pipeOk) {
    spawnNativeHelper();
  }

  // Start built-in local LAN/Hotspot signaling server automatically (non-fatal if port busy)
  try {
    await startLocalSignalingServer(localSignalingPort);
  } catch (err) {
    console.warn('[AirDesk Local Signaling] Failed to auto-start:', err.message);
  }

  createWindow();
  createTray();
  registerGlobalShortcuts();

  // Monitor display hot-plug events and push updated list to renderer
  const notifyDisplaysChanged = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('airdesk:displays-changed', getAllDisplayDescriptors());
    }
  };
  screen.on('display-added', notifyDisplaysChanged);
  screen.on('display-removed', notifyDisplaysChanged);
  screen.on('display-metrics-changed', notifyDisplaysChanged);

  setInterval(() => {
    if (
      authoritativeControlEnabled &&
      lastHeartbeatAt > 0 &&
      Date.now() - lastHeartbeatAt > 3000 &&
      (activePressedKeys.size > 0 || activePressedMouseButtons.size > 0)
    ) {
      releaseAllInputs('heartbeat_timeout');
    }
  }, 1000);
});

app.on('activate', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
  } else {
    createWindow();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !tray) {
    isQuitting = true;
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  if (helperRespawnTimer) clearTimeout(helperRespawnTimer);
  if (cursorSyncTimer) {
    clearTimeout(cursorSyncTimer);
    cursorSyncTimer = null;
  }
  sendToHelper({ t: 'sys:fast_win_anim', enabled: false });
  abortAllActiveFileReceives();
  releaseAllInputs('app_quit');
  stopLocalSignalingServer();
  globalShortcut.unregisterAll();
  if (powerBlockerId !== null) powerSaveBlocker.stop(powerBlockerId);
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
});

// --- High-Frequency One-Way Pointer Channel (Zero Promise Allocation Churn at 60-120Hz) ---
ipcMain.on('airdesk:pointer-fast', (event, msg) => {
  try {
    validateIpcSender(event);
    if (msg && (msg.t === 'm:rel' || msg.t === 'm:abs' || msg.t === 'm:whl')) {
      handleValidatedInput(msg);
    }
  } catch {
    // Drop unauthorized frame events silently
  }
});

// --- Reliable Request/Response Control Channels ---
ipcMain.handle('airdesk:get-system-info', (event) => {
  validateIpcSender(event);
  return {
    hostname: os.hostname(),
    platform: process.platform,
    interfaces: getLocalNetworkInterfaces(),
    displays: getAllDisplayDescriptors(),
    helperReady: Boolean((elevatedPipeClient && elevatedPipeClient.writable) || (nativeHelper && !nativeHelper.killed)),
    elevatedService: getElevatedServiceStatus(),
    defaultSignalingUrl: process.env.AIRDESK_SIGNALING_URL || '',
    localSignaling: getLocalSignalingInfo(),
    firewall: checkFirewallRule(localSignalingPort),
    shortcuts: registeredShortcuts,
    controlEnabled: authoritativeControlEnabled,
  };
});

ipcMain.handle('airdesk:get-elevated-service-status', async (event) => {
  validateIpcSender(event);
  const st = getElevatedServiceStatus();
  if (st.running && !st.pipeConnected) {
    await connectElevatedPipe(1000);
    return getElevatedServiceStatus();
  }
  return st;
});

ipcMain.handle('airdesk:install-elevated-service', async (event) => {
  validateIpcSender(event);
  return installElevatedService();
});

ipcMain.handle('airdesk:uninstall-elevated-service', (event) => {
  validateIpcSender(event);
  return uninstallElevatedService();
});

ipcMain.handle('airdesk:check-firewall', (event) => {
  validateIpcSender(event);
  return checkFirewallRule(localSignalingPort);
});

ipcMain.handle('airdesk:ensure-firewall-rule', (event) => {
  validateIpcSender(event);
  return ensureFirewallRule(localSignalingPort);
});

ipcMain.handle('airdesk:usb-direct-setup', (event, opts) => {
  validateIpcSender(event);
  return setupUsbDirectConnection(
    localSignalingPort,
    Boolean(opts && typeof opts === 'object' && opts.openTetherSettings)
  );
});

ipcMain.handle('airdesk:start-local-signaling', async (event, port) => {
  validateIpcSender(event);
  const targetPort = Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 47820;
  return startLocalSignalingServer(targetPort);
});

ipcMain.handle('airdesk:stop-local-signaling', (event) => {
  validateIpcSender(event);
  return stopLocalSignalingServer();
});

ipcMain.handle('airdesk:get-trusted-devices', (event) => {
  validateIpcSender(event);
  if (listLiveTrustedTokensCallback) {
    return listLiveTrustedTokensCallback();
  }
  return formatTrustedDeviceList(loadPersistedTrustedTokens());
});

ipcMain.handle('airdesk:revoke-trusted-device', (event, tokenIdOrAll) => {
  validateIpcSender(event);
  if (tokenIdOrAll === '*') {
    if (revokeAllTrustedTokensCallback) revokeAllTrustedTokensCallback();
    else {
      savePersistedTrustedTokens(null);
      notifyTrustedDevicesUpdated();
    }
  } else if (typeof tokenIdOrAll === 'string' && tokenIdOrAll.length >= 6) {
    if (revokeOneTrustedTokenCallback) revokeOneTrustedTokenCallback(tokenIdOrAll);
    else {
      const persisted = loadPersistedTrustedTokens();
      for (const tok of Array.from(persisted.keys())) {
        if (tok.startsWith(tokenIdOrAll)) persisted.delete(tok);
      }
      savePersistedTrustedTokens(persisted);
      notifyTrustedDevicesUpdated();
    }
  }
  if (listLiveTrustedTokensCallback) {
    return listLiveTrustedTokensCallback();
  }
  return formatTrustedDeviceList(loadPersistedTrustedTokens());
});

ipcMain.handle('airdesk:generate-qr', async (event, text) => {
  validateIpcSender(event);
  if (typeof text !== 'string' || text.length === 0 || text.length > 512) {
    return { dataUrl: '' };
  }
  const dataUrl = await QRCode.toDataURL(text, {
    width: 196,
    margin: 2,
    color: { dark: '#0B0F14', light: '#FFFFFF' },
  });
  return { dataUrl };
});

ipcMain.handle('airdesk:get-screen-sources', async (event) => {
  validateIpcSender(event);
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 0, height: 0 },
  });
  const allDisplays = screen.getAllDisplays();
  return sources.map((s, idx) => {
    const matched =
      allDisplays.find((d) => String(d.id) === String(s.display_id)) ||
      allDisplays[idx] ||
      screen.getPrimaryDisplay();
    return {
      id: s.id,
      name: s.name,
      displayId: matched ? String(matched.id) : String(s.display_id || s.id),
    };
  });
});

ipcMain.handle('airdesk:set-active-display', (event, displayId) => {
  validateIpcSender(event);
  if (typeof displayId !== 'string' || displayId.length > 64) {
    throw new Error('Invalid displayId');
  }
  activeDisplayId = displayId;
  return { ok: true, displayId: activeDisplayId };
});

ipcMain.handle('airdesk:set-session-active', (event, active) => {
  validateIpcSender(event);
  hasActiveSession = Boolean(active);
  if (!hasActiveSession) {
    if (cursorSyncTimer) {
      clearTimeout(cursorSyncTimer);
      cursorSyncTimer = null;
    }
    authoritativeControlEnabled = false;
    abortAllActiveFileReceives();
    releaseAllInputs('session_inactive');
    sendToHelper({ t: 'sys:fast_win_anim', enabled: false });
  } else {
    sendToHelper({ t: 'sys:fast_win_anim', enabled: true });
  }
  return { hasActiveSession, controlEnabled: authoritativeControlEnabled };
});

ipcMain.handle('airdesk:set-control-permission', (event, enabled) => {
  validateIpcSender(event);
  if (enabled && !hasActiveSession) {
    authoritativeControlEnabled = false;
    return { controlEnabled: false, blocked: true };
  }
  authoritativeControlEnabled = Boolean(enabled);
  if (!authoritativeControlEnabled) {
    abortAllActiveFileReceives();
    releaseAllInputs('switched_to_view_only');
  }
  if (updateActiveTrustedTokenModeCallback) {
    updateActiveTrustedTokenModeCallback(authoritativeControlEnabled ? 'full_control' : 'view_only');
  }
  return { controlEnabled: authoritativeControlEnabled };
});

ipcMain.handle('airdesk:heartbeat', (event) => {
  validateIpcSender(event);
  lastHeartbeatAt = Date.now();
  return { ok: true };
});

ipcMain.handle('airdesk:inject-input', (event, msg) => {
  validateIpcSender(event);
  return handleValidatedInput(msg);
});

ipcMain.handle('airdesk:clipboard-read', (event) => {
  validateIpcSender(event);
  if (!authoritativeControlEnabled) return { text: '', denied: true };
  return { text: clipboard.readText() };
});

ipcMain.handle('airdesk:clipboard-write', (event, text) => {
  validateIpcSender(event);
  if (!authoritativeControlEnabled) return { ok: false, denied: true };
  if (typeof text === 'string' && text.length <= 100000) {
    clipboard.writeText(text);
    return { ok: true };
  }
  return { ok: false, denied: true };
});

// --- WebRTC Independent File Transfer Storage & Lifecycle (Downloads/AirDesk) ---
const MAX_FILE_TRANSFER_BYTES = 500 * 1024 * 1024;
const activeFileReceives = new Map();

function getAirDeskDownloadsDir() {
  const dir = path.join(app.getPath('downloads'), 'AirDesk');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sanitizeFileName(name) {
  const base = path.basename(String(name || '').trim());
  const cleaned = base
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 160)
    .trim();
  return cleaned || 'airdesk-file.bin';
}

function allocateUniqueFilePath(dir, safeName) {
  const ext = path.extname(safeName);
  const stem = ext ? safeName.slice(0, -ext.length) : safeName;
  let candidateName = safeName;
  let candidatePath = path.join(dir, candidateName);
  let idx = 1;
  while (fs.existsSync(candidatePath) || fs.existsSync(candidatePath + '.part')) {
    candidateName = stem + ' (' + idx + ')' + ext;
    candidatePath = path.join(dir, candidateName);
    idx++;
  }
  return { finalName: candidateName, finalPath: candidatePath };
}

function abortAllActiveFileReceives() {
  for (const [id, rec] of Array.from(activeFileReceives.entries())) {
    activeFileReceives.delete(id);
    if (rec.fh) {
      rec.fh.close().catch(() => {}).finally(() => {
        try {
          if (rec.tempPath && fs.existsSync(rec.tempPath)) fs.unlinkSync(rec.tempPath);
        } catch {}
      });
    } else {
      try {
        if (rec.tempPath && fs.existsSync(rec.tempPath)) fs.unlinkSync(rec.tempPath);
      } catch {}
    }
  }
}

ipcMain.handle('airdesk:file-recv-begin', async (event, meta) => {
  validateIpcSender(event);
  if (!authoritativeControlEnabled) {
    return { ok: false, reason: '当前为只读模式，需先开启操控权限才可向电脑传文件' };
  }
  if (!meta || typeof meta !== 'object') {
    return { ok: false, reason: '无效的文件元数据' };
  }
  const transferId = String(meta.id || '').slice(0, 64);
  const expectedSize = Number(meta.size);
  if (!transferId || !Number.isFinite(expectedSize) || expectedSize < 0 || expectedSize > MAX_FILE_TRANSFER_BYTES) {
    return { ok: false, reason: '文件大小超出上限 (500MB) 或参数无效' };
  }
  if (activeFileReceives.size >= 4) {
    return { ok: false, reason: '当前正在接收文件，请等待传输完成' };
  }
  if (activeFileReceives.has(transferId)) {
    return { ok: false, reason: '重复的传输任务 ID' };
  }
  try {
    const dir = getAirDeskDownloadsDir();
    const safeName = sanitizeFileName(meta.name);
    const { finalName, finalPath } = allocateUniqueFilePath(dir, safeName);
    const tempPath = finalPath + '.part';
    const fh = await fs.promises.open(tempPath, 'w');
    activeFileReceives.set(transferId, {
      fh,
      tempPath,
      finalPath,
      finalName,
      expectedSize,
      receivedBytes: 0,
    });
    return { ok: true, finalName };
  } catch (err) {
    return { ok: false, reason: '创建本地接收文件失败: ' + err.message };
  }
});

ipcMain.handle('airdesk:file-recv-chunk', async (event, payload) => {
  validateIpcSender(event);
  if (!authoritativeControlEnabled) {
    abortAllActiveFileReceives();
    return { ok: false, reason: 'permission_revoked' };
  }
  if (!payload || typeof payload !== 'object') {
    return { ok: false, reason: 'invalid_chunk_payload' };
  }
  const rec = activeFileReceives.get(String(payload.transferId || ''));
  if (!rec) {
    return { ok: false, reason: 'transfer_not_found' };
  }
  try {
    const buf = Buffer.isBuffer(payload.chunk)
      ? payload.chunk
      : Buffer.from(
          payload.chunk instanceof ArrayBuffer
            ? new Uint8Array(payload.chunk)
            : payload.chunk
        );
    if (rec.receivedBytes + buf.length > Math.min(MAX_FILE_TRANSFER_BYTES, rec.expectedSize)) {
      return { ok: false, reason: 'file_size_exceeded' };
    }
    await rec.fh.write(buf, 0, buf.length);
    rec.receivedBytes += buf.length;
    return { ok: true, receivedBytes: rec.receivedBytes };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
});

ipcMain.handle('airdesk:file-recv-end', async (event, payload) => {
  validateIpcSender(event);
  if (!payload || typeof payload !== 'object') {
    return { ok: false, reason: 'invalid_end_payload' };
  }
  const transferId = String(payload.transferId || '');
  const rec = activeFileReceives.get(transferId);
  if (!rec) {
    return { ok: false, reason: 'transfer_not_found' };
  }
  activeFileReceives.delete(transferId);
  try {
    if (rec.fh) await rec.fh.close();
  } catch {}
  try {
    if (payload.commit) {
      if (!authoritativeControlEnabled) {
        if (fs.existsSync(rec.tempPath)) fs.unlinkSync(rec.tempPath);
        return { ok: false, reason: '当前为只读模式，已取消文件落盘' };
      }
      if (rec.receivedBytes !== rec.expectedSize) {
        if (fs.existsSync(rec.tempPath)) fs.unlinkSync(rec.tempPath);
        return {
          ok: false,
          reason: '文件传输不完整 (' + rec.receivedBytes + '/' + rec.expectedSize + ' B)',
        };
      }
      fs.renameSync(rec.tempPath, rec.finalPath);
      return {
        ok: true,
        finalName: rec.finalName,
        savedPath: rec.finalPath,
        receivedBytes: rec.receivedBytes,
      };
    }
    if (fs.existsSync(rec.tempPath)) fs.unlinkSync(rec.tempPath);
    return { ok: true, aborted: true };
  } catch (err) {
    try {
      if (fs.existsSync(rec.tempPath)) fs.unlinkSync(rec.tempPath);
    } catch {}
    return { ok: false, reason: err.message };
  }
});

ipcMain.handle('airdesk:open-downloads-folder', async (event) => {
  validateIpcSender(event);
  const dir = getAirDeskDownloadsDir();
  await shell.openPath(dir);
  return { ok: true, dir };
});
