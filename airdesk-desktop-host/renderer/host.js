// AirDesk Unified Electron Renderer Host
// Consumes hardened window.airdeskAPI via sandboxed contextBridge (electron/preload.cjs).

import {
  isLanLikeConnection as checkLanLikeConnection,
  computeTieredVideoBitrates as calcTieredBitrates,
  sortPreferredVideoCodecs,
  boostVideoSdpBitrate,
  enhanceAudioOpusSdp,
  sdpPrefersHevc,
  ensurePlayoutDelayExtInSdp,
  parseIceServerInput,
} from './modules/sdp-codec.mjs';
import { createAbrController } from './modules/abr-controller.mjs';
import { createMediaCaptureManager } from './modules/media-capture.mjs';
import { createFileTransferManager, formatFileBytes } from './modules/file-transfer.mjs';

const signalingModeSelect = document.getElementById('signalingMode');
const serverInput = document.getElementById('serverUrl');
const displaySelect = document.getElementById('displaySelect');
const resolutionSelect = document.getElementById('resolutionSelect');
const framerateSelect = document.getElementById('framerateSelect');
const contentHintSelect = document.getElementById('contentHintSelect');
const codecSelect = document.getElementById('codecSelect');
const lanNoStunCheckbox = document.getElementById('lanNoStun');
const allowVirtualNetCheckbox = document.getElementById('allowVirtualNet');
const enableVkbCheckbox = document.getElementById('enableVkb');
const enableAudioCheckbox = document.getElementById('enableAudio');
const virtualAudioToggleWrap = document.getElementById('virtualAudioToggleWrap');
const muteHostVirtualAudioCheckbox = document.getElementById('muteHostVirtualAudio');
const virtualAudioToggleLabel = document.getElementById('virtualAudioToggleLabel');
const enableIdleFpsSaverCheckbox = document.getElementById('enableIdleFpsSaver');
const enableAutoClipboardCheckbox = document.getElementById('enableAutoClipboard');
const customStunInput = document.getElementById('customStunUrl');
const relayAccessKeyInput = document.getElementById('relayAccessKey');
const enableAutoStartCheckbox = document.getElementById('enableAutoStart');
const enableAutoHostOnStartCheckbox = document.getElementById('enableAutoHostOnStart');
const trustTtlSelect = document.getElementById('trustTtlSelect');
const btnStart = document.getElementById('btnStart');
const btnStop = document.getElementById('btnStop');
const btnToggleCtrl = document.getElementById('btnToggleCtrl');
const livePillEl = document.getElementById('livePill');
const firewallBadgeEl = document.getElementById('firewallBadge');
const btnFixFirewall = document.getElementById('btnFixFirewall');
const btnUsbDirect = document.getElementById('btnUsbDirect');
const btnUsbTether = document.getElementById('btnUsbTether');
const usbDirectHintEl = document.getElementById('usbDirectHint');
const pairCodeEl = document.getElementById('pairCode');
const btnCopyCode = document.getElementById('btnCopyCode');
const hostIdTextEl = document.getElementById('hostIdText');
const btnCopyHostId = document.getElementById('btnCopyHostId');
const unattendedPwBadgeEl = document.getElementById('unattendedPwBadge');
const unattendedPwInput = document.getElementById('unattendedPwInput');
const btnSetUnattendedPw = document.getElementById('btnSetUnattendedPw');
const btnClearUnattendedPw = document.getElementById('btnClearUnattendedPw');
const qrImg = document.getElementById('qrImg');
const qrPlaceholder = document.getElementById('qrPlaceholder');
const qrLinkText = document.getElementById('qrLinkText');
const tailscaleLinkRow = document.getElementById('tailscaleLinkRow');
const tailscaleLinkText = document.getElementById('tailscaleLinkText');
const btnCopyTailscale = document.getElementById('btnCopyTailscale');
const btnToggleQrMode = document.getElementById('btnToggleQrMode');
const statusEl = document.getElementById('status');
const rtcStatsEl = document.getElementById('rtcStats');
const netInfoEl = document.getElementById('netInfo');
const overrideNoticeEl = document.getElementById('overrideNotice');
const approvalCard = document.getElementById('approvalCard');
const approvalDesc = document.getElementById('approvalDesc');
const trustedDevicesListEl = document.getElementById('trustedDevicesList');
const btnRefreshTrusted = document.getElementById('btnRefreshTrusted');
const btnRevokeAllTokens = document.getElementById('btnRevokeAllTokens');
const hotkeyListEl = document.getElementById('hotkeyList');
const btnSendFiles = document.getElementById('btnSendFiles');
const btnOpenDownloads = document.getElementById('btnOpenDownloads');
const fileSendInput = document.getElementById('fileSendInput');
const fileDropZone = document.getElementById('fileDropZone');
const fileTransferStatusEl = document.getElementById('fileTransferStatus');
const fileProgressWrapEl = document.getElementById('fileProgressWrap');
const fileProgressBarEl = document.getElementById('fileProgressBar');
const fileTransferLogEl = document.getElementById('fileTransferLog');
const serviceStatusBadgeEl = document.getElementById('serviceStatusBadge');
const serviceStatusNoteEl = document.getElementById('serviceStatusNote');
const btnInstallService = document.getElementById('btnInstallService');
const btnUninstallService = document.getElementById('btnUninstallService');
const btnRefreshService = document.getElementById('btnRefreshService');

const STORAGE_SERVER_KEY = 'airdesk_host_signaling_url';
const STORAGE_MODE_KEY = 'airdesk_host_signaling_mode';
const STORAGE_VKB_KEY = 'airdesk_host_vkb_enabled';
const STORAGE_AUDIO_KEY = 'airdesk_host_audio_enabled';
const STORAGE_VIRTUAL_AUDIO_KEY = 'airdesk_host_virtual_audio_mute';
const STORAGE_FPS_KEY = 'airdesk_host_framerate';
const STORAGE_RES_KEY = 'airdesk_host_resolution';
const STORAGE_HINT_KEY = 'airdesk_host_content_hint';
const STORAGE_CODEC_KEY = 'airdesk_host_codec_pref';
const STORAGE_IDLE_FPS_KEY = 'airdesk_host_idle_fps_saver';
const STORAGE_AUTO_CLIP_KEY = 'airdesk_host_auto_clipboard';
const STORAGE_VNET_KEY = 'airdesk_host_allow_vnet';
const STORAGE_ICE_KEY = 'airdesk_host_custom_ice';
const STORAGE_RELAY_KEY = 'airdesk_host_relay_key';

// Steady 30fps by default for integrated GPUs; users with discrete GPUs can switch to 60fps in UI.
function captureMaxFps() {
  return framerateSelect && framerateSelect.value === '60' ? 60 : 30;
}

function isLanLikeConnection() {
  return checkLanLikeConnection({
    isRelay: Boolean(signalingModeSelect && signalingModeSelect.value === 'remote'),
    lanNoStun: Boolean(lanNoStunCheckbox && lanNoStunCheckbox.checked),
    activePeerIsOverlay,
  });
}

function computeTieredVideoBitrates() {
  return calcTieredBitrates({
    isRelay: Boolean(signalingModeSelect && signalingModeSelect.value === 'remote'),
    lanNoStun: Boolean(lanNoStunCheckbox && lanNoStunCheckbox.checked),
    activePeerIsOverlay,
    fps: captureMaxFps(),
    resolution: (resolutionSelect && resolutionSelect.value) || '1080p',
  });
}

const defaultBitrateKbps = () => computeTieredVideoBitrates().maxKbps;

let ws = null;
let pc = null;
let videoSender = null;
let audioSender = null;
let reliableDc = null;
let unreliableDc = null;
let screenSources = [];
let displaysMeta = [];
let pendingIceCandidates = [];
let localSignalingInfo = null;
let isHosting = false;
let hasActivePeer = false;
let currentControlEnabled = false;
let audioRenegotiatePreserveCtrlUntil = 0;
let preservedControlEnabled = false;
let hasPendingApproval = false;
let activePeerIsOverlay = false;
let qrUseTailscale = false;
let currentPairCode = '';
let noticeTimer = null;
let statsTimer = null;
let prevOutboundSnap = null;
let lastClientDiag = null;
let lastClientDiagAt = 0;
let remoteIceServers = [];
let wsHeartbeatTimer = null;
let wsReconnectTimer = null;
let wsReconnectAttempt = 0;
let isManualStop = false;
const WS_RECONNECT_DELAYS_MS = [2000, 5000, 10000, 30000];
let hostIdentity = null;
let pendingApprovalClient = null;
let activeRelaySessionToken = '';
let lastRemoteInputAt = Date.now();
let isIdleThrottled = false;
let activeTargetBitrateKbps = 15000;
let lastAppliedVideoParams = null;
let lastSyncedClipboardText = '';
let syncingClipboardPending = false;
let lastPliHandledAt = 0;
let disconnectGraceTimer = null;
let virtualAudioInfo = null;
let hostInSecureDesktop = false;
let hostElevatedConnected = false;
let secureDesktopRecoverTimer = null;

const abr = createAbrController();

function resetAdaptiveBitrate(baseMaxOverride = null) {
  abr.reset({
    baseMaxOverride,
    defaultMaxKbps: computeTieredVideoBitrates().maxKbps || 15000,
    isLanLike: isLanLikeConnection(),
  });
}

function showNotice(text, durationMs = 4200) {
  overrideNoticeEl.textContent = text;
  overrideNoticeEl.style.display = 'block';
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    overrideNoticeEl.style.display = 'none';
  }, durationMs);
}

const fileTransfer = createFileTransferManager({
  statusEl: fileTransferStatusEl,
  progressWrapEl: fileProgressWrapEl,
  progressBarEl: fileProgressBarEl,
  logEl: fileTransferLogEl,
  showNotice,
  airdeskAPI: window.airdeskAPI,
});

const mediaCapture = createMediaCaptureManager({
  getScreenSources: () => screenSources,
  getSelectedDisplayId: () => displaySelect.value,
  setSelectedDisplayId: (id) => {
    displaySelect.value = id;
  },
  getSelectedResolution: () => resolutionSelect.value,
  getCaptureMaxFps: captureMaxFps,
  getContentHintPref: () => (contentHintSelect && contentHintSelect.value) || 'auto',
  getAudioEnabled: () => Boolean(enableAudioCheckbox && enableAudioCheckbox.checked),
  setAudioEnabledState: (next) => {
    if (enableAudioCheckbox) enableAudioCheckbox.checked = next;
    localStorage.setItem(STORAGE_AUDIO_KEY, next ? '1' : '0');
  },
  getVirtualAudioInfo: () => virtualAudioInfo,
  getMuteHostVirtualAudio: () =>
    Boolean(muteHostVirtualAudioCheckbox && muteHostVirtualAudioCheckbox.checked),
  getIsHosting: () => isHosting,
  getHasActivePeer: () => hasActivePeer,
  getHasPc: () => Boolean(pc),
  getPcStats: () => pc.getStats(),
  getHostInSecureDesktop: () => hostInSecureDesktop,
  getVideoSender: () => videoSender,
  getAudioSender: () => audioSender,
  getReliableDc: () => reliableDc,
  getWs: () => ws,
  onAudioRenegotiatePreserveCtrl: () => {
    preservedControlEnabled = currentControlEnabled;
    audioRenegotiatePreserveCtrlUntil = Date.now() + 8000;
  },
  applyVideoParameters,
  getAbrTargetKbps: () => abr.state.currentTargetKbps,
  getAbrFpsCap: () => abr.state.adaptiveFpsCap,
  getIsIdleThrottled: () => isIdleThrottled,
  pushDisplaysListToClient,
  pushUiConfigToClient,
  showNotice,
  setStatusText: (txt) => {
    if (statusEl) statusEl.textContent = txt;
  },
  airdeskAPI: window.airdeskAPI,
});

