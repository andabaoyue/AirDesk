const { contextBridge, ipcRenderer } = require('electron');

const FAST_POINTER_TYPES = new Set(['m:rel', 'm:abs', 'm:whl']);
const RELIABLE_INPUT_TYPES = new Set(['m:btn', 'k:down', 'k:up', 'k:release_all', 'text:unicode', 'sys:sas']);

const airdeskAPI = Object.freeze({
  getSystemInfo: () => ipcRenderer.invoke('airdesk:get-system-info'),
  getScreenSources: () => ipcRenderer.invoke('airdesk:get-screen-sources'),
  setActiveDisplay: (displayId) => {
    if (typeof displayId !== 'string' || displayId.length > 64) {
      return Promise.reject(new Error('Invalid displayId'));
    }
    return ipcRenderer.invoke('airdesk:set-active-display', displayId);
  },
  setSessionActive: (active) =>
    ipcRenderer.invoke('airdesk:set-session-active', Boolean(active)),
  setControlPermission: (enabled) =>
    ipcRenderer.invoke('airdesk:set-control-permission', Boolean(enabled)),
  sendHeartbeat: () => ipcRenderer.invoke('airdesk:heartbeat'),

  // Fire-and-forget one-way IPC for 60-120Hz mouse moves & wheel (zero Promise overhead)
  sendPointerFast: (payload) => {
    if (!payload || typeof payload !== 'object' || !FAST_POINTER_TYPES.has(payload.t)) return;
    ipcRenderer.send('airdesk:pointer-fast', payload);
  },

  // Reliable invoke channel for clicks, stateful key down/up, and Unicode IME text
  injectInput: (payload) => {
    if (!payload || typeof payload !== 'object') {
      return Promise.resolve({ dropped: true, reason: 'invalid_payload' });
    }
    if (FAST_POINTER_TYPES.has(payload.t)) {
      ipcRenderer.send('airdesk:pointer-fast', payload);
      return Promise.resolve({ ok: true });
    }
    if (!RELIABLE_INPUT_TYPES.has(payload.t)) {
      return Promise.resolve({ dropped: true, reason: 'invalid_payload' });
    }
    return ipcRenderer.invoke('airdesk:inject-input', payload);
  },

  readClipboard: () => ipcRenderer.invoke('airdesk:clipboard-read'),
  writeClipboard: (text) => {
    if (typeof text !== 'string' || text.length > 100000) {
      return Promise.resolve({ ok: false, denied: true });
    }
    return ipcRenderer.invoke('airdesk:clipboard-write', text);
  },
  fileRecvBegin: (meta) => ipcRenderer.invoke('airdesk:file-recv-begin', meta),
  fileRecvChunk: (transferId, chunk) =>
    ipcRenderer.invoke('airdesk:file-recv-chunk', { transferId: String(transferId || ''), chunk }),
  fileRecvEnd: (transferId, commit) =>
    ipcRenderer.invoke('airdesk:file-recv-end', {
      transferId: String(transferId || ''),
      commit: Boolean(commit),
    }),
  openDownloadsFolder: () => ipcRenderer.invoke('airdesk:open-downloads-folder'),
  onLanFileReceived: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('airdesk:lan-file-received', listener);
    return () => ipcRenderer.removeListener('airdesk:lan-file-received', listener);
  },
  getElevatedServiceStatus: () => ipcRenderer.invoke('airdesk:get-elevated-service-status'),
  installElevatedService: () => ipcRenderer.invoke('airdesk:install-elevated-service'),
  uninstallElevatedService: () => ipcRenderer.invoke('airdesk:uninstall-elevated-service'),
  getVirtualAudioInfo: () => ipcRenderer.invoke('airdesk:get-virtual-audio-info'),
  setVirtualAudioRoute: (opts) =>
    ipcRenderer.invoke(
      'airdesk:set-virtual-audio-route',
      opts && typeof opts === 'object'
        ? {
            enable: Boolean(opts.enable),
            deviceId: typeof opts.deviceId === 'string' ? opts.deviceId : '',
          }
        : { enable: false, deviceId: '' }
    ),
  startLocalSignaling: (port) => ipcRenderer.invoke('airdesk:start-local-signaling', port),
  stopLocalSignaling: () => ipcRenderer.invoke('airdesk:stop-local-signaling'),
  checkFirewall: () => ipcRenderer.invoke('airdesk:check-firewall'),
  ensureFirewallRule: () => ipcRenderer.invoke('airdesk:ensure-firewall-rule'),
  setupUsbDirect: (opts) =>
    ipcRenderer.invoke(
      'airdesk:usb-direct-setup',
      opts && typeof opts === 'object' ? { openTetherSettings: Boolean(opts.openTetherSettings) } : {}
    ),
  getTrustedDevices: () => ipcRenderer.invoke('airdesk:get-trusted-devices'),
  revokeTrustedDevice: (tokenIdOrAll) =>
    ipcRenderer.invoke('airdesk:revoke-trusted-device', String(tokenIdOrAll || '')),
  onTrustedDevicesUpdated: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('airdesk:trusted-devices-updated', listener);
    return () => ipcRenderer.removeListener('airdesk:trusted-devices-updated', listener);
  },
  onTrustedTokenRevoked: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('airdesk:trusted-token-revoked', listener);
    return () => ipcRenderer.removeListener('airdesk:trusted-token-revoked', listener);
  },
  getHostSettings: () => ipcRenderer.invoke('airdesk:get-host-settings'),
  updateHostSettings: (patch) =>
    ipcRenderer.invoke(
      'airdesk:update-host-settings',
      patch && typeof patch === 'object' ? patch : {}
    ),
  issueRelayTrustedToken: (opts) =>
    ipcRenderer.invoke(
      'airdesk:issue-relay-trusted-token',
      opts && typeof opts === 'object' ? opts : {}
    ),
  verifyRelayTrustedToken: (opts) =>
    ipcRenderer.invoke(
      'airdesk:verify-relay-trusted-token',
      opts && typeof opts === 'object' ? opts : {}
    ),
  updateRelayTokenMode: (opts) =>
    ipcRenderer.invoke(
      'airdesk:update-relay-token-mode',
      opts && typeof opts === 'object' ? opts : {}
    ),
  getUnattendedPasswordStatus: () =>
    ipcRenderer.invoke('airdesk:get-unattended-password-status'),
  setUnattendedPassword: (password) =>
    ipcRenderer.invoke('airdesk:set-unattended-password', String(password || '')),
  clearUnattendedPassword: () =>
    ipcRenderer.invoke('airdesk:clear-unattended-password'),
  createPasswordChallenge: (opts) =>
    ipcRenderer.invoke(
      'airdesk:create-password-challenge',
      opts && typeof opts === 'object' ? opts : {}
    ),
  verifyPasswordChallenge: (opts) =>
    ipcRenderer.invoke(
      'airdesk:verify-password-challenge',
      opts && typeof opts === 'object' ? opts : {}
    ),
  generateQrDataUrl: (text) => {
    if (typeof text !== 'string' || text.length > 512) {
      return Promise.resolve({ dataUrl: '' });
    }
    return ipcRenderer.invoke('airdesk:generate-qr', text);
  },
  onEmergencyStop: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('airdesk:emergency-stop', listener);
    return () => ipcRenderer.removeListener('airdesk:emergency-stop', listener);
  },
  onHotkeyAction: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('airdesk:hotkey-action', listener);
    return () => ipcRenderer.removeListener('airdesk:hotkey-action', listener);
  },
  onPhysicalOverride: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('airdesk:physical-override', listener);
    return () => ipcRenderer.removeListener('airdesk:physical-override', listener);
  },
  onInputsReleased: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('airdesk:inputs-released', listener);
    return () => ipcRenderer.removeListener('airdesk:inputs-released', listener);
  },
  onDisplaysChanged: (cb) => {
    const listener = (_e, displays) => cb(displays);
    ipcRenderer.on('airdesk:displays-changed', listener);
    return () => ipcRenderer.removeListener('airdesk:displays-changed', listener);
  },
  onCursorPos: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('airdesk:cursor-pos', listener);
    return () => ipcRenderer.removeListener('airdesk:cursor-pos', listener);
  },
  onSecureDesktop: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('airdesk:secure-desktop', listener);
    return () => ipcRenderer.removeListener('airdesk:secure-desktop', listener);
  },
});

contextBridge.exposeInMainWorld('airdeskAPI', airdeskAPI);
