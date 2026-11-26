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
const { pathToFileURL } = require('url');
const QRCode = require('qrcode');
const APP_VERSION = require('../package.json').version;

const { buildEmbeddedMobileClientHtml } = require('./modules/web-client-template.cjs');
const { createVirtualAudioManager } = require('./modules/virtual-audio.cjs');
const { createNativeHelperManager } = require('./modules/native-helper.cjs');
const { createInputRouter } = require('./modules/input-router.cjs');
const { createLanServerManager } = require('./modules/lan-server.cjs');

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
    'WebRTC-Pacer-KeyframeFlushing/Enabled/'
);

// Crisp embedded 16x16 AirDesk icon for Windows Taskbar Tray & macOS Menu Bar
const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABXklEQVR42pVTx07DQBDN3Ym9ttcllTQTk5BAQIAooglRRBWiHFDEAfEj/C4nDiBxemgmxGFApKz0NHqzO+/NtlTq14ieXjEKqf8GTXrNG3itO446voKePYVbO4BT3oYqrcHKL8IM479C/eJb+O0HBJ0eR+I6voAbHcGp7sIurUPluzDDJjJeTYqQm9+6R9B5RNh95kic8m50DKe6B3tmA6qwBCvbYoG0U0DiruNLbt3v9PD2/jkWfYF8vwsWaJzBm7ueqHgAIUBt6sa5WECc8psvH7DLW1DFFSlgZ4cCTnUfbv0wmXSjE+ZUPAAdIO1/sMZQwVCAHJzKjnAgTnkuLizDyrXFvGHpoYAqrvI1TXMGQsDKLXCL5DRpsRAwg5gfiJWdT0BcHJpbRNoOk+JEgEZGV/huTb8O0484EheuKhDFBPGU6WWxyzdGtS7cf4oYyoOhfI5j9z7qV07znb8ALP8YM7c4I94AAAAASUVORK5CYII=';

const APP_ROOT_DIR = path.join(__dirname, '..');
const EXPECTED_RENDERER_URL = pathToFileURL(
  path.join(APP_ROOT_DIR, 'renderer', 'index.html')
).href;

let mainWindow = null;
let tray = null;
let isQuitting = false;
let powerBlockerId = null;
let registeredShortcuts = [];

// Authoritative security & anti-stuck-key state owned strictly by Main Process
let authoritativeControlEnabled = false;
let hasActiveSession = false;
let physicalMouseSilencedUntil = 0;
let lastHeartbeatAt = 0;
let activeDisplayId = '';
const activePressedKeys = new Set();
const activePressedMouseButtons = new Set();

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

const helperManager = createNativeHelperManager({
  app,
  appRootDir: APP_ROOT_DIR,
  getMainWindow: () => mainWindow,
  getIsQuitting: () => isQuitting,
  getAuthoritativeControl: () => authoritativeControlEnabled,
  getHasActiveSession: () => hasActiveSession,
  onPhysicalOverride: (silencedUntil) => {
    physicalMouseSilencedUntil = silencedUntil;
  },
  activePressedKeys,
  activePressedMouseButtons,
});

const virtualAudioManager = createVirtualAudioManager({
  resolveWinHelperExePath: () => helperManager.resolveWinHelperExePath(),
});

const inputRouter = createInputRouter({
  screen,
  getMainWindow: () => mainWindow,
  getActiveDisplayId: () => activeDisplayId,
  getAuthoritativeControl: () => authoritativeControlEnabled,
  getHasActiveSession: () => hasActiveSession,
  getPhysicalMouseSilencedUntil: () => physicalMouseSilencedUntil,
  updateLastHeartbeat: (ts) => {
    lastHeartbeatAt = ts;
  },
  sendToHelper: (payload) => helperManager.sendToHelper(payload),
  releaseAllInputs: (reason) => helperManager.releaseAllInputs(reason),
  activePressedKeys,
  activePressedMouseButtons,
});