async function refreshTrustedDevicesUi() {
  if (!trustedDevicesListEl || !window.airdeskAPI.getTrustedDevices) return;
  try {
    const list = await window.airdeskAPI.getTrustedDevices();
    if (!Array.isArray(list) || list.length === 0) {
      trustedDevicesListEl.textContent = '暂无已信任免密设备（批准连接后将按所选有效期免扫码直连）';
      return;
    }
    trustedDevicesListEl.innerHTML = '';
    for (const dev of list) {
      const row = document.createElement('div');
      row.style.cssText =
        'display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 10px;background:#0B0F14;border:1px solid #1E293B;border-radius:8px;margin-top:6px;';
      const infoSpan = document.createElement('span');
      const modeText = dev.mode === 'full_control' ? '允许操控' : '仅观看';
      const sourceText = dev.source === 'relay' ? '公网中继' : '局域网';
      const seenText = dev.lastSeenAt ? new Date(dev.lastSeenAt).toLocaleString() : '--';
      const expiryText =
        dev.expiresAt === null ? '长期有效' : new Date(dev.expiresAt).toLocaleDateString() + ' 到期';
      infoSpan.textContent =
        '[' +
        sourceText +
        '] ' +
        dev.deviceLabel +
        ' (' +
        dev.platformHint +
        ' · ' +
        dev.ipMasked +
        ') · 权限：' +
        modeText +
        ' · ' +
        expiryText +
        ' · 最近活跃：' +
        seenText;
      const revokeBtn = document.createElement('button');
      revokeBtn.className = 'secondary';
      revokeBtn.style.cssText = 'padding:4px 9px;font-size:12px;';
      revokeBtn.textContent = '移除';
      revokeBtn.onclick = async () => {
        await window.airdeskAPI.revokeTrustedDevice(dev.tokenId);
        await refreshTrustedDevicesUi();
        showNotice('已移除设备免密凭证：' + dev.deviceLabel);
      };
      row.appendChild(infoSpan);
      row.appendChild(revokeBtn);
      trustedDevicesListEl.appendChild(row);
    }
  } catch {
    // Non-fatal
  }
}

function setLivePill(mode, text) {
  if (!livePillEl) return;
  livePillEl.className = 'pill' + (mode ? ' ' + mode : '');
  const spans = livePillEl.querySelectorAll('span');
  if (spans.length >= 2) {
    spans[1].textContent = text;
  }
}

function updateFirewallUi(fw) {
  if (!firewallBadgeEl) return;
  const spans = firewallBadgeEl.querySelectorAll('span');
  if (!fw || fw.supported === false) {
    firewallBadgeEl.className = 'pill live';
    if (spans.length >= 2) spans[1].textContent = '非 Windows 免放行';
    if (btnFixFirewall) btnFixFirewall.style.display = 'none';
    return;
  }
  if (fw.allowed) {
    firewallBadgeEl.className = 'pill live';
    if (spans.length >= 2) spans[1].textContent = '防火墙 47820 已放行';
    if (btnFixFirewall) btnFixFirewall.style.display = 'none';
  } else {
    firewallBadgeEl.className = 'pill';
    firewallBadgeEl.style.borderColor = '#F59E0B';
    firewallBadgeEl.style.color = '#FBBF24';
    if (spans.length >= 2) spans[1].textContent = '防火墙未检测到放行规则';
    if (btnFixFirewall) btnFixFirewall.style.display = 'inline-block';
  }
}

async function runUsbDirectSetup(openTetherSettings = false) {
  if (!window.airdeskAPI.setupUsbDirect) return;
  try {
    const res = await window.airdeskAPI.setupUsbDirect({ openTetherSettings });
    if (res && res.localSignaling) {
      localSignalingInfo = res.localSignaling;
      if (signalingModeSelect.value === 'local') {
        if (res.usbHttpUrl) {
          serverInput.value = res.usbHttpUrl;
        } else if (localSignalingInfo.preferredHttpUrl) {
          serverInput.value = localSignalingInfo.preferredHttpUrl;
        }
        if (currentPairCode) {
          await renderPairQr(currentPairCode);
        }
      }
    }
    if (usbDirectHintEl) {
      const parts = [];
      if (res && res.usbHttpUrl) parts.push('USB 有线共享地址: ' + res.usbHttpUrl);
      if (res && res.reverseActive) parts.push('ADB 端口转发: 手机 127.0.0.1:47820 -> 电脑 :47820');
      if (parts.length > 0) {
        usbDirectHintEl.textContent = parts.join('  ·  ');
        usbDirectHintEl.style.display = 'block';
      } else {
        usbDirectHintEl.style.display = 'none';
      }
    }
    if (res && res.message) {
      showNotice(res.message, 5500);
    }
  } catch (err) {
    showNotice('USB 直连配置失败：' + (err && err.message ? err.message : String(err)));
  }
}

function updateElevatedServiceUi(st) {
  if (!serviceStatusBadgeEl) return;
  const spans = serviceStatusBadgeEl.querySelectorAll('span');
  if (!st || st.supported === false) {
    serviceStatusBadgeEl.className = 'pill';
    if (spans.length >= 2) spans[1].textContent = '仅支持 Windows';
    if (btnInstallService) btnInstallService.style.display = 'none';
    if (btnUninstallService) btnUninstallService.style.display = 'none';
    if (btnRefreshService) btnRefreshService.style.display = 'none';
    if (serviceStatusNoteEl) serviceStatusNoteEl.textContent = '非 Windows 平台无需安装后台提权服务。';
    return;
  }
  if (st.running && st.pipeConnected) {
    serviceStatusBadgeEl.className = 'pill live';
    if (spans.length >= 2) spans[1].textContent = 'SYSTEM 服务已连接';
    if (btnInstallService) {
      btnInstallService.textContent = '重新安装 / 更新服务';
      btnInstallService.style.display = 'inline-block';
    }
    if (btnUninstallService) btnUninstallService.style.display = 'inline-block';
    if (serviceStatusNoteEl) {
      serviceStatusNoteEl.textContent =
        '已接入 AirDeskElevatedInput (NT AUTHORITY\\SYSTEM)：支持操作管理员权限窗口，并在 UAC / 锁屏界面自动切换输入桌面（注：Electron desktopCapturer 在安全桌面下仍可能因系统隔离变黑，如需远程批准 UAC 建议在系统设置中调低「用户账户控制」桌面变暗级别）。';
    }
  } else if (st.installed) {
    serviceStatusBadgeEl.className = 'pill waiting';
    if (spans.length >= 2) spans[1].textContent = st.running ? '服务运行中（待连接）' : '已安装未运行';
    if (btnInstallService) {
      btnInstallService.textContent = '启动 / 修复后台服务 (UAC)';
      btnInstallService.style.display = 'inline-block';
    }
    if (btnUninstallService) btnUninstallService.style.display = 'inline-block';
    if (serviceStatusNoteEl) {
      serviceStatusNoteEl.textContent = '检测到已安装 AirDeskElevatedInput 服务，点击「启动 / 修复」或「刷新状态」接入 SYSTEM 输入通道。';
    }
  } else {
    serviceStatusBadgeEl.className = 'pill';
    if (spans.length >= 2) spans[1].textContent = '普通绿色模式';
    if (btnInstallService) {
      btnInstallService.textContent = '安装并启动后台提权服务 (UAC)';
      btnInstallService.style.display = 'inline-block';
    }
    if (btnUninstallService) btnUninstallService.style.display = 'none';
    if (serviceStatusNoteEl) {
      serviceStatusNoteEl.textContent =
        '当前以零门槛绿色模式运行，普通窗口操控完全正常；仅当需要远程操作管理员终端、UAC 提权框或锁屏界面时，才需点击下方按钮注册 SYSTEM 后台服务（注意：Windows 安全桌面下 Electron desktopCapturer 仍可能因系统隔离变黑，如需远程批准 UAC 建议在系统设置中调低 UAC 桌面变暗级别）。';
    }
  }
}

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach((b) => {
      b.classList.toggle('active', b === btn);
    });
    document.querySelectorAll('.tab-panel').forEach((p) => {
      p.classList.toggle('active', p.id === 'tab-' + target);
    });
  });
});

function updateUnattendedPasswordUi(st) {
  if (unattendedPwBadgeEl) {
    const spans = unattendedPwBadgeEl.querySelectorAll('span');
    unattendedPwBadgeEl.style.borderColor = '';
    unattendedPwBadgeEl.style.color = '';
    if (st && st.locked) {
      unattendedPwBadgeEl.className = 'pill';
      unattendedPwBadgeEl.style.borderColor = '#F59E0B';
      unattendedPwBadgeEl.style.color = '#FBBF24';
      if (spans.length >= 2) spans[1].textContent = '已锁定 (' + (st.remainingLockSec || 0) + 's)';
    } else if (st && st.enabled) {
      unattendedPwBadgeEl.className = 'pill live';
      if (spans.length >= 2) spans[1].textContent = '已启用';
    } else {
      unattendedPwBadgeEl.className = 'pill';
      if (spans.length >= 2) spans[1].textContent = '未启用';
    }
  }
  if (btnClearUnattendedPw) {
    btnClearUnattendedPw.style.display = st && st.enabled ? 'inline-block' : 'none';
  }
}

if (btnCopyHostId) {
  btnCopyHostId.onclick = async () => {
    const hid = (hostIdentity && hostIdentity.hostId) || '';
    if (!hid) {
      showNotice('主机 ID 尚未就绪');
      return;
    }
    try {
      await navigator.clipboard.writeText(hid);
      showNotice('已复制主机 ID：' + hid);
    } catch {
      showNotice('本机主机 ID：' + hid);
    }
  };
}

if (btnCopyCode) {
  btnCopyCode.onclick = async () => {
    const code = ((pairCodeEl && pairCodeEl.textContent) || '').trim();
    if (!/^\d{6}$/.test(code)) {
      showNotice('请先点击「启动串流与配对」生成 6 位配对码');
      return;
    }
    try {
      await navigator.clipboard.writeText(code);
      showNotice('已复制配对码：' + code);
    } catch {
      showNotice('当前配对码：' + code);
    }
  };
}

function updateControlButtonUi() {
  btnToggleCtrl.disabled = !hasActivePeer;
  if (currentControlEnabled) {
    btnToggleCtrl.textContent = '当前：允许操控（按 Ctrl+Alt+L 切只读）';
    btnToggleCtrl.className = 'emerald';
  } else {
    btnToggleCtrl.textContent = '当前：仅观看（只读）（按 Ctrl+Alt+L 切操控）';
    btnToggleCtrl.className = 'secondary';
  }
}

function syncSignalingInputState() {
  const isLocal = signalingModeSelect.value === 'local';
  localStorage.setItem(STORAGE_MODE_KEY, signalingModeSelect.value);
  if (relayAccessKeyInput) {
    relayAccessKeyInput.style.display = isLocal ? 'none' : 'block';
  }
  if (isLocal && localSignalingInfo) {
    serverInput.value = localSignalingInfo.preferredHttpUrl;
    serverInput.readOnly = true;
    lanNoStunCheckbox.checked = true;
  } else {
    serverInput.readOnly = false;
    serverInput.value = localStorage.getItem(STORAGE_SERVER_KEY) || '';
    if (!isLocal && lanNoStunCheckbox) {
      lanNoStunCheckbox.checked = false;
    }
  }
}

async function renderPairQr(code) {
  currentPairCode = code || '';
  if (!code) {
    qrImg.style.display = 'none';
    qrPlaceholder.style.display = 'block';
    qrLinkText.textContent = '';
    if (tailscaleLinkRow) tailscaleLinkRow.style.display = 'none';
    if (tailscaleLinkText) tailscaleLinkText.textContent = '';
    return;
  }
  const baseUrl = serverInput.value.trim().replace(/\/$/, '');
  const joinUrl = baseUrl + '/?join=' + code;
  const tsBase =
    signalingModeSelect.value === 'local' &&
    localSignalingInfo &&
    localSignalingInfo.tailscaleHttpUrl
      ? localSignalingInfo.tailscaleHttpUrl.replace(/\/$/, '')
      : '';
  const tsJoinUrl = tsBase ? tsBase + '/?join=' + code : '';

  qrLinkText.textContent = '扫码直连地址：' + joinUrl;
  if (tailscaleLinkRow && tailscaleLinkText) {
    if (tsJoinUrl) {
      tailscaleLinkText.textContent = 'Tailscale 异地直连：' + tsJoinUrl;
      tailscaleLinkRow.style.display = 'flex';
    } else {
      tailscaleLinkRow.style.display = 'none';
      tailscaleLinkText.textContent = '';
    }
  }
  if (!tsJoinUrl) qrUseTailscale = false;
  if (btnToggleQrMode) {
    btnToggleQrMode.textContent = qrUseTailscale ? '切回局域网二维码' : '切换异地二维码';
  }
  const targetQrUrl = qrUseTailscale && tsJoinUrl ? tsJoinUrl : joinUrl;
  const res = await window.airdeskAPI.generateQrDataUrl(targetQrUrl);
  if (res && res.dataUrl) {
    qrImg.src = res.dataUrl;
    qrImg.style.display = 'block';
    qrPlaceholder.style.display = 'none';
  }
}

if (btnCopyTailscale) {
  btnCopyTailscale.onclick = async () => {
    const tsBase =
      localSignalingInfo && localSignalingInfo.tailscaleHttpUrl
        ? localSignalingInfo.tailscaleHttpUrl.replace(/\/$/, '')
        : '';
    if (!tsBase || !currentPairCode) return;
    const url = tsBase + '/?join=' + currentPairCode;
    try {
      await navigator.clipboard.writeText(url);
      showNotice('已复制 Tailscale 异地直连地址：' + url);
    } catch {
      showNotice('请手动复制：' + url);
    }
  };
}
if (btnToggleQrMode) {
  btnToggleQrMode.onclick = () => {
    qrUseTailscale = !qrUseTailscale;
    if (currentPairCode) {
      renderPairQr(currentPairCode).catch(() => {});
    }
  };
}

async function refreshDisplaysUi(updatedDisplays) {
  screenSources = await window.airdeskAPI.getScreenSources();
  if (Array.isArray(updatedDisplays)) {
    displaysMeta = updatedDisplays;
  }
  const prevValue = displaySelect.value;
  displaySelect.innerHTML = '';
  for (const src of screenSources) {
    const opt = document.createElement('option');
    opt.value = src.displayId || src.id;
    opt.textContent = src.name;
    displaySelect.appendChild(opt);
  }
  if (prevValue && screenSources.some((s) => (s.displayId || s.id) === prevValue)) {
    displaySelect.value = prevValue;
  }
  pushDisplaysListToClient();
}

function pushDisplaysListToClient() {
  if (!reliableDc || reliableDc.readyState !== 'open') return;
  reliableDc.send(
    JSON.stringify({
      t: 'displays:list',
      displays: displaysMeta.map((d) => ({
        id: d.id,
        label: d.label,
        width: d.bounds.width,
        height: d.bounds.height,
        scaleFactor: d.scaleFactor,
        isPrimary: d.isPrimary,
      })),
      activeDisplayId: displaySelect.value,
    })
  );
}

function pushUiConfigToClient() {
  if (!reliableDc || reliableDc.readyState !== 'open') return;
  reliableDc.send(
    JSON.stringify({
      t: 'ui:config',
      virtualKeyboardEnabled: Boolean(enableVkbCheckbox && enableVkbCheckbox.checked),
      audioEnabled: Boolean(enableAudioCheckbox && enableAudioCheckbox.checked),
    })
  );
}

function sendSecureDesktopToClient() {
  if (!reliableDc || reliableDc.readyState !== 'open') return;
  try {
    reliableDc.send(
      JSON.stringify({
        t: 'host:secure_desktop',
        active: hostInSecureDesktop,
        elevatedConnected: hostElevatedConnected,
      })
    );
  } catch {}
}

async function applyVideoParameters(maxBitrateKbps, maxFramerate) {
  activeTargetBitrateKbps = Math.max(500, Number(maxBitrateKbps) || 15000);
  if (!videoSender) return;
  const effectiveFps = Math.min(maxFramerate, captureMaxFps());
  const currentTrack = videoSender.track || null;
  if (
    lastAppliedVideoParams &&
    lastAppliedVideoParams.sender === videoSender &&
    lastAppliedVideoParams.track === currentTrack &&
    lastAppliedVideoParams.bitrateKbps === activeTargetBitrateKbps &&
    lastAppliedVideoParams.fps === effectiveFps
  ) {
    return;
  }
  try {
    const params = videoSender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    params.encodings[0].maxBitrate = activeTargetBitrateKbps * 1000;
    params.encodings[0].maxFramerate = effectiveFps;
    params.encodings[0].scaleResolutionDownBy = 1.0;
    params.encodings[0].priority = 'high';
    params.encodings[0].networkPriority = 'high';
    params.encodings[0].scalabilityMode = 'L1T1';
    // Remote desktop text/UI must never be silently downscaled to 480x270.
    params.degradationPreference = 'maintain-resolution';
    try {
      await videoSender.setParameters(params);
    } catch {
      delete params.encodings[0].scalabilityMode;
      await videoSender.setParameters(params);
    }
    lastAppliedVideoParams = {
      sender: videoSender,
      track: currentTrack,
      bitrateKbps: activeTargetBitrateKbps,
      fps: effectiveFps,
    };
  } catch {
    // Ignore transient setParameters error
  }
}

function startRtcStatsMonitor() {
  if (statsTimer) clearInterval(statsTimer);
  prevOutboundSnap = null;
  statsTimer = setInterval(async () => {
    if (!pc) return;
    try {
      const report = await pc.getStats();
      let fps = null;
      let rttMs = null;
      let activePair = null;
      let codecMime = null;
      let codecProfile = '';
      let txKbps = null;
      let txMbps = null;
      let frameW = null;
      let frameH = null;
      let encodeMs = null;
      let encoderImpl = '';
      let txHw = '';
      let limitReason = 'none';
      const localCands = new Map();
      const remoteCands = new Map();
      const codecById = new Map();
      let outboundStat = null;

      report.forEach((stat) => {
        if (stat.type === 'codec') codecById.set(stat.id, stat);
        else if (stat.type === 'local-candidate') localCands.set(stat.id, stat);
        else if (stat.type === 'remote-candidate') remoteCands.set(stat.id, stat);
        else if (stat.type === 'outbound-rtp' && stat.kind === 'video') {
          outboundStat = stat;
          if (typeof stat.framesPerSecond === 'number') fps = Math.round(stat.framesPerSecond);
        } else if (
          stat.type === 'candidate-pair' &&
          (stat.nominated || stat.state === 'succeeded') &&
          stat.bytesSent > 0
        ) {
          activePair = stat;
        }
      });

      const localStream = mediaCapture.getLocalStream();
      if (outboundStat) {
        const codec = codecById.get(outboundStat.codecId);
        if (codec && codec.mimeType) {
          codecMime = String(codec.mimeType).replace(/^video\//i, '').toUpperCase();
        }
        if (codec && codec.sdpFmtpLine) {
          const pm = String(codec.sdpFmtpLine).match(/profile-level-id=([0-9a-f]{6})/i);
          if (pm) codecProfile = pm[1].toLowerCase();
        }
        if (typeof outboundStat.frameWidth === 'number') frameW = outboundStat.frameWidth;
        if (typeof outboundStat.frameHeight === 'number') frameH = outboundStat.frameHeight;
        if (outboundStat.encoderImplementation) {
          encoderImpl = String(outboundStat.encoderImplementation);
        }
        if (typeof outboundStat.powerEfficientEncoder === 'boolean') {
          txHw = outboundStat.powerEfficientEncoder ? '硬编' : '软编';
          if (
            contentHintSelect &&
            contentHintSelect.value === 'auto' &&
            !mediaCapture.getAutoHintFallbackApplied() &&
            typeof outboundStat.framesEncoded === 'number' &&
            outboundStat.framesEncoded >= 15 &&
            outboundStat.powerEfficientEncoder === false &&
            localStream
          ) {
            const activeVt = localStream.getVideoTracks()[0];
            if (activeVt && 'contentHint' in activeVt && activeVt.contentHint !== 'motion') {
              activeVt.contentHint = 'motion';
              mediaCapture.setAutoHintFallbackApplied(true);
              showNotice('检测到当前编码器回退为软编 (' + (encoderImpl || 'OpenH264') + ')，已自动切换低延迟 motion');
            }
          }
        }
        if (outboundStat.qualityLimitationReason) {
          limitReason = String(outboundStat.qualityLimitationReason);
        }
        if (prevOutboundSnap) {
          const dt = (outboundStat.timestamp - prevOutboundSnap.ts) / 1000;
          if (
            typeof outboundStat.framesEncoded === 'number' &&
            typeof prevOutboundSnap.framesEncoded === 'number' &&
            typeof outboundStat.totalEncodeTime === 'number' &&
            typeof prevOutboundSnap.totalEncodeTime === 'number'
          ) {
            const dF = outboundStat.framesEncoded - prevOutboundSnap.framesEncoded;
            const dT = outboundStat.totalEncodeTime - prevOutboundSnap.totalEncodeTime;
            if (fps === null && dt > 0 && dF >= 0) {
              fps = Math.round(dF / dt);
            }
            if (dF > 0 && dT >= 0) {
              encodeMs = +(dT / dF * 1000).toFixed(1);
            }
          }
          if (
            dt > 0 &&
            typeof outboundStat.bytesSent === 'number' &&
            typeof prevOutboundSnap.bytesSent === 'number'
          ) {
            const dBytes = outboundStat.bytesSent - prevOutboundSnap.bytesSent;
            if (dBytes >= 0) {
              txKbps = Math.round((dBytes * 8) / dt / 1000);
              txMbps = +(txKbps / 1000).toFixed(1);
            }
          }
        }
        if (typeof outboundStat.framesEncoded === 'number' || typeof outboundStat.bytesSent === 'number') {
          prevOutboundSnap = {
            ts: outboundStat.timestamp,
            framesEncoded:
              typeof outboundStat.framesEncoded === 'number' ? outboundStat.framesEncoded : null,
            totalEncodeTime:
              typeof outboundStat.totalEncodeTime === 'number' ? outboundStat.totalEncodeTime : null,
            bytesSent: typeof outboundStat.bytesSent === 'number' ? outboundStat.bytesSent : null,
          };
        }
      }

      let iceLabel = '探测中';
      let color = '#94A3B8';
      if (activePair) {
        if (typeof activePair.currentRoundTripTime === 'number') {
          rttMs = Math.round(activePair.currentRoundTripTime * 1000);
        }
        const lc = localCands.get(activePair.localCandidateId);
        const rc = remoteCands.get(activePair.remoteCandidateId);
        const lType = (lc && lc.candidateType) || '';
        const rType = (rc && rc.candidateType) || '';
        const lIp = (lc && (lc.address || lc.ip)) || '';
        const rIp = (rc && (rc.address || rc.ip)) || '';
        const tsRe = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;
        const viaOverlay = activePeerIsOverlay || tsRe.test(lIp) || tsRe.test(rIp);
        if (lType === 'relay' || rType === 'relay') {
          iceLabel = 'TURN 中转 (relay · 注意流量)';
          color = '#F87171';
        } else if (viaOverlay) {
          iceLabel = '异地组网直连 (Tailscale/ZeroTier)';
          color = '#60A5FA';
        } else if (lType === 'host' && (rType === 'host' || rType === 'prflx')) {
          iceLabel = '局域网/热点 0 流量直连 (' + lType + ')';
          color = '#34D399';
        } else if (lType || rType) {
          iceLabel = 'P2P 穿透 (' + (lType || rType) + ')';
          color = '#60A5FA';
        }
      }

      const implStr = [encoderImpl, txHw].filter(Boolean).join('·');
      const msStr = encodeMs !== null ? encodeMs + 'ms' : '';
      const encInfo = [implStr, msStr].filter(Boolean).join(' ');
      const encDetail = encInfo ? ' [' + encInfo + ']' : '';
      const resText = frameW && frameH ? frameW + 'x' + frameH : '--';
      const fpsText = fps !== null ? fps + 'fps' : '--';
      const rttText = rttMs !== null ? rttMs + 'ms' : '--';

      const codecLabel = codecMime
        ? codecProfile
          ? codecMime + '(' + codecProfile + ')'
          : codecMime
        : '--';
      const bitrateText =
        txKbps !== null
          ? txKbps < 1000
            ? txKbps + 'kbps'
            : (txKbps / 1000).toFixed(1) + 'Mbps'
          : '--';
      const abrTag = abr.state.state === 'throttled' ? ' · ABR(' + abr.state.currentTargetKbps + 'k)' : '';

      const line1 =
        '发送端(电脑)：' +
        iceLabel +
        ' · 编码：' +
        codecLabel +
        encDetail +
        ' · ' +
        resText +
        ' @ ' +
        fpsText +
        ' · 码率：' +
        bitrateText +
        abrTag +
        ' · 限制：' +
        limitReason +
        ' · RTT：' +
        rttText;

      let line2 = '接收端(手机)：等待手机端回传真机解码遥测...';
      if (lastClientDiag) {
        const rxFpsText = typeof lastClientDiag.rxFps === 'number' ? lastClientDiag.rxFps + 'fps' : '--';
        const rxHw = typeof lastClientDiag.hw === 'boolean' ? (lastClientDiag.hw ? '硬解' : '软解') : '';
        const decImplStr = [lastClientDiag.decoder || '', rxHw].filter(Boolean).join('·');
        const decMsStr = typeof lastClientDiag.decodeMs === 'number' ? lastClientDiag.decodeMs + 'ms' : '';
        const decInfo = [decImplStr, decMsStr].filter(Boolean).join(' ');
        const decDetail = decInfo ? ' [' + decInfo + ']' : '';
        const fmtMs = (v) => (typeof v === 'number' ? v + 'ms' : '--');
        const jbText =
          fmtMs(lastClientDiag.jbMs) +
          '/' +
          fmtMs(lastClientDiag.jbTargetMs) +
          '/' +
          fmtMs(lastClientDiag.jbMinMs);
        const jbSetText =
          typeof lastClientDiag.jbSettingMs === 'number' ? lastClientDiag.jbSettingMs + 'ms' : '--';
        const dropped = typeof lastClientDiag.dropped === 'number' ? lastClientDiag.dropped : '--';
        const freezes = typeof lastClientDiag.freezes === 'number' ? lastClientDiag.freezes : '--';
        line2 =
          '接收端(手机)：解码 ' +
          rxFpsText +
          decDetail +
          ' · 缓冲(实/标/底)：' +
          jbText +
          ' (档位:' +
          jbSetText +
          ') · 掉帧：' +
          dropped +
          ' · 卡顿：' +
          freezes;
      }

      if (!document.hidden && rtcStatsEl) {
        rtcStatsEl.style.color = color;
        rtcStatsEl.textContent = line1 + '\n' + line2;
      }

      const abrAdjustment = abr.evaluate({
        hasActivePeer,
        hasPc: Boolean(pc),
        hasVideoSender: Boolean(videoSender),
        isIdleThrottled,
        hostInSecureDesktop,
        isLanLike: isLanLikeConnection(),
        captureMaxFps: captureMaxFps(),
        limitReason,
        encodeMs,
        rttMs,
        lastClientDiag,
        lastClientDiagAt,
      });
      if (abrAdjustment) {
        await applyVideoParameters(abrAdjustment.targetKbps, abrAdjustment.fps);
      }

      if (reliableDc && reliableDc.readyState === 'open') {
        const activeVt = localStream && localStream.getVideoTracks()[0];
        reliableDc.send(
          JSON.stringify({
            t: 'diag:tx',
            txFps: fps,
            encodeMs,
            encoder: encoderImpl,
            hw: outboundStat && typeof outboundStat.powerEfficientEncoder === 'boolean'
              ? outboundStat.powerEfficientEncoder
              : null,
            codec: codecMime,
            profile: codecProfile,
            txKbps,
            txMbps,
            targetKbps: abr.state.currentTargetKbps,
            abrState: abr.state.state,
            w: frameW,
            h: frameH,
            limit: limitReason,
            rttMs,
            contentHint: (activeVt && activeVt.contentHint) || '',
          })
        );
      }

      if (
        enableIdleFpsSaverCheckbox &&
        enableIdleFpsSaverCheckbox.checked &&
        hasActivePeer &&
        videoSender &&
        !isIdleThrottled &&
        Date.now() - lastRemoteInputAt > 12000
      ) {
        isIdleThrottled = true;
        applyVideoParameters(abr.state.currentTargetKbps, 8).catch(() => {});
      }

      if (
        enableAutoClipboardCheckbox &&
        enableAutoClipboardCheckbox.checked &&
        currentControlEnabled &&
        reliableDc &&
        reliableDc.readyState === 'open' &&
        !syncingClipboardPending
      ) {
        syncingClipboardPending = true;
        window.airdeskAPI
          .readClipboard()
          .then((clipRes) => {
            const txt = clipRes && typeof clipRes.text === 'string' ? clipRes.text : '';
            if (txt && txt !== lastSyncedClipboardText && reliableDc && reliableDc.readyState === 'open') {
              lastSyncedClipboardText = txt;
              reliableDc.send(JSON.stringify({ t: 'clip:data', text: txt, auto: true }));
            }
          })
          .catch(() => {})
          .finally(() => {
            syncingClipboardPending = false;
          });
      }
    } catch {
      // Ignore transient stats error
    }
  }, 2000);
}

function cleanupPeerConnection(scheduleIdleRelease = true) {
  if (disconnectGraceTimer) {
    clearTimeout(disconnectGraceTimer);
    disconnectGraceTimer = null;
  }
  mediaCapture.clearWarmDisplayTracks();
  if (statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
  }
  prevOutboundSnap = null;
  lastClientDiag = null;
  lastClientDiagAt = 0;
  isIdleThrottled = false;
  resetAdaptiveBitrate();
  lastRemoteInputAt = Date.now();
  lastSyncedClipboardText = '';
  syncingClipboardPending = false;
  fileTransfer.cleanupOnDisconnect();
  rtcStatsEl.textContent = '';
  pendingIceCandidates = [];
  hasActivePeer = false;
  if (reliableDc) {
    reliableDc.close();
    reliableDc = null;
  }
  if (unreliableDc) {
    unreliableDc.close();
    unreliableDc = null;
  }
  if (pc) {
    pc.onicecandidate = null;
    pc.onconnectionstatechange = null;
    pc.ondatachannel = null;
    pc.close();
    pc = null;
  }
  videoSender = null;
  lastAppliedVideoParams = null;
  audioSender = null;
  updateControlButtonUi();
  if (scheduleIdleRelease) {
    mediaCapture.scheduleIdleCaptureRelease(20000);
  } else {
    mediaCapture.cancelIdleCaptureRelease();
  }
}

function clearWsReconnectTimer() {
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
}

async function stopHost(reason) {
  isManualStop = true;
  clearWsReconnectTimer();
  wsReconnectAttempt = 0;
  mediaCapture.bumpSessionGen();
  isHosting = false;
  if (window.airdeskAPI.setHostingActive) {
    window.airdeskAPI.setHostingActive(false).catch(() => {});
  }
  hasPendingApproval = false;
  pendingApprovalClient = null;
  hasActivePeer = false;
  activePeerIsOverlay = false;
  activeRelaySessionToken = '';
  currentControlEnabled = false;
  remoteIceServers = [];
  mediaCapture.cancelIdleCaptureRelease();
  if (secureDesktopRecoverTimer) {
    clearTimeout(secureDesktopRecoverTimer);
    secureDesktopRecoverTimer = null;
  }
  mediaCapture.clearRecoverTimer();
  if (wsHeartbeatTimer) {
    clearInterval(wsHeartbeatTimer);
    wsHeartbeatTimer = null;
  }
  await window.airdeskAPI.setSessionActive(false);
  cleanupPeerConnection(false);
  if (ws) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'session:close', reason: reason || '电脑端已停止共享' }));
    }
    ws.onclose = null;
    ws.onerror = null;
    ws.close();
    ws = null;
  }
  mediaCapture.releaseLocalCaptureMedia();
  approvalCard.style.display = 'none';
  pairCodeEl.textContent = '------';
  await renderPairQr('');
  setLivePill('', '未启动');
  btnStart.disabled = false;
  btnStop.disabled = true;
  updateControlButtonUi();
  statusEl.textContent = reason || '已停止并释放屏幕采集';
}