const lanServerManager = createLanServerManager({
  app,
  appVersion: APP_VERSION,
  getMainWindow: () => mainWindow,
  getHasActiveSession: () => hasActiveSession,
  getAuthoritativeControl: () => authoritativeControlEnabled,
  getAirDeskDownloadsDir,
  sanitizeFileName,
  allocateUniqueFilePath,
  maxFileTransferBytes: MAX_FILE_TRANSFER_BYTES,
  buildEmbeddedMobileClientHtml,
});

function dispatchHotkeyAction(action, extra) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('airdesk:hotkey-action', Object.assign({ action }, extra || {}));
  }
}

function triggerEmergencyStop(reason) {
  authoritativeControlEnabled = false;
  virtualAudioManager.restoreVirtualAudioOutput();
  abortAllActiveFileReceives();
  lanServerManager.revokeAllTrustedTokens();
  helperManager.releaseAllInputs(reason || 'emergency_stop_hotkey');
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
    helperManager.releaseAllInputs('hotkey_switched_to_view_only');
  }
  lanServerManager.updateActiveTrustedTokenMode(
    authoritativeControlEnabled ? 'full_control' : 'view_only'
  );
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

  mainWindow.loadFile(path.join(APP_ROOT_DIR, 'renderer', 'index.html'));
}

function startPowerSaveBlockerIfNeeded() {
  if (powerBlockerId === null || !powerSaveBlocker.isStarted(powerBlockerId)) {
    powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  }
}

function stopPowerSaveBlockerIfActive() {
  if (powerBlockerId !== null) {
    try {
      if (powerSaveBlocker.isStarted(powerBlockerId)) {
        powerSaveBlocker.stop(powerBlockerId);
      }
    } catch {}
    powerBlockerId = null;
  }
}

app.whenReady().then(async () => {
  activeDisplayId = String(screen.getPrimaryDisplay().id);
  const svcStatus = helperManager.getElevatedServiceStatus();
  const pipeOk = svcStatus.running ? await helperManager.connectElevatedPipe(1200) : false;
  if (!pipeOk) {
    helperManager.spawnNativeHelper();
  }

  // Start built-in local LAN/Hotspot signaling server automatically (non-fatal if port busy)
  try {
    await lanServerManager.startLocalSignalingServer(lanServerManager.getLocalSignalingPort());
  } catch (err) {
    console.warn('[AirDesk Local Signaling] Failed to auto-start:', err.message);
  }

  createWindow();
  createTray();
  registerGlobalShortcuts();

  // Monitor display hot-plug events and push updated list to renderer
  const notifyDisplaysChanged = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('airdesk:displays-changed', inputRouter.getAllDisplayDescriptors());
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
      helperManager.releaseAllInputs('heartbeat_timeout');
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
  inputRouter.clearCursorSyncTimer();
  helperManager.sendToHelper({ t: 'sys:fast_win_anim', enabled: false });
  virtualAudioManager.restoreVirtualAudioOutput();
  abortAllActiveFileReceives();
  helperManager.releaseAllInputs('app_quit');
  lanServerManager.stopLocalSignalingServer();
  globalShortcut.unregisterAll();
  stopPowerSaveBlockerIfActive();
  helperManager.shutdown();
});