function buildIceServers() {
  if (signalingModeSelect.value === 'local' && lanNoStunCheckbox.checked) {
    return [];
  }
  const merged = [];
  if (Array.isArray(remoteIceServers) && remoteIceServers.length > 0) {
    merged.push(...remoteIceServers);
  }
  const custom = parseIceServerInput(customStunInput ? customStunInput.value : '');
  if (custom.length > 0) {
    merged.push(...custom);
  }
  if (merged.length > 0) {
    return merged;
  }
  if (lanNoStunCheckbox && lanNoStunCheckbox.checked) {
    return [];
  }
  return [{ urls: 'stun:stun.miwifi.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }];
}

async function startHost() {
  if (isHosting) return;
  isManualStop = false;
  clearWsReconnectTimer();
  wsReconnectAttempt = 0;
  mediaCapture.bumpSessionGen();
  remoteIceServers = [];
  if (wsHeartbeatTimer) {
    clearInterval(wsHeartbeatTimer);
    wsHeartbeatTimer = null;
  }
  localStorage.setItem(STORAGE_MODE_KEY, signalingModeSelect.value);
  if (signalingModeSelect.value === 'local') {
    localSignalingInfo = await window.airdeskAPI.startLocalSignaling(47820);
    serverInput.value = localSignalingInfo.preferredHttpUrl;
  }
  const rawServer = serverInput.value.trim();
  if (!rawServer) {
    showNotice('请先填写你的 AirDesk 信令服务器地址，或切换为「内置本地信令」');
    return;
  }
  if (signalingModeSelect.value === 'remote') {
    localStorage.setItem(STORAGE_SERVER_KEY, rawServer);
  }
  if (customStunInput) {
    localStorage.setItem(STORAGE_ICE_KEY, customStunInput.value.trim());
  }
  if (relayAccessKeyInput) {
    localStorage.setItem(STORAGE_RELAY_KEY, relayAccessKeyInput.value.trim());
  }

  const wsUrl = rawServer.replace(/^http/i, 'ws').replace(/\/$/, '') + '/ws/signaling';
  try {
    const parsedWs = new URL(wsUrl);
    if (parsedWs.protocol !== 'ws:' && parsedWs.protocol !== 'wss:') {
      throw new Error('不支持的协议 ' + parsedWs.protocol);
    }
  } catch (err) {
    mediaCapture.releaseLocalCaptureMedia();
    isHosting = false;
    btnStart.disabled = false;
    btnStop.disabled = true;
    updateControlButtonUi();
    showNotice('信令地址格式无效（需以 http://、https://、ws:// 或 wss:// 开头）：' + err.message);
    return;
  }

  isHosting = true;
  if (window.airdeskAPI.setHostingActive) {
    window.airdeskAPI.setHostingActive(true).catch(() => {});
  }
  setLivePill('waiting', '待连接');
  btnStart.disabled = true;
  btnStop.disabled = false;
  updateControlButtonUi();
  connectSignalingSocket(wsUrl);
}

function connectSignalingSocket(wsUrl) {
  if (!isHosting || isManualStop) return;
  clearWsReconnectTimer();
  if (wsHeartbeatTimer) {
    clearInterval(wsHeartbeatTimer);
    wsHeartbeatTimer = null;
  }
  if (ws) {
    ws.onopen = null;
    ws.onerror = null;
    ws.onclose = null;
    ws.onmessage = null;
    try {
      ws.close();
    } catch {}
    ws = null;
  }

  let sock;
  try {
    sock = new WebSocket(wsUrl);
  } catch (err) {
    if (signalingModeSelect.value === 'remote' && isHosting && !isManualStop) {
      scheduleRelayWsReconnect(wsUrl);
    } else {
      stopHost('信令连接创建失败：' + err.message);
    }
    return;
  }

  ws = sock;
  statusEl.textContent =
    wsReconnectAttempt > 0
      ? '正在尝试重新连接公网信令服务器 (第 ' + wsReconnectAttempt + ' 次)...'
      : '正在连接信令服务器...';

  sock.onopen = () => {
    if (ws !== sock || !isHosting || isManualStop) {
      try {
        sock.close();
      } catch {}
      return;
    }
    wsReconnectAttempt = 0;
    clearWsReconnectTimer();
    const createPayload = {
      type: 'host:create',
      protoVersion: 2,
      hostLabel: 'AirDesk Electron Desktop',
      audioEnabled: Boolean(enableAudioCheckbox && enableAudioCheckbox.checked),
    };
    if (hostIdentity && hostIdentity.hostId && hostIdentity.hostSecret) {
      createPayload.hostId = hostIdentity.hostId;
      createPayload.hostSecret = hostIdentity.hostSecret;
    }
    if (signalingModeSelect.value === 'local' && localSignalingInfo && localSignalingInfo.localHostToken) {
      createPayload.localHostToken = localSignalingInfo.localHostToken;
    }
    const rk = relayAccessKeyInput ? relayAccessKeyInput.value.trim() : '';
    if (rk) createPayload.accessKey = rk;
    sock.send(JSON.stringify(createPayload));
    if (signalingModeSelect.value === 'remote') {
      wsHeartbeatTimer = setInterval(() => {
        if (ws === sock && sock.readyState === WebSocket.OPEN) {
          sock.send(JSON.stringify({ type: 'ws:ping', ts: Date.now() }));
        }
      }, 25000);
    }
  };

  sock.onerror = () => {
    if (ws !== sock) return;
    if (wsReconnectAttempt === 0) {
      showNotice('信令连接出现异常，请检查服务器地址或网络连通性');
    }
  };

  sock.onclose = (ev) => {
    if (ws !== sock) return;
    if (wsHeartbeatTimer) {
      clearInterval(wsHeartbeatTimer);
      wsHeartbeatTimer = null;
    }
    if (isManualStop || !isHosting) return;
    if (ev && ev.code === 4003) {
      stopHost('中继密钥或主机身份校验失败，已停止共享');
      return;
    }
    if (signalingModeSelect.value === 'remote') {
      hasPendingApproval = false;
      pendingApprovalClient = null;
      approvalCard.style.display = 'none';
      hasActivePeer = false;
      currentControlEnabled = false;
      activePeerIsOverlay = false;
      activeRelaySessionToken = '';
      cleanupPeerConnection(false);
      mediaCapture.releaseLocalCaptureMedia();
      window.airdeskAPI.setSessionActive(false).catch(() => {});
      pairCodeEl.textContent = '------';
      renderPairQr('').catch(() => {});
      updateControlButtonUi();
      scheduleRelayWsReconnect(wsUrl);
      return;
    }
    stopHost('信令连接已断开，已自动释放采集并切回只读');
  };

  sock.onmessage = async (ev) => {
    if (ws !== sock) return;
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }

    if (msg.type === 'ws:pong') {
      return;
    } else if (msg.type === 'error') {
      showNotice(msg.message || '信令服务器返回错误');
      statusEl.textContent = msg.message || '信令服务错误';
      return;
    } else if (msg.type === 'host:created' || msg.type === 'host:code_rotated') {
      if (Array.isArray(msg.iceServers)) {
        remoteIceServers = msg.iceServers;
      }
      setLivePill('waiting', '待连接');
      pairCodeEl.textContent = msg.code;
      await renderPairQr(msg.code);
      const hasTurn = remoteIceServers.some((s) => {
        const u = Array.isArray(s.urls) ? s.urls.join(',') : String(s.urls || '');
        return /^turns?:/i.test(u);
      });
      const hostIdNote =
        signalingModeSelect.value === 'remote' && hostIdentity && hostIdentity.hostId
          ? ' · 主机 ID: ' + hostIdentity.hostId
          : '';
      statusEl.textContent =
        signalingModeSelect.value === 'local'
          ? '内置本地信令已就绪：手机连接同一热点/Wi-Fi 扫码即可 0 流量直连'
          : (hasTurn
              ? '公网信令已就绪（已配 TURN 中继兜底' + hostIdNote + '）：等待手机接入...'
              : '公网信令已就绪（STUN P2P 穿透' + hostIdNote + '）：等待手机接入...');
    } else if (msg.type === 'host:password_challenge_request') {
      const chalRes = await window.airdeskAPI.createPasswordChallenge({
        challengeId: msg.challengeId,
      });
      if (ws === sock && sock.readyState === WebSocket.OPEN) {
        sock.send(
          JSON.stringify({
            type: 'host:password_challenge_reply',
            challengeId: msg.challengeId,
            ok: Boolean(chalRes && chalRes.ok),
            nonce: (chalRes && chalRes.nonce) || '',
            salt: (chalRes && chalRes.salt) || '',
            kdf: (chalRes && chalRes.kdf) || 'scrypt',
            n: (chalRes && chalRes.n) || 16384,
            r: (chalRes && chalRes.r) || 8,
            p: (chalRes && chalRes.p) || 1,
            dkLen: (chalRes && chalRes.dkLen) || 32,
            code: (chalRes && chalRes.code) || '',
            message: (chalRes && chalRes.message) || '',
          })
        );
      }
    } else if (msg.type === 'host:password_verify') {
      const clientMeta = msg.client || {};
      const verifyRes = await window.airdeskAPI.verifyPasswordChallenge({
        challengeId: msg.challengeId,
        proof: msg.proof,
        deviceLabel: clientMeta.deviceLabel,
        platformHint: clientMeta.platformHint,
        ipMasked: clientMeta.ipMasked,
      });
      if (verifyRes && verifyRes.ok) {
        activeRelaySessionToken = verifyRes.sessionToken;
      }
      if (window.airdeskAPI.getUnattendedPasswordStatus) {
        updateUnattendedPasswordUi(await window.airdeskAPI.getUnattendedPasswordStatus());
      }
      if (ws === sock && sock.readyState === WebSocket.OPEN) {
        sock.send(
          JSON.stringify({
            type: 'host:password_verified',
            challengeId: msg.challengeId,
            approved: Boolean(verifyRes && verifyRes.ok),
            sessionToken: (verifyRes && verifyRes.sessionToken) || '',
            mode: (verifyRes && verifyRes.mode) || 'full_control',
            code: (verifyRes && verifyRes.code) || '',
            message: (verifyRes && verifyRes.message) || '',
          })
        );
      }
    } else if (msg.type === 'host:verify_token') {
      const clientMeta = msg.client || {};
      const verifyRes = await window.airdeskAPI.verifyRelayTrustedToken({
        sessionToken: msg.sessionToken,
        ipMasked: clientMeta.ipMasked,
        deviceLabel: clientMeta.deviceLabel,
        platformHint: clientMeta.platformHint,
      });
      if (verifyRes && verifyRes.ok) {
        activeRelaySessionToken = msg.sessionToken;
      }
      if (ws === sock && sock.readyState === WebSocket.OPEN) {
        sock.send(
          JSON.stringify({
            type: 'host:token_verified',
            verifyId: msg.verifyId,
            approved: Boolean(verifyRes && verifyRes.ok),
            mode: (verifyRes && verifyRes.mode) || 'view_only',
            reason: (verifyRes && verifyRes.reason) || '',
          })
        );
      }
    } else if (msg.type === 'host:approval_request') {
      hasPendingApproval = true;
      pendingApprovalClient = msg.client || null;
      activePeerIsOverlay = Boolean(msg.client && msg.client.isOverlayPeer);
      const netBadge = activePeerIsOverlay ? ' [异地组网]' : '';
      approvalDesc.textContent =
        msg.client.deviceLabel +
        ' (' +
        msg.client.platformHint +
        ' · ' +
        msg.client.ipMasked +
        ')' +
        netBadge +
        ' 请求连接';
      approvalCard.style.display = 'block';
    } else if (msg.type === 'rtc:offer') {
      if (msg.iceRestart === true && pc && pc.signalingState !== 'closed') {
        await handleIceRestartOffer(msg.sdp);
      } else {
        await handleOffer(msg.sdp);
      }
    } else if (msg.type === 'rtc:ice') {
      if (pc && pc.remoteDescription) {
        await pc.addIceCandidate(msg.candidate).catch(() => {});
      } else {
        pendingIceCandidates.push(msg.candidate);
      }
    } else if (msg.type === 'host:client_reconnected') {
      hasActivePeer = true;
      activePeerIsOverlay = Boolean(msg.isOverlayPeer);
      currentControlEnabled = msg.mode === 'full_control';
      await window.airdeskAPI.setSessionActive(true);
      await window.airdeskAPI.setControlPermission(currentControlEnabled);
      updateControlButtonUi();
      statusEl.textContent = activePeerIsOverlay
        ? '已信任设备通过异地组网切回前台，正在自动免审批重连...'
        : '已信任设备切回前台，正在自动免审批重连...';
      showNotice(
        activePeerIsOverlay
          ? '已信任手机端通过 Tailscale 异地自动重连（免二次审批）'
          : '已信任手机端自动重连（免二次审批）'
      );
    } else if (msg.type === 'host:pending_cancelled') {
      hasPendingApproval = false;
      pendingApprovalClient = null;
      approvalCard.style.display = 'none';
      showNotice(msg.reason || '连接请求已取消');
    } else if (msg.type === 'host:client_disconnected') {
      statusEl.textContent = '客户端已断开：' + msg.reason;
      currentControlEnabled = false;
      activePeerIsOverlay = false;
      activeRelaySessionToken = '';
      if (isHosting) setLivePill('waiting', '待连接');
      cleanupPeerConnection();
      await window.airdeskAPI.setSessionActive(false);
    }
  };
}

function scheduleRelayWsReconnect(wsUrl) {
  if (!isHosting || isManualStop) return;
  const delayMs = WS_RECONNECT_DELAYS_MS[Math.min(wsReconnectAttempt, WS_RECONNECT_DELAYS_MS.length - 1)];
  wsReconnectAttempt += 1;
  setLivePill('waiting', '重连中');
  statusEl.textContent =
    '公网信令连接断开，' +
    Math.round(delayMs / 1000) +
    ' 秒后自动重连 (第 ' +
    wsReconnectAttempt +
    ' 次)...';
  clearWsReconnectTimer();
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    connectSignalingSocket(wsUrl);
  }, delayMs);
}

async function handleIceRestartOffer(remoteSdp) {
  if (!pc || pc.signalingState === 'closed' || !ws || ws.readyState !== WebSocket.OPEN) {
    return handleOffer(remoteSdp);
  }
  const currentPc = pc;
  if (disconnectGraceTimer) {
    clearTimeout(disconnectGraceTimer);
    disconnectGraceTimer = null;
  }
  const tier = computeTieredVideoBitrates();
  const boostedOfferSdp = boostVideoSdpBitrate(remoteSdp, tier.minKbps, tier.startKbps, tier.maxKbps);
  const offerExt = ensurePlayoutDelayExtInSdp(boostedOfferSdp);
  const tunedOfferSdp = enhanceAudioOpusSdp(offerExt.sdp);
  try {
    await currentPc.setRemoteDescription({ type: 'offer', sdp: tunedOfferSdp });
  } catch (err) {
    console.warn('[AirDesk] iceRestart boosted SDP rejected, falling back:', err.message);
    await currentPc.setRemoteDescription({ type: 'offer', sdp: remoteSdp });
  }
  if (pc !== currentPc) return;

  for (const cand of pendingIceCandidates) {
    await currentPc.addIceCandidate(cand).catch(() => {});
  }
  pendingIceCandidates = [];

  const answer = await currentPc.createAnswer();
  const ansExt = ensurePlayoutDelayExtInSdp(answer.sdp, offerExt.extId);
  const tunedAnswerSdp = enhanceAudioOpusSdp(ansExt.sdp);
  let sentAnswer = answer;
  try {
    const tweakedAnswer = { type: answer.type, sdp: tunedAnswerSdp };
    await currentPc.setLocalDescription(tweakedAnswer);
    sentAnswer = tweakedAnswer;
  } catch (err) {
    console.warn('[AirDesk] iceRestart answer SDP rejected, falling back:', err.message);
    await currentPc.setLocalDescription(answer);
  }
  if (pc !== currentPc || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'rtc:answer', sdp: sentAnswer.sdp, iceRestart: true }));
  statusEl.textContent = '收到手机端切网 iceRestart 请求，正在原地刷新通道...';
}