// --- High-Frequency One-Way Pointer Channel (Zero Promise Allocation Churn at 60-120Hz) ---
ipcMain.on('airdesk:pointer-fast', (event, msg) => {
  try {
    validateIpcSender(event);
    if (msg && (msg.t === 'm:rel' || msg.t === 'm:abs' || msg.t === 'm:whl')) {
      inputRouter.handleValidatedInput(msg);
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
    interfaces: lanServerManager.getLocalNetworkInterfaces(),
    displays: inputRouter.getAllDisplayDescriptors(),
    helperReady: helperManager.isHelperReady(),
    elevatedService: helperManager.getElevatedServiceStatus(),
    secureDesktopActive: helperManager.getLastSecureDesktopActive(),
    virtualAudio: virtualAudioManager.queryVirtualAudioInfo(),
    defaultSignalingUrl: process.env.AIRDESK_SIGNALING_URL || '',
    localSignaling: lanServerManager.getLocalSignalingInfo(),
    firewall: lanServerManager.checkFirewallRule(lanServerManager.getLocalSignalingPort()),
    shortcuts: registeredShortcuts,
    controlEnabled: authoritativeControlEnabled,
  };
});

ipcMain.handle('airdesk:get-elevated-service-status', async (event) => {
  validateIpcSender(event);
  const st = helperManager.getElevatedServiceStatus();
  if (st.running && !st.pipeConnected) {
    await helperManager.connectElevatedPipe(1000);
    return helperManager.getElevatedServiceStatus();
  }
  return st;
});

ipcMain.handle('airdesk:get-virtual-audio-info', (event) => {
  validateIpcSender(event);
  return virtualAudioManager.queryVirtualAudioInfo();
});

ipcMain.handle('airdesk:set-virtual-audio-route', (event, opts) => {
  validateIpcSender(event);
  const enable = Boolean(opts && typeof opts === 'object' && opts.enable);
  const deviceId = opts && typeof opts === 'object' && typeof opts.deviceId === 'string' ? opts.deviceId : '';
  return virtualAudioManager.setVirtualAudioRoute(enable, deviceId);
});

ipcMain.handle('airdesk:install-elevated-service', async (event) => {
  validateIpcSender(event);
  return helperManager.installElevatedService();
});

ipcMain.handle('airdesk:uninstall-elevated-service', (event) => {
  validateIpcSender(event);
  return helperManager.uninstallElevatedService();
});

ipcMain.handle('airdesk:check-firewall', (event) => {
  validateIpcSender(event);
  return lanServerManager.checkFirewallRule(lanServerManager.getLocalSignalingPort());
});

ipcMain.handle('airdesk:ensure-firewall-rule', (event) => {
  validateIpcSender(event);
  return lanServerManager.ensureFirewallRule(lanServerManager.getLocalSignalingPort());
});

ipcMain.handle('airdesk:usb-direct-setup', (event, opts) => {
  validateIpcSender(event);
  return lanServerManager.setupUsbDirectConnection(
    lanServerManager.getLocalSignalingPort(),
    Boolean(opts && typeof opts === 'object' && opts.openTetherSettings)
  );
});

ipcMain.handle('airdesk:start-local-signaling', async (event, port) => {
  validateIpcSender(event);
  const targetPort = Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 47820;
  return lanServerManager.startLocalSignalingServer(targetPort);
});

ipcMain.handle('airdesk:stop-local-signaling', (event) => {
  validateIpcSender(event);
  return lanServerManager.stopLocalSignalingServer();
});

ipcMain.handle('airdesk:get-trusted-devices', (event) => {
  validateIpcSender(event);
  return lanServerManager.listTrustedDevices();
});

ipcMain.handle('airdesk:revoke-trusted-device', (event, tokenIdOrAll) => {
  validateIpcSender(event);
  if (tokenIdOrAll === '*') {
    lanServerManager.revokeAllTrustedTokens();
  } else if (typeof tokenIdOrAll === 'string' && tokenIdOrAll.length >= 6) {
    lanServerManager.revokeTrustedToken(tokenIdOrAll);
  }
  return lanServerManager.listTrustedDevices();
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
    stopPowerSaveBlockerIfActive();
    inputRouter.clearCursorSyncTimer();
    authoritativeControlEnabled = false;
    virtualAudioManager.restoreVirtualAudioOutput();
    abortAllActiveFileReceives();
    helperManager.releaseAllInputs('session_inactive');
    helperManager.sendToHelper({ t: 'sys:fast_win_anim', enabled: false });
  } else {
    startPowerSaveBlockerIfNeeded();
    helperManager.sendToHelper({ t: 'sys:fast_win_anim', enabled: true });
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
    helperManager.releaseAllInputs('switched_to_view_only');
  }
  lanServerManager.updateActiveTrustedTokenMode(
    authoritativeControlEnabled ? 'full_control' : 'view_only'
  );
  return { controlEnabled: authoritativeControlEnabled };
});

ipcMain.handle('airdesk:heartbeat', (event) => {
  validateIpcSender(event);
  lastHeartbeatAt = Date.now();
  return { ok: true };
});

ipcMain.handle('airdesk:inject-input', (event, msg) => {
  validateIpcSender(event);
  return inputRouter.handleValidatedInput(msg);
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