async function handleOffer(remoteSdp) {
  mediaCapture.cancelIdleCaptureRelease();
  cleanupPeerConnection(false);

  const currentPc = new RTCPeerConnection({
    iceServers: buildIceServers(),
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
  });
  pc = currentPc;

  try {
    await mediaCapture.ensureLocalCaptureReady();
  } catch (err) {
    if (pc === currentPc) {
      cleanupPeerConnection(false);
    }
    showNotice('启动屏幕采集失败：' + (err && err.message ? err.message : err));
    return;
  }
  const localStream = mediaCapture.getLocalStream();
  if (pc !== currentPc || !isHosting || !localStream) {
    if (!isHosting) {
      mediaCapture.releaseLocalCaptureMedia();
    }
    return;
  }

  const CLASH_TUN_RE = /^198\.1[89]\./;
  const TAILSCALE_RE = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;
  const isVirtualCandidate = (candidateStr) => {
    const parts = String(candidateStr || '').split(' ');
    const address = parts[4] || '';
    if (CLASH_TUN_RE.test(address)) return true;
    const allowOverlay = Boolean(allowVirtualNetCheckbox && allowVirtualNetCheckbox.checked) || activePeerIsOverlay;
    if (!allowOverlay && TAILSCALE_RE.test(address)) {
      return true;
    }
    return false;
  };

  currentPc.onicecandidate = (e) => {
    if (pc !== currentPc || !e.candidate || !ws || ws.readyState !== WebSocket.OPEN) return;
    if (isVirtualCandidate(e.candidate.candidate)) return;
    ws.send(JSON.stringify({ type: 'rtc:ice', candidate: e.candidate }));
  };

  const resetOnConnectionLost = async (stateLabel) => {
    if (pc !== currentPc) return;
    hasActivePeer = false;
    currentControlEnabled = false;
    if (isHosting) setLivePill('waiting', '待连接');
    updateControlButtonUi();
    cleanupPeerConnection(true);
    await window.airdeskAPI.setSessionActive(false);
    statusEl.textContent = 'WebRTC 链路已断开（' + stateLabel + '），已自动切回只读并释放所有按键';
  };

  currentPc.onconnectionstatechange = async () => {
    if (pc !== currentPc) return;
    const state = currentPc.connectionState;
    if (state === 'connected') {
      if (disconnectGraceTimer) {
        clearTimeout(disconnectGraceTimer);
        disconnectGraceTimer = null;
      }
      hasActivePeer = true;
      setLivePill('live', '串流中');
      await window.airdeskAPI.setSessionActive(true);
      updateControlButtonUi();
    } else if (state === 'disconnected') {
      if (!disconnectGraceTimer) {
        statusEl.textContent = 'WebRTC 链路波动 (disconnected)，等待切网恢复 / iceRestart...';
        disconnectGraceTimer = setTimeout(() => {
          disconnectGraceTimer = null;
          if (pc === currentPc && currentPc.connectionState !== 'connected') {
            resetOnConnectionLost(currentPc.connectionState).catch(() => {});
          }
        }, 8000);
      }
    } else if (state === 'failed') {
      if (ws && ws.readyState === WebSocket.OPEN) {
        if (!disconnectGraceTimer) {
          statusEl.textContent = 'WebRTC 链路中断 (failed)，等待手机端发起 iceRestart...';
          disconnectGraceTimer = setTimeout(() => {
            disconnectGraceTimer = null;
            if (pc === currentPc && currentPc.connectionState !== 'connected') {
              resetOnConnectionLost(currentPc.connectionState).catch(() => {});
            }
          }, 3000);
        }
      } else {
        if (disconnectGraceTimer) {
          clearTimeout(disconnectGraceTimer);
          disconnectGraceTimer = null;
        }
        await resetOnConnectionLost(state);
      }
    } else if (state === 'closed') {
      if (disconnectGraceTimer) {
        clearTimeout(disconnectGraceTimer);
        disconnectGraceTimer = null;
      }
      await resetOnConnectionLost(state);
    }
  };

  pc.ondatachannel = (ev) => {
    const dc = ev.channel;
    if (dc.label === 'file-transfer') {
      fileTransfer.attachFileTransferChannel(dc);
      return;
    }
    if (dc.label === 'ctrl-reliable') {
      reliableDc = dc;
      dc.onopen = () => {
        pushDisplaysListToClient();
        pushUiConfigToClient();
        if (dc.readyState === 'open') {
          dc.send(JSON.stringify({ t: 'perm', controlEnabled: currentControlEnabled }));
          if (hostInSecureDesktop) {
            sendSecureDesktopToClient();
          }
        }
      };
    } else if (dc.label === 'input-unreliable') {
      unreliableDc = dc;
    }

    dc.onmessage = async (m) => {
      let data;
      try {
        data = JSON.parse(m.data);
      } catch {
        return;
      }

      if (
        data.t === 'm:rel' ||
        data.t === 'm:abs' ||
        data.t === 'm:whl' ||
        data.t === 'm:btn' ||
        data.t === 'k:down' ||
        data.t === 'k:up' ||
        data.t === 'text:unicode'
      ) {
        lastRemoteInputAt = Date.now();
        if (isIdleThrottled) {
          isIdleThrottled = false;
          applyVideoParameters(
            abr.state.currentTargetKbps,
            abr.state.adaptiveFpsCap || captureMaxFps()
          ).catch(() => {});
        }
      }

      if (data.t === 'm:rel' || data.t === 'm:abs' || data.t === 'm:whl') {
        window.airdeskAPI.sendPointerFast(data);
        return;
      }

      if (data.t === 'ping') {
        await window.airdeskAPI.sendHeartbeat();
        if (dc.readyState === 'open') dc.send(JSON.stringify({ t: 'pong', ts: data.ts }));
      } else if (data.t === 'display:switch' && data.displayId) {
        await mediaCapture.switchActiveDisplay(data.displayId);
      } else if (data.t === 'policy') {
        let needRecapture = false;
        const validRes = data.resolution === '720p' || data.resolution === '900p' || data.resolution === '1080p' || data.resolution === 'native';
        if (validRes && resolutionSelect.value !== data.resolution) {
          resolutionSelect.value = data.resolution;
          localStorage.setItem(STORAGE_RES_KEY, data.resolution);
          needRecapture = true;
        }
        const reqFps = Number(data.fps);
        if (framerateSelect && reqFps > 0) {
          const nextFpsStr = reqFps >= 60 ? '60' : '30';
          if (framerateSelect.value !== nextFpsStr) {
            framerateSelect.value = nextFpsStr;
            localStorage.setItem(STORAGE_FPS_KEY, nextFpsStr);
            needRecapture = true;
          }
        }
        if (
          contentHintSelect &&
          (data.contentHint === 'auto' || data.contentHint === 'detail' || data.contentHint === 'motion')
        ) {
          contentHintSelect.value = data.contentHint;
          localStorage.setItem(STORAGE_HINT_KEY, data.contentHint);
          mediaCapture.applyContentHintToActiveTrack();
        }
        if (needRecapture && mediaCapture.getLocalStream()) {
          mediaCapture.clearWarmDisplayTracks();
          await mediaCapture.switchActiveDisplay(displaySelect.value, true);
        }
        const maxPolicyCap = signalingModeSelect && signalingModeSelect.value === 'remote' ? 8000 : 35000;
        const targetBitrate = Math.min(maxPolicyCap, Math.max(1000, Number(data.maxBitrateKbps) || 15000));
        const targetFps = reqFps > 0 ? reqFps : data.preset === 'office_saver' ? 20 : captureMaxFps();
        resetAdaptiveBitrate(targetBitrate);
        await applyVideoParameters(abr.state.currentTargetKbps, targetFps);
      } else if (data.t === 'diag:rx') {
        lastClientDiag = data;
        lastClientDiagAt = Date.now();
      } else if (data.t === 'clip:push') {
        await window.airdeskAPI.writeClipboard(data.text);
      } else if (data.t === 'clip:pull') {
        const res = await window.airdeskAPI.readClipboard();
        if (dc.readyState === 'open') dc.send(JSON.stringify({ t: 'clip:data', text: res.text || '' }));
      } else if (data.t === 'audio:set') {
        if (!currentControlEnabled) {
          if (dc.readyState === 'open') {
            dc.send(
              JSON.stringify({
                t: 'audio:error',
                message: '当前为只读模式，需先开启操控权限才可远程切换声音',
              })
            );
          }
          return;
        }
        await mediaCapture.setDesktopAudioEnabled(Boolean(data.enabled), true);
      } else if (data.t === 'video:pli') {
        lastPliHandledAt = Date.now();
      } else {
        await window.airdeskAPI.injectInput(data);
      }
    };
  };

  try {
    const tier = computeTieredVideoBitrates();
    const boostedOfferSdp = boostVideoSdpBitrate(remoteSdp, tier.minKbps, tier.startKbps, tier.maxKbps);
    const offerExt = ensurePlayoutDelayExtInSdp(boostedOfferSdp);
    const tunedOfferSdp = enhanceAudioOpusSdp(offerExt.sdp);
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: tunedOfferSdp });
    } catch (err) {
      console.warn('[AirDesk] Boosted remote SDP rejected, falling back to raw SDP:', err.message);
      await pc.setRemoteDescription({ type: 'offer', sdp: remoteSdp });
    }

    const vTrack = localStream.getVideoTracks()[0];
    if (vTrack && 'contentHint' in vTrack) {
      vTrack.contentHint = mediaCapture.initialTrackContentHint();
    }
    lastAppliedVideoParams = null;
    videoSender = pc.addTrack(vTrack, localStream);
    if (enableAudioCheckbox && enableAudioCheckbox.checked) {
      await mediaCapture.maybeRouteVirtualAudioForStream();
      const curAudioTrack = mediaCapture.getLocalAudioTrack();
      if (!curAudioTrack || curAudioTrack.readyState !== 'live') {
        await mediaCapture.ensureDesktopAudioTrack();
      }
    }
    const aTrack = mediaCapture.getLocalAudioTrack() || localStream.getAudioTracks()[0];
    audioSender = aTrack ? pc.addTrack(aTrack, localStream) : null;

    const videoTransceiver = pc.getTransceivers().find((t) => t.sender === videoSender);
    if (videoTransceiver && RTCRtpReceiver.getCapabilities) {
      const recvCaps = RTCRtpReceiver.getCapabilities('video');
      if (recvCaps && recvCaps.codecs) {
        const preferHevc = Boolean(codecSelect && codecSelect.value === 'hevc') || sdpPrefersHevc(remoteSdp);
        const preferredCodecs = sortPreferredVideoCodecs(recvCaps.codecs, preferHevc);
        if (preferredCodecs.length) {
          try {
            videoTransceiver.setCodecPreferences(preferredCodecs);
          } catch (err) {
            console.warn('[AirDesk] Codec preference rejected, keeping default codecs:', err.name, err.message);
          }
        }
      }
    }
    for (const cand of pendingIceCandidates) {
      await pc.addIceCandidate(cand).catch(() => {});
    }
    pendingIceCandidates = [];

    const answer = await pc.createAnswer();
    const ansExt = ensurePlayoutDelayExtInSdp(answer.sdp, offerExt.extId);
    const tunedAnswerSdp = enhanceAudioOpusSdp(ansExt.sdp);
    let sentAnswer = answer;
    try {
      const tweakedAnswer = { type: answer.type, sdp: tunedAnswerSdp };
      await pc.setLocalDescription(tweakedAnswer);
      sentAnswer = tweakedAnswer;
    } catch (err) {
      console.warn('[AirDesk] Playout-delay answer SDP rejected, falling back:', err.message);
      await pc.setLocalDescription(answer);
    }
    if (pc !== currentPc || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'rtc:answer', sdp: sentAnswer.sdp }));
    hasActivePeer = true;
    if (Date.now() < audioRenegotiatePreserveCtrlUntil) {
      currentControlEnabled = preservedControlEnabled;
      audioRenegotiatePreserveCtrlUntil = 0;
    }
    await window.airdeskAPI.setSessionActive(true);
    await window.airdeskAPI.setControlPermission(currentControlEnabled);
    updateControlButtonUi();
    resetAdaptiveBitrate(tier.maxKbps);
    await applyVideoParameters(abr.state.currentTargetKbps, captureMaxFps());
    startRtcStatsMonitor();
    setLivePill('live', '串流中');
    statusEl.textContent = activePeerIsOverlay
      ? 'WebRTC 异地组网串流已建立（支持全局快捷键切屏/切权与系统级操控）'
      : 'WebRTC 串流已建立（支持全局快捷键切屏/切权与系统级操控）';
  } catch (err) {
    if (pc === currentPc) {
      cleanupPeerConnection(true);
    }
    showNotice('建立 WebRTC 通道失败：' + (err && err.message ? err.message : err));
  }
}

async function approveRequest(mode) {
  hasPendingApproval = false;
  const clientMeta = pendingApprovalClient || {};
  pendingApprovalClient = null;
  approvalCard.style.display = 'none';
  hasActivePeer = true;
  currentControlEnabled = mode === 'full_control';
  await window.airdeskAPI.setSessionActive(true);
  await window.airdeskAPI.setControlPermission(currentControlEnabled);
  updateControlButtonUi();
  const decisionPayload = { type: 'host:approval_decision', approved: true, mode };
  if (signalingModeSelect.value === 'remote' && window.airdeskAPI.issueRelayTrustedToken) {
    const issued = await window.airdeskAPI.issueRelayTrustedToken({
      mode,
      deviceLabel: clientMeta.deviceLabel || '远程移动设备',
      platformHint: clientMeta.platformHint || 'Mobile',
      ipMasked: clientMeta.ipMasked || 'WAN',
    });
    if (issued && issued.sessionToken) {
      decisionPayload.sessionToken = issued.sessionToken;
      activeRelaySessionToken = issued.sessionToken;
    }
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(decisionPayload));
  }
}

function rejectRequest() {
  hasPendingApproval = false;
  pendingApprovalClient = null;
  approvalCard.style.display = 'none';
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'host:approval_decision', approved: false }));
  }
}

async function init() {
  const info = await window.airdeskAPI.getSystemInfo();
  hostIdentity = info.hostIdentity || null;
  if (hostIdTextEl) {
    hostIdTextEl.textContent = (hostIdentity && hostIdentity.hostId) || '------------';
  }
  updateUnattendedPasswordUi(info.unattendedPasswordStatus || null);
  const hostSettings = info.hostSettings || {};
  displaysMeta = info.displays || [];
  localSignalingInfo = info.localSignaling || null;
  currentControlEnabled = Boolean(info.controlEnabled);
  await refreshDisplaysUi(displaysMeta);

  const savedMode = localStorage.getItem(STORAGE_MODE_KEY);
  if (info.defaultSignalingUrl) {
    localStorage.setItem(STORAGE_SERVER_KEY, info.defaultSignalingUrl);
    signalingModeSelect.value = 'remote';
  } else if (savedMode === 'remote' || savedMode === 'local') {
    signalingModeSelect.value = savedMode;
  } else {
    signalingModeSelect.value = localSignalingInfo && localSignalingInfo.running ? 'local' : 'remote';
  }
  syncSignalingInputState();
  updateControlButtonUi();
  updateFirewallUi(info.firewall);
  if (btnFixFirewall) {
    btnFixFirewall.onclick = async () => {
      btnFixFirewall.disabled = true;
      try {
        const res = await window.airdeskAPI.ensureFirewallRule();
        updateFirewallUi(res && res.firewall ? res.firewall : await window.airdeskAPI.checkFirewall());
        if (res && res.ok) {
          showNotice('Windows 防火墙已放行 TCP/UDP 47820 端口');
        } else {
          showNotice((res && res.error) || '未能写入防火墙规则，请确认允许管理员 UAC 授权');
        }
      } finally {
        btnFixFirewall.disabled = false;
      }
    };
  }
  if (btnUsbDirect) btnUsbDirect.onclick = () => runUsbDirectSetup(false);
  if (btnUsbTether) btnUsbTether.onclick = () => runUsbDirectSetup(true);

  if (btnSendFiles && fileSendInput) {
    btnSendFiles.onclick = () => fileSendInput.click();
    fileSendInput.onchange = () => {
      if (fileSendInput.files && fileSendInput.files.length > 0) {
        fileTransfer.enqueueFilesForMobile(fileSendInput.files);
      }
      fileSendInput.value = '';
    };
  }
  if (btnOpenDownloads) {
    btnOpenDownloads.onclick = () => {
      if (window.airdeskAPI.openDownloadsFolder) {
        window.airdeskAPI.openDownloadsFolder().catch(() => {});
      }
    };
  }
  if (window.airdeskAPI.onLanFileReceived) {
    window.airdeskAPI.onLanFileReceived((data) => {
      if (!data || !data.finalName) return;
      fileTransfer.updateFileTransferUi(
        '局域网快传接收完成：' + data.finalName + ' (' + formatFileBytes(data.size) + ')',
        1
      );
      fileTransfer.appendFileTransferLog('局域网快传收到：' + (data.savedPath || data.finalName));
      showNotice('已通过局域网快传收到文件：' + data.finalName);
    });
  }
  if (fileDropZone) {
    fileDropZone.onclick = () => {
      if (fileSendInput) fileSendInput.click();
    };
    fileDropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      fileDropZone.style.borderColor = '#60A5FA';
      fileDropZone.style.color = '#E2E8F0';
    });
    fileDropZone.addEventListener('dragleave', () => {
      fileDropZone.style.borderColor = '#334155';
      fileDropZone.style.color = '#94A3B8';
    });
    fileDropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      fileDropZone.style.borderColor = '#334155';
      fileDropZone.style.color = '#94A3B8';
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        fileTransfer.enqueueFilesForMobile(e.dataTransfer.files);
      }
    });
  }

  enableVkbCheckbox.checked = localStorage.getItem(STORAGE_VKB_KEY) === '1';
  enableAudioCheckbox.checked = localStorage.getItem(STORAGE_AUDIO_KEY) === '1';
  enableVkbCheckbox.onchange = () => {
    localStorage.setItem(STORAGE_VKB_KEY, enableVkbCheckbox.checked ? '1' : '0');
    pushUiConfigToClient();
    showNotice(enableVkbCheckbox.checked ? '已开启移动端虚拟键盘入口（手机端可一键弹出/收起）' : '已关闭移动端虚拟键盘入口（手机端按钮已完全隐藏）');
  };
  enableAudioCheckbox.onchange = () => {
    mediaCapture.setDesktopAudioEnabled(Boolean(enableAudioCheckbox.checked), false);
  };

  virtualAudioInfo =
    info.virtualAudio ||
    (window.airdeskAPI.getVirtualAudioInfo ? await window.airdeskAPI.getVirtualAudioInfo() : null);
  if (virtualAudioToggleWrap && muteHostVirtualAudioCheckbox) {
    if (virtualAudioInfo && virtualAudioInfo.available) {
      virtualAudioToggleWrap.style.display = 'inline-flex';
      if (virtualAudioToggleLabel) {
        virtualAudioToggleLabel.textContent =
          '串流音频时切换至虚拟声卡静音本机 (' + virtualAudioInfo.deviceName + ')';
      }
      muteHostVirtualAudioCheckbox.checked = localStorage.getItem(STORAGE_VIRTUAL_AUDIO_KEY) === '1';
      muteHostVirtualAudioCheckbox.onchange = async () => {
        const checked = Boolean(muteHostVirtualAudioCheckbox.checked);
        localStorage.setItem(STORAGE_VIRTUAL_AUDIO_KEY, checked ? '1' : '0');
        if (hasActivePeer && enableAudioCheckbox && enableAudioCheckbox.checked && window.airdeskAPI.setVirtualAudioRoute) {
          const res = await window.airdeskAPI.setVirtualAudioRoute({
            enable: checked,
            deviceId: virtualAudioInfo.deviceId || '',
          });
          await new Promise((r) => setTimeout(r, 150));
          mediaCapture.stopAudioCaptureOnly();
          const at = await mediaCapture.ensureDesktopAudioTrack();
          if (audioSender && at) {
            await audioSender.replaceTrack(at).catch(() => {});
          }
          if (checked) {
            showNotice(
              res && res.ok
                ? '已切换本机默认输出至虚拟声卡 (' + (res.deviceName || virtualAudioInfo.deviceName) + ')，本机已静音'
                : '切换虚拟声卡失败：' + ((res && res.reason) || '未知错误')
            );
          } else {
            showNotice('已恢复原默认音频输出设备');
          }
        } else {
          showNotice(
            checked
              ? '已启用：串流声音期间自动切至虚拟声卡静音本机'
              : '已关闭虚拟声卡自动静音本机'
          );
        }
      };
    } else {
      virtualAudioToggleWrap.style.display = 'none';
      muteHostVirtualAudioCheckbox.checked = false;
    }
  }

  hostInSecureDesktop = Boolean(info.secureDesktopActive);
  hostElevatedConnected = Boolean(info.elevatedService && info.elevatedService.pipeConnected);
  if (window.airdeskAPI.onSecureDesktop) {
    window.airdeskAPI.onSecureDesktop((data) => {
      const wasActive = hostInSecureDesktop;
      hostInSecureDesktop = Boolean(data && data.active);
      hostElevatedConnected = Boolean(data && data.elevatedConnected);
      sendSecureDesktopToClient();
      if (hostInSecureDesktop) {
        if (secureDesktopRecoverTimer) {
          clearTimeout(secureDesktopRecoverTimer);
          secureDesktopRecoverTimer = null;
        }
        showNotice('检测到 Windows UAC / 安全桌面，已通知控制端并释放远程按键', 5000);
      } else if (wasActive) {
        if (secureDesktopRecoverTimer) clearTimeout(secureDesktopRecoverTimer);
        secureDesktopRecoverTimer = setTimeout(() => {
          secureDesktopRecoverTimer = null;
          mediaCapture.recoverVideoCaptureIfNeeded('secure_desktop_exit').catch(() => {});
        }, 300);
      }
    });
  }

  const ips = info.interfaces.map((i) => i.tag + ': ' + i.address).join('  ·  ');
  const svcConnected = Boolean(info.elevatedService && info.elevatedService.pipeConnected);
  netInfoEl.textContent =
    '本机网卡（已关闭 mDNS）: ' +
    (ips || '未检测到外部网卡') +
    '  ·  本地信令: ' +
    (localSignalingInfo && localSignalingInfo.running
      ? localSignalingInfo.preferredHttpUrl + ' (运行中)'
      : '未启动') +
    '  ·  原生 Helper: ' +
    (info.helperReady ? (svcConnected ? 'SYSTEM 提权服务' : '普通绿色模式') : '未就绪');

  updateElevatedServiceUi(info.elevatedService);
  if (btnInstallService) {
    btnInstallService.onclick = async () => {
      btnInstallService.disabled = true;
      if (btnUninstallService) btnUninstallService.disabled = true;
      try {
        showNotice('请在弹出的 Windows UAC 确认框中允许安装后台输入服务...', 5000);
        const res = await window.airdeskAPI.installElevatedService();
        updateElevatedServiceUi(res && res.status ? res.status : await window.airdeskAPI.getElevatedServiceStatus());
        if (res && res.ok) {
          showNotice('Windows 后台提权服务已安装并接入成功！');
        } else {
          showNotice((res && res.error) || '后台提权服务安装未完成');
        }
      } finally {
        btnInstallService.disabled = false;
        if (btnUninstallService) btnUninstallService.disabled = false;
      }
    };
  }
  if (btnUninstallService) {
    btnUninstallService.onclick = async () => {
      btnUninstallService.disabled = true;
      if (btnInstallService) btnInstallService.disabled = true;
      try {
        const res = await window.airdeskAPI.uninstallElevatedService();
        updateElevatedServiceUi(res && res.status ? res.status : await window.airdeskAPI.getElevatedServiceStatus());
        if (res && res.ok) {
          showNotice('已卸载后台提权服务并恢复普通绿色模式');
        } else {
          showNotice((res && res.error) || '后台服务卸载失败');
        }
      } finally {
        btnUninstallService.disabled = false;
        if (btnInstallService) btnInstallService.disabled = false;
      }
    };
  }
  if (btnRefreshService) {
    btnRefreshService.onclick = async () => {
      const st = await window.airdeskAPI.getElevatedServiceStatus();
      updateElevatedServiceUi(st);
      showNotice(st && st.pipeConnected ? '后台提权服务已连接' : '后台服务状态已刷新');
    };
  }

  hotkeyListEl.innerHTML = '';
  for (const hk of info.shortcuts || []) {
    const item = document.createElement('div');
    item.className = 'hk-item';
    item.innerHTML =
      '<span class="hk-key">' +
      hk.label +
      '</span><span style="color:' +
      (hk.active ? '#CBD5E1' : '#F87171') +
      ';">' +
      hk.desc +
      (hk.active ? '' : '（被占用）') +
      '</span>';
    hotkeyListEl.appendChild(item);
  }

  window.airdeskAPI.onEmergencyStop(() => {
    currentControlEnabled = false;
    updateControlButtonUi();
    statusEl.textContent = '已触发物理急停 (Ctrl+Alt+Esc)，远程操控权限已切断并释放所有按键';
    showNotice('已触发物理急停：所有远程按键已安全释放');
    if (reliableDc && reliableDc.readyState === 'open') {
      reliableDc.send(
        JSON.stringify({
          t: 'perm',
          controlEnabled: false,
          reason: '电脑端已触发物理急停 (Ctrl+Alt+Esc)',
        })
      );
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'host:emergency_stop' }));
    }
  });

  window.airdeskAPI.onHotkeyAction(async (evt) => {
    if (!evt || !evt.action) return;
    if (evt.action === 'toggle-stream') {
      if (isHosting) await stopHost('已通过全局快捷键 (Ctrl+Alt+S) 停止共享');
      else await startHost();
    } else if (evt.action === 'cycle-display') {
      if (screenSources.length <= 1) {
        showNotice('当前仅检测到 1 台显示器');
        return;
      }
      const idx = screenSources.findIndex((s) => (s.displayId || s.id) === displaySelect.value);
      const next = screenSources[(idx + 1) % screenSources.length];
      if (next) {
        const nextId = next.displayId || next.id;
        displaySelect.value = nextId;
        if (mediaCapture.getLocalStream()) {
          await mediaCapture.switchActiveDisplay(nextId);
        }
        showNotice('快捷键切屏：已切换至 ' + next.name);
      }
    } else if (evt.action === 'toggle-control') {
      currentControlEnabled = Boolean(evt.controlEnabled);
      updateControlButtonUi();
      const label = currentControlEnabled ? '允许远程操控' : '仅观看（只读）';
      showNotice('快捷键切权 (Ctrl+Alt+L)：当前已切换为「' + label + '」');
      if (signalingModeSelect.value === 'remote' && activeRelaySessionToken && window.airdeskAPI.updateRelayTokenMode) {
        window.airdeskAPI
          .updateRelayTokenMode({
            sessionToken: activeRelaySessionToken,
            mode: currentControlEnabled ? 'full_control' : 'view_only',
          })
          .catch(() => {});
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'host:update_config',
            activeMode: currentControlEnabled ? 'full_control' : 'view_only',
          })
        );
      }
      if (reliableDc && reliableDc.readyState === 'open') {
        reliableDc.send(
          JSON.stringify({
            t: 'perm',
            controlEnabled: currentControlEnabled,
            reason: '电脑端快捷键已切换至：' + label,
          })
        );
      }
    } else if (evt.action === 'toggle-control-blocked') {
      currentControlEnabled = false;
      updateControlButtonUi();
      showNotice(evt.reason || '当前无活跃手机连接，暂不可切换操控权限');
    } else if (evt.action === 'approve-full' && hasPendingApproval) {
      await approveRequest('full_control');
      showNotice('已通过快捷键 (Ctrl+Alt+Y) 批准连接并开启操控');
    } else if (evt.action === 'reject-request' && hasPendingApproval) {
      rejectRequest();
      showNotice('已通过快捷键 (Ctrl+Alt+N) 拒绝连接请求');
    }
  });

  window.airdeskAPI.onPhysicalOverride(() => {
    showNotice('检测到本机物理鼠标移动：已自动让权 3 秒并释放远程鼠标按键');
  });

  window.airdeskAPI.onInputsReleased((data) => {
    showNotice('防卡键/安全事件触发：' + (data && data.reason ? data.reason : '已释放全部输入'));
  });

  window.airdeskAPI.onDisplaysChanged((nextDisplays) => {
    mediaCapture.clearWarmDisplayTracks();
    refreshDisplaysUi(nextDisplays).catch(() => {});
    showNotice('检测到显示器热插拔，已刷新屏幕列表');
  });

  signalingModeSelect.onchange = syncSignalingInputState;

  displaySelect.onchange = () => {
    if (mediaCapture.getLocalStream()) {
      mediaCapture.switchActiveDisplay(displaySelect.value).catch((err) => {
        showNotice('切换显示器失败：' + err.message);
      });
    }
  };

  const savedRes = localStorage.getItem(STORAGE_RES_KEY);
  if (savedRes === '720p' || savedRes === '900p' || savedRes === '1080p' || savedRes === 'native') {
    resolutionSelect.value = savedRes;
  } else {
    resolutionSelect.value = '1080p';
  }
  resolutionSelect.onchange = () => {
    localStorage.setItem(STORAGE_RES_KEY, resolutionSelect.value);
    mediaCapture.clearWarmDisplayTracks();
    if (mediaCapture.getLocalStream()) {
      mediaCapture
        .switchActiveDisplay(displaySelect.value, true)
        .then(() => {
          resetAdaptiveBitrate(defaultBitrateKbps());
          return applyVideoParameters(abr.state.currentTargetKbps, captureMaxFps());
        })
        .catch((err) => {
          showNotice('切换分辨率失败：' + err.message);
        });
    }
  };

  if (contentHintSelect) {
    const savedHint = localStorage.getItem(STORAGE_HINT_KEY);
    contentHintSelect.value =
      savedHint === 'detail' || savedHint === 'motion' || savedHint === 'auto' ? savedHint : 'auto';
    contentHintSelect.onchange = () => {
      localStorage.setItem(STORAGE_HINT_KEY, contentHintSelect.value);
      mediaCapture.applyContentHintToActiveTrack();
      showNotice(
        '已切换编码策略：' +
          (contentHintSelect.value === 'auto'
            ? '自动硬编探测（优先 detail 硬编，若回退软编自动切 motion）'
            : contentHintSelect.value)
      );
    };
  }
  if (codecSelect) {
    const savedCodec = localStorage.getItem(STORAGE_CODEC_KEY);
    codecSelect.value = savedCodec === 'hevc' ? 'hevc' : 'h264';
    codecSelect.onchange = () => {
      localStorage.setItem(STORAGE_CODEC_KEY, codecSelect.value);
      showNotice(
        codecSelect.value === 'hevc'
          ? '已设为优先 H.265/HEVC（下次建立连接时生效，不支持时自动回退 H.264）'
          : '已设为 H.264 低延迟通用编码（下次建立连接时生效）'
      );
    };
  }
  if (enableIdleFpsSaverCheckbox) {
    enableIdleFpsSaverCheckbox.checked = localStorage.getItem(STORAGE_IDLE_FPS_KEY) === '1';
    enableIdleFpsSaverCheckbox.onchange = () => {
      localStorage.setItem(STORAGE_IDLE_FPS_KEY, enableIdleFpsSaverCheckbox.checked ? '1' : '0');
      if (!enableIdleFpsSaverCheckbox.checked && isIdleThrottled) {
        isIdleThrottled = false;
        applyVideoParameters(
          abr.state.currentTargetKbps,
          abr.state.adaptiveFpsCap || captureMaxFps()
        ).catch(() => {});
      }
      showNotice(
        enableIdleFpsSaverCheckbox.checked
          ? '已开启空闲 12s 自动降帧节能 (8fps)'
          : '已关闭空闲降帧节能，保持恒定目标帧率'
      );
    };
  }
  if (enableAutoClipboardCheckbox) {
    enableAutoClipboardCheckbox.checked = localStorage.getItem(STORAGE_AUTO_CLIP_KEY) === '1';
    enableAutoClipboardCheckbox.onchange = () => {
      localStorage.setItem(STORAGE_AUTO_CLIP_KEY, enableAutoClipboardCheckbox.checked ? '1' : '0');
      showNotice(
        enableAutoClipboardCheckbox.checked
          ? '已开启电脑剪贴板自动同步至手机（仅在允许操控且文本变化时推送）'
          : '已关闭剪贴板自动同步'
      );
    };
  }
  if (allowVirtualNetCheckbox) {
    allowVirtualNetCheckbox.checked = localStorage.getItem(STORAGE_VNET_KEY) === '1';
    allowVirtualNetCheckbox.onchange = () => {
      localStorage.setItem(STORAGE_VNET_KEY, allowVirtualNetCheckbox.checked ? '1' : '0');
      showNotice(
        allowVirtualNetCheckbox.checked
          ? '已允许 Tailscale / ZeroTier 100.64.0.0/10 异地组网直连'
          : '已恢复仅局域网直连（自动拦截 Tailscale 与 Clash TUN 虚拟网段）'
      );
    };
  }
  if (customStunInput) {
    customStunInput.value = localStorage.getItem(STORAGE_ICE_KEY) || '';
    customStunInput.onchange = () => {
      localStorage.setItem(STORAGE_ICE_KEY, customStunInput.value.trim());
    };
  }
  if (relayAccessKeyInput) {
    relayAccessKeyInput.value = localStorage.getItem(STORAGE_RELAY_KEY) || '';
    relayAccessKeyInput.onchange = () => {
      localStorage.setItem(STORAGE_RELAY_KEY, relayAccessKeyInput.value.trim());
    };
  }
  if (btnRefreshTrusted) {
    btnRefreshTrusted.onclick = () => refreshTrustedDevicesUi();
  }
  if (btnRevokeAllTokens) {
    btnRevokeAllTokens.onclick = async () => {
      await window.airdeskAPI.revokeTrustedDevice('*');
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'host:update_config', revokeAllTokens: true }));
      }
      await refreshTrustedDevicesUi();
      showNotice('已清空所有已信任设备的 7 天免密凭证');
    };
  }
  if (window.airdeskAPI.onTrustedDevicesUpdated) {
    window.airdeskAPI.onTrustedDevicesUpdated(() => {
      refreshTrustedDevicesUi().catch(() => {});
    });
  }
  if (window.airdeskAPI.onTrustedTokenRevoked) {
    window.airdeskAPI.onTrustedTokenRevoked((data) => {
      if (!activeRelaySessionToken || !data) return;
      const matched =
        data.all === true ||
        (typeof data.tokenPrefix === 'string' && activeRelaySessionToken.startsWith(data.tokenPrefix));
      if (!matched) return;
      activeRelaySessionToken = '';
      if (signalingModeSelect.value === 'remote' && hasActivePeer) {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'session:close', reason: '电脑端已移除当前设备信任凭证' }));
        }
        hasActivePeer = false;
        currentControlEnabled = false;
        activePeerIsOverlay = false;
        if (isHosting) setLivePill('waiting', '待连接');
        updateControlButtonUi();
        cleanupPeerConnection(true);
        window.airdeskAPI.setSessionActive(false).catch(() => {});
      }
    });
  }
  if (trustTtlSelect) {
    trustTtlSelect.value =
      hostSettings.trustTtlOption === '30d' || hostSettings.trustTtlOption === 'never'
        ? hostSettings.trustTtlOption
        : '7d';
    trustTtlSelect.onchange = async () => {
      const res = await window.airdeskAPI.updateHostSettings({ trustTtlOption: trustTtlSelect.value });
      if (res && res.settings) {
        trustTtlSelect.value = res.settings.trustTtlOption;
      }
      const label =
        trustTtlSelect.value === 'never'
          ? '长期有效（直到手动撤销）'
          : trustTtlSelect.value === '30d'
            ? '30 天'
            : '7 天';
      showNotice('已将免密设备有效期设为：' + label + '（新批准或重连时生效）');
    };
  }
  if (enableAutoStartCheckbox) {
    enableAutoStartCheckbox.checked = Boolean(hostSettings.autoStartOnBoot);
    enableAutoStartCheckbox.onchange = async () => {
      const want = Boolean(enableAutoStartCheckbox.checked);
      const res = await window.airdeskAPI.updateHostSettings({ autoStartOnBoot: want });
      if (res && res.loginItemResult && res.loginItemResult.supported === false) {
        enableAutoStartCheckbox.checked = false;
        await window.airdeskAPI.updateHostSettings({ autoStartOnBoot: false });
        showNotice('当前系统平台暂不支持开机自启设置');
        return;
      }
      showNotice(want ? '已开启：开机自动启动 AirDesk Host' : '已关闭开机自动启动');
    };
  }
  if (enableAutoHostOnStartCheckbox) {
    enableAutoHostOnStartCheckbox.checked = Boolean(hostSettings.autoHostOnStartup);
    enableAutoHostOnStartCheckbox.onchange = async () => {
      const want = Boolean(enableAutoHostOnStartCheckbox.checked);
      await window.airdeskAPI.updateHostSettings({ autoHostOnStartup: want });
      showNotice(
        want
          ? '已开启：下次启动时自动恢复上次共享模式并最小化到托盘'
          : '已关闭启动后自动开启共享'
      );
    };
  }
  if (btnSetUnattendedPw && unattendedPwInput) {
    btnSetUnattendedPw.onclick = async () => {
      const pw = unattendedPwInput.value || '';
      const res = await window.airdeskAPI.setUnattendedPassword(pw);
      if (!res || !res.ok) {
        showNotice((res && res.message) || '设置密码失败（至少 6 位）');
        return;
      }
      unattendedPwInput.value = '';
      updateUnattendedPasswordUi(res.status);
      showNotice('已启用/更新无人值守固定访问密码（仅本机 scrypt 加密存储）');
    };
  }
  if (btnClearUnattendedPw) {
    btnClearUnattendedPw.onclick = async () => {
      const res = await window.airdeskAPI.clearUnattendedPassword();
      if (unattendedPwInput) unattendedPwInput.value = '';
      updateUnattendedPasswordUi(res && res.status ? res.status : { enabled: false });
      showNotice('已清除无人值守固定访问密码');
    };
  }
  await refreshTrustedDevicesUi();

  if (window.airdeskAPI.onCursorPos) {
    window.airdeskAPI.onCursorPos((pos) => {
      if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') return;
      const dc = unreliableDc && unreliableDc.readyState === 'open' ? unreliableDc : reliableDc;
      if (dc && dc.readyState === 'open') {
        try {
          dc.send(JSON.stringify({ t: 'cursor:pos', x: pos.x, y: pos.y }));
        } catch {}
      }
    });
  }

  if (framerateSelect) {
    const savedFps = localStorage.getItem(STORAGE_FPS_KEY);
    framerateSelect.value = savedFps === '60' ? '60' : '30';
    framerateSelect.onchange = () => {
      localStorage.setItem(STORAGE_FPS_KEY, framerateSelect.value);
      mediaCapture.clearWarmDisplayTracks();
      const fps = captureMaxFps();
      if (mediaCapture.getLocalStream()) {
        mediaCapture
          .switchActiveDisplay(displaySelect.value, true)
          .then(() => {
            resetAdaptiveBitrate(defaultBitrateKbps());
            return applyVideoParameters(abr.state.currentTargetKbps, fps);
          })
          .catch((err) => showNotice('切换帧率失败：' + err.message));
      }
      showNotice('已切换采集帧率：' + fps + ' fps' + (fps === 60 ? '（核显可能掉帧）' : '（稳帧推荐）'));
    };
  }

  if (hostSettings.autoHostOnStartup) {
    setTimeout(() => {
      startHost().catch(() => {});
    }, 0);
  }
}

document.getElementById('btnAllowFull').onclick = () => approveRequest('full_control');
document.getElementById('btnAllowView').onclick = () => approveRequest('view_only');
document.getElementById('btnReject').onclick = rejectRequest;
btnStart.onclick = startHost;
btnStop.onclick = () => stopHost('已手动停止共享');
btnToggleCtrl.onclick = async () => {
  const next = !currentControlEnabled;
  const res = await window.airdeskAPI.setControlPermission(next);
  currentControlEnabled = Boolean(res.controlEnabled);
  updateControlButtonUi();
  if (signalingModeSelect.value === 'remote' && activeRelaySessionToken && window.airdeskAPI.updateRelayTokenMode) {
    window.airdeskAPI
      .updateRelayTokenMode({
        sessionToken: activeRelaySessionToken,
        mode: currentControlEnabled ? 'full_control' : 'view_only',
      })
      .catch(() => {});
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        type: 'host:update_config',
        activeMode: currentControlEnabled ? 'full_control' : 'view_only',
      })
    );
  }
  if (reliableDc && reliableDc.readyState === 'open') {
    reliableDc.send(
      JSON.stringify({
        t: 'perm',
        controlEnabled: currentControlEnabled,
        reason: currentControlEnabled ? '电脑端已开启远程操控权限' : '电脑端已切换至仅观看（只读）模式',
      })
    );
  }
};

init();
