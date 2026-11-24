// AirDesk Unified Electron Renderer Host
// Consumes hardened window.airdeskAPI via sandboxed contextBridge (electron/preload.cjs).

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

function computeTieredVideoBitrates() {
  const isRelay = Boolean(signalingModeSelect && signalingModeSelect.value === 'remote');
  const isLan =
    Boolean(lanNoStunCheckbox && lanNoStunCheckbox.checked) && !activePeerIsOverlay && !isRelay;
  const fps = captureMaxFps();
  const res = (resolutionSelect && resolutionSelect.value) || '1080p';

  if (isRelay) {
    return { minKbps: 600, startKbps: 2500, maxKbps: fps >= 60 ? 8000 : 6000 };
  }
  if (activePeerIsOverlay) {
    return { minKbps: 800, startKbps: 4000, maxKbps: fps >= 60 ? 14000 : 10000 };
  }
  if (isLan) {
    let maxKbps;
    if (res === 'native') {
      maxKbps = fps >= 60 ? 24000 : 18000;
    } else if (res === '1080p') {
      maxKbps = fps >= 60 ? 22000 : 12000;
    } else if (res === '900p') {
      maxKbps = fps >= 60 ? 18000 : 10000;
    } else {
      maxKbps = fps >= 60 ? 14000 : 8000;
    }
    return { minKbps: 2000, startKbps: fps >= 60 ? 8000 : 6000, maxKbps };
  }
  return { minKbps: 1200, startKbps: 5000, maxKbps: fps >= 60 ? 16000 : 10000 };
}

let ws = null;
let pc = null;
let localStream = null;
let localAudioStream = null;
let localAudioTrack = null;
let activeCaptureDisplayId = '';
const warmDisplayTracks = new Map();
let videoSender = null;
let audioSender = null;
let reliableDc = null;
let unreliableDc = null;
let fileDc = null;
const FILE_CHUNK_BYTES = 16384;
const MAX_FILE_TRANSFER_BYTES = 500 * 1024 * 1024;
const outgoingFileQueue = [];
let outgoingFileBusy = false;
let pendingOutgoingOffer = null;
let pendingOutgoingAck = null;
let activeIncomingFile = null;
let incomingFileWriteChain = Promise.resolve();
const recentFileLogs = [];
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
let autoHintFallbackApplied = false;
let remoteIceServers = [];
let wsHeartbeatTimer = null;
let lastRemoteInputAt = Date.now();
let isIdleThrottled = false;
let activeTargetBitrateKbps = 15000;
let lastSyncedClipboardText = '';
let syncingClipboardPending = false;
let lastPliHandledAt = 0;
let disconnectGraceTimer = null;
let idleCaptureReleaseTimer = null;
let captureInitPromise = null;
let virtualAudioInfo = null;
let hostInSecureDesktop = false;
let hostElevatedConnected = false;
let secureDesktopRecoverTimer = null;
let videoTrackRecoverTimer = null;
let lastTrackRecoveryAt = 0;

function initialTrackContentHint() {
  const pref = (contentHintSelect && contentHintSelect.value) || 'auto';
  return pref === 'motion' ? 'motion' : 'detail';
}

function applyContentHintToActiveTrack() {
  if (!localStream) return;
  const vt = localStream.getVideoTracks()[0];
  if (vt && 'contentHint' in vt) {
    vt.contentHint = initialTrackContentHint();
  }
  autoHintFallbackApplied = false;
}

async function refreshTrustedDevicesUi() {
  if (!trustedDevicesListEl || !window.airdeskAPI.getTrustedDevices) return;
  try {
    const list = await window.airdeskAPI.getTrustedDevices();
    if (!Array.isArray(list) || list.length === 0) {
      trustedDevicesListEl.textContent = '暂无已信任免密设备（首次审批通过后 7 天内免扫码直连）';
      return;
    }
    trustedDevicesListEl.innerHTML = '';
    for (const dev of list) {
      const row = document.createElement('div');
      row.style.cssText =
        'display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 10px;background:#0B0F14;border:1px solid #1E293B;border-radius:8px;margin-top:6px;';
      const infoSpan = document.createElement('span');
      const modeText = dev.mode === 'full_control' ? '允许操控' : '仅观看';
      const seenText = dev.lastSeenAt ? new Date(dev.lastSeenAt).toLocaleString() : '--';
      infoSpan.textContent =
        dev.deviceLabel +
        ' (' +
        dev.platformHint +
        ' · ' +
        dev.ipMasked +
        ') · 权限：' +
        modeText +
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

function showNotice(text, durationMs = 4200) {
  overrideNoticeEl.textContent = text;
  overrideNoticeEl.style.display = 'block';
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    overrideNoticeEl.style.display = 'none';
  }, durationMs);
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

if (btnCopyCode) {
  btnCopyCode.onclick = async () => {
    const code = (pairCodeEl && pairCodeEl.textContent || '').trim();
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


function stopAudioCaptureOnly() {
  if (localAudioStream) {
    localAudioStream.getTracks().forEach((t) => t.stop());
    localAudioStream = null;
  }
  localAudioTrack = null;
}

async function maybeRouteVirtualAudioForStream() {
  if (
    !muteHostVirtualAudioCheckbox ||
    !muteHostVirtualAudioCheckbox.checked ||
    !virtualAudioInfo ||
    !virtualAudioInfo.available ||
    !window.airdeskAPI.setVirtualAudioRoute
  ) {
    return;
  }
  try {
    const res = await window.airdeskAPI.setVirtualAudioRoute({
      enable: true,
      deviceId: virtualAudioInfo.deviceId || '',
    });
    if (res && res.ok && res.switched) {
      await new Promise((r) => setTimeout(r, 150));
      stopAudioCaptureOnly();
    }
  } catch {}
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

async function getOutboundVideoFramesCount() {
  if (!pc) return null;
  try {
    const report = await pc.getStats();
    let count = null;
    report.forEach((stat) => {
      if (stat.type === 'outbound-rtp' && stat.kind === 'video') {
        if (typeof stat.framesEncoded === 'number') count = stat.framesEncoded;
        else if (typeof stat.framesSent === 'number') count = stat.framesSent;
      }
    });
    return count;
  } catch {
    return null;
  }
}

async function recoverVideoCaptureIfNeeded(reason) {
  if (!isHosting || !localStream || hostInSecureDesktop) return;
  if (Date.now() - lastTrackRecoveryAt < 1200) return;

  const vt = localStream.getVideoTracks()[0];
  let needRecapture = !vt || vt.readyState !== 'live' || vt.muted;

  if (!needRecapture && pc && hasActivePeer) {
    const f1 = await getOutboundVideoFramesCount();
    await new Promise((r) => setTimeout(r, 400));
    if (!isHosting || !localStream || hostInSecureDesktop) return;
    const curVt = localStream.getVideoTracks()[0];
    if (!curVt || curVt.readyState !== 'live' || curVt.muted) {
      needRecapture = true;
    } else {
      const f2 = await getOutboundVideoFramesCount();
      if (f1 !== null && f2 !== null && f2 <= f1) {
        needRecapture = true;
      }
    }
  }

  if (!needRecapture) return;
  lastTrackRecoveryAt = Date.now();
  try {
    clearWarmDisplayTracks();
    await switchActiveDisplay(activeCaptureDisplayId || displaySelect.value, true);
    showNotice('已从 UAC / 安全桌面恢复桌面采集 (' + reason + ')');
  } catch (err) {
    console.warn('[AirDesk] Video capture recovery failed:', err && err.message ? err.message : err);
  }
}

async function ensureDesktopAudioTrack() {
  if (localAudioTrack && localAudioTrack.readyState === 'live') {
    return localAudioTrack;
  }
  stopAudioCaptureOnly();
  try {
    const src =
      screenSources.find(
        (s) => s.displayId === (activeCaptureDisplayId || displaySelect.value) || s.id === displaySelect.value
      ) || screenSources[0];
    const videoConstraint = src
      ? {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: src.id,
            maxWidth: 64,
            maxHeight: 64,
            maxFrameRate: 1,
          },
        }
      : {
          mandatory: {
            chromeMediaSource: 'desktop',
            maxWidth: 64,
            maxHeight: 64,
            maxFrameRate: 1,
          },
        };
    const aStream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'desktop' } },
      video: videoConstraint,
    });
    aStream.getVideoTracks().forEach((vt) => {
      vt.stop();
      try {
        aStream.removeTrack(vt);
      } catch {}
    });
    const at = aStream.getAudioTracks()[0] || null;
    if (at) {
      localAudioStream = aStream;
      localAudioTrack = at;
      return at;
    }
    aStream.getTracks().forEach((t) => t.stop());
  } catch (err) {
    showNotice('当前系统暂不支持桌面音频采集，已自动降级为纯画面：' + err.message);
  }
  return null;
}

function clearWarmDisplayTracks(exceptDisplayId = '') {
  for (const [id, entry] of Array.from(warmDisplayTracks.entries())) {
    if (exceptDisplayId && id === exceptDisplayId) continue;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.stream) {
      entry.stream.getTracks().forEach((t) => t.stop());
    }
    warmDisplayTracks.delete(id);
  }
}

async function setDesktopAudioEnabled(enabled, fromRemote = false) {
  const next = Boolean(enabled);
  if (enableAudioCheckbox) {
    enableAudioCheckbox.checked = next;
  }
  localStorage.setItem(STORAGE_AUDIO_KEY, next ? '1' : '0');
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'host:update_config', audioEnabled: next }));
  }
  if (localStream) {
    try {
      let actualAudio = false;
      if (next) {
        if (hasActivePeer) {
          await maybeRouteVirtualAudioForStream();
        }
        const at = await ensureDesktopAudioTrack();
        actualAudio = Boolean(at);
        if (audioSender && at) {
          await audioSender.replaceTrack(at).catch(() => {});
        }
      } else {
        if (audioSender) {
          await audioSender.replaceTrack(null).catch(() => {});
        }
        stopAudioCaptureOnly();
        if (window.airdeskAPI.setVirtualAudioRoute) {
          window.airdeskAPI.setVirtualAudioRoute({ enable: false }).catch(() => {});
        }
      }
      if (next && !actualAudio) {
        if (window.airdeskAPI.setVirtualAudioRoute) {
          window.airdeskAPI.setVirtualAudioRoute({ enable: false }).catch(() => {});
        }
        if (enableAudioCheckbox) enableAudioCheckbox.checked = false;
        localStorage.setItem(STORAGE_AUDIO_KEY, '0');
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'host:update_config', audioEnabled: false }));
        }
        if (reliableDc && reliableDc.readyState === 'open') {
          reliableDc.send(
            JSON.stringify({
              t: 'audio:error',
              message: '电脑端无法采集系统声音，请确认 Windows 音频输出设备正常',
            })
          );
        }
        showNotice('未能采集到桌面音频，已回退纯画面');
        return;
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'host:update_config', audioEnabled: actualAudio }));
      }
      if (hasActivePeer && (actualAudio || !next)) {
        preservedControlEnabled = currentControlEnabled;
        audioRenegotiatePreserveCtrlUntil = Date.now() + 8000;
      }
      pushUiConfigToClient();
      if (hasActivePeer && actualAudio) {
        showNotice(
          fromRemote
            ? '手机端已远程开启桌面声音同步，正在自动重连传输...'
            : '已开启桌面声音采集：正在通知控制端自动重连同步声音...'
        );
      } else if (hasActivePeer && !actualAudio) {
        showNotice(
          fromRemote
            ? '手机端已远程关闭桌面声音，已切回纯画面模式'
            : '已关闭桌面声音采集：正在通知控制端切回纯画面...'
        );
      }
    } catch (err) {
      showNotice('切换音频采集失败：' + err.message);
    }
  } else {
    if (!next) stopAudioCaptureOnly();
    pushUiConfigToClient();
  }
}

async function init() {
  const info = await window.airdeskAPI.getSystemInfo();
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
  if (btnUsbDirect) {
    btnUsbDirect.onclick = () => runUsbDirectSetup(false);
  }
  if (btnUsbTether) {
    btnUsbTether.onclick = () => runUsbDirectSetup(true);
  }
  if (btnSendFiles && fileSendInput) {
    btnSendFiles.onclick = () => fileSendInput.click();
    fileSendInput.onchange = () => {
      if (fileSendInput.files && fileSendInput.files.length > 0) {
        enqueueFilesForMobile(fileSendInput.files);
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
      updateFileTransferUi(
        '局域网快传接收完成：' + data.finalName + ' (' + formatFileBytes(data.size) + ')',
        1
      );
      appendFileTransferLog('局域网快传收到：' + (data.savedPath || data.finalName));
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
        enqueueFilesForMobile(e.dataTransfer.files);
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
    setDesktopAudioEnabled(Boolean(enableAudioCheckbox.checked), false);
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
          stopAudioCaptureOnly();
          const at = await ensureDesktopAudioTrack();
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
          recoverVideoCaptureIfNeeded('secure_desktop_exit').catch(() => {});
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

  // Render global shortcut status grid
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

  // Handle global shortcuts even while minimized to System Tray
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
        if (localStream) {
          await switchActiveDisplay(nextId);
        }
        showNotice('快捷键切屏：已切换至 ' + next.name);
      }
    } else if (evt.action === 'toggle-control') {
      currentControlEnabled = Boolean(evt.controlEnabled);
      updateControlButtonUi();
      const label = currentControlEnabled ? '允许远程操控' : '仅观看（只读）';
      showNotice('快捷键切权 (Ctrl+Alt+L)：当前已切换为「' + label + '」');
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
    clearWarmDisplayTracks();
    refreshDisplaysUi(nextDisplays).catch(() => {});
    showNotice('检测到显示器热插拔，已刷新屏幕列表');
  });

  signalingModeSelect.onchange = syncSignalingInputState;

  displaySelect.onchange = () => {
    if (localStream) {
      switchActiveDisplay(displaySelect.value).catch((err) => {
        showNotice('切换显示器失败：' + err.message);
      });
    }
  };

  const defaultBitrateKbps = () => computeTieredVideoBitrates().maxKbps;
  const savedRes = localStorage.getItem(STORAGE_RES_KEY);
  if (savedRes === '720p' || savedRes === '900p' || savedRes === '1080p' || savedRes === 'native') {
    resolutionSelect.value = savedRes;
  } else {
    resolutionSelect.value = '1080p';
  }
  resolutionSelect.onchange = () => {
    localStorage.setItem(STORAGE_RES_KEY, resolutionSelect.value);
    clearWarmDisplayTracks();
    if (localStream) {
      switchActiveDisplay(displaySelect.value, true)
        .then(() => applyVideoParameters(defaultBitrateKbps(), captureMaxFps()))
        .catch((err) => {
          showNotice('切换分辨率失败：' + err.message);
        });
    }
  };

  // Restore saved contentHint & virtual network preferences
  if (contentHintSelect) {
    const savedHint = localStorage.getItem(STORAGE_HINT_KEY);
    contentHintSelect.value =
      savedHint === 'detail' || savedHint === 'motion' || savedHint === 'auto' ? savedHint : 'auto';
    contentHintSelect.onchange = () => {
      localStorage.setItem(STORAGE_HINT_KEY, contentHintSelect.value);
      applyContentHintToActiveTrack();
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
        applyVideoParameters(activeTargetBitrateKbps, captureMaxFps()).catch(() => {});
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

  // Restore saved framerate preference, then react to changes.
  if (framerateSelect) {
    const savedFps = localStorage.getItem(STORAGE_FPS_KEY);
    framerateSelect.value = savedFps === '60' ? '60' : '30';
    framerateSelect.onchange = () => {
      localStorage.setItem(STORAGE_FPS_KEY, framerateSelect.value);
      clearWarmDisplayTracks();
      const fps = captureMaxFps();
      // Re-capture so the track itself stops producing surplus frames,
      // then re-apply the encoder cap to match.
      if (localStream) {
        switchActiveDisplay(displaySelect.value, true)
          .then(() => applyVideoParameters(defaultBitrateKbps(), fps))
          .catch((err) => showNotice('切换帧率失败：' + err.message));
      }
      showNotice('已切换采集帧率：' + fps + ' fps' + (fps === 60 ? '（核显可能掉帧）' : '（稳帧推荐）'));
    };
  }
}

async function captureDisplayVideoStream(displayId) {
  const src =
    screenSources.find((s) => s.displayId === displayId || s.id === displayId) || screenSources[0];
  if (!src) throw new Error('未找到可采集的屏幕源');
  const resolvedId = src.displayId || src.id;
  await window.airdeskAPI.setActiveDisplay(resolvedId);
  const mandatory = {
    chromeMediaSource: 'desktop',
    chromeMediaSourceId: src.id,
    maxFrameRate: captureMaxFps(),
  };
  if (resolutionSelect.value === '720p') {
    mandatory.maxWidth = 1280;
    mandatory.maxHeight = 720;
  } else if (resolutionSelect.value === '900p') {
    mandatory.maxWidth = 1600;
    mandatory.maxHeight = 900;
  } else if (resolutionSelect.value === '1080p') {
    mandatory.maxWidth = 1920;
    mandatory.maxHeight = 1080;
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { mandatory },
  });
  const vt = stream.getVideoTracks()[0];
  if (vt && 'contentHint' in vt) {
    // Auto mode starts with 'detail' so Windows MediaFoundation HW encoder engages;
    // startRtcStatsMonitor auto-switches to 'motion' if it detects OpenH264 software fallback.
    vt.contentHint = initialTrackContentHint();
  }
  if (vt) {
    vt.onended = () => {
      if (!isHosting || hostInSecureDesktop || !localStream || localStream.getVideoTracks()[0] !== vt) {
        return;
      }
      if (videoTrackRecoverTimer) clearTimeout(videoTrackRecoverTimer);
      videoTrackRecoverTimer = setTimeout(() => {
        videoTrackRecoverTimer = null;
        recoverVideoCaptureIfNeeded('track_ended').catch(() => {});
      }, 300);
    };
    vt.onmute = () => {
      if (!isHosting || hostInSecureDesktop || !localStream || localStream.getVideoTracks()[0] !== vt) {
        return;
      }
      if (videoTrackRecoverTimer) clearTimeout(videoTrackRecoverTimer);
      videoTrackRecoverTimer = setTimeout(() => {
        videoTrackRecoverTimer = null;
        if (!isHosting || hostInSecureDesktop || !localStream || localStream.getVideoTracks()[0] !== vt) {
          return;
        }
        if (vt.muted || vt.readyState !== 'live') {
          recoverVideoCaptureIfNeeded('track_muted').catch(() => {});
        }
      }, 600);
    };
  }
  autoHintFallbackApplied = false;
  return { stream, resolvedId };
}

async function captureDisplayById(displayId) {
  const { stream, resolvedId } = await captureDisplayVideoStream(displayId);
  activeCaptureDisplayId = resolvedId;
  if (enableAudioCheckbox && enableAudioCheckbox.checked) {
    await ensureDesktopAudioTrack();
  } else {
    stopAudioCaptureOnly();
  }
  return stream;
}

function cancelIdleCaptureRelease() {
  if (idleCaptureReleaseTimer) {
    clearTimeout(idleCaptureReleaseTimer);
    idleCaptureReleaseTimer = null;
  }
}

function releaseLocalCaptureMedia() {
  cancelIdleCaptureRelease();
  clearWarmDisplayTracks();
  stopAudioCaptureOnly();
  activeCaptureDisplayId = '';
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  if (window.airdeskAPI && window.airdeskAPI.setVirtualAudioRoute) {
    window.airdeskAPI.setVirtualAudioRoute({ enable: false }).catch(() => {});
  }
}

function scheduleIdleCaptureRelease(delayMs = 20000) {
  cancelIdleCaptureRelease();
  if (!localStream && !localAudioStream && !localAudioTrack) return;
  idleCaptureReleaseTimer = setTimeout(() => {
    idleCaptureReleaseTimer = null;
    if (hasActivePeer || pc || captureInitPromise) return;
    releaseLocalCaptureMedia();
    if (isHosting && statusEl) {
      statusEl.textContent = '已空闲 20 秒，自动释放桌面采集与显存（下次连接自动秒开）';
    }
  }, delayMs);
}

async function ensureLocalCaptureReady() {
  cancelIdleCaptureRelease();
  const existingTrack = localStream ? localStream.getVideoTracks()[0] : null;
  if (existingTrack && existingTrack.readyState === 'live') {
    return localStream;
  }
  if (captureInitPromise) {
    return captureInitPromise;
  }
  const targetDisplayId = activeCaptureDisplayId || displaySelect.value;
  const run = (async () => {
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    const stream = await captureDisplayById(targetDisplayId);
    if (!isHosting) {
      stream.getTracks().forEach((t) => t.stop());
      stopAudioCaptureOnly();
      throw new Error('共享已停止');
    }
    localStream = stream;
    return stream;
  })();
  captureInitPromise = run;
  try {
    return await run;
  } finally {
    if (captureInitPromise === run) {
      captureInitPromise = null;
    }
  }
}

async function applyVideoParameters(maxBitrateKbps, maxFramerate) {
  activeTargetBitrateKbps = Math.max(1000, Number(maxBitrateKbps) || 15000);
  if (!videoSender) return;
  const effectiveFps = Math.min(maxFramerate, captureMaxFps());
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
  } catch {
    // Ignore transient setParameters error
  }
  try {
    if (videoSender.track && videoSender.track.applyConstraints) {
      await videoSender.track.applyConstraints({ frameRate: { max: effectiveFps } });
    }
  } catch {
    // Ignore track constraint rejection on platforms that lock desktop capture fps
  }
}

let switchingDisplayChain = Promise.resolve();

async function switchActiveDisplay(displayId, forceRecapture = false) {
  const run = async () => {
    const prevStream = localStream;
    const prevTrack = prevStream ? prevStream.getVideoTracks()[0] : null;
    const prevId = activeCaptureDisplayId || displaySelect.value;

    let nextStream = null;
    let resolvedId = displayId;

    if (!forceRecapture && warmDisplayTracks.has(displayId)) {
      const cached = warmDisplayTracks.get(displayId);
      warmDisplayTracks.delete(displayId);
      if (cached && cached.timer) clearTimeout(cached.timer);
      if (cached && cached.track && cached.track.readyState === 'live') {
        cached.track.enabled = true;
        nextStream = cached.stream;
        await window.airdeskAPI.setActiveDisplay(displayId);
      } else if (cached && cached.stream) {
        cached.stream.getTracks().forEach((t) => t.stop());
      }
    }

    if (!nextStream) {
      const cap = await captureDisplayVideoStream(displayId);
      nextStream = cap.stream;
      resolvedId = cap.resolvedId;
    }

    const nextTrack = nextStream.getVideoTracks()[0];
    if (nextTrack) {
      nextTrack.enabled = true;
      if ('contentHint' in nextTrack) {
        nextTrack.contentHint = initialTrackContentHint();
      }
    }
    autoHintFallbackApplied = false;
    if (videoSender && nextTrack) {
      await videoSender.replaceTrack(nextTrack);
    }

    localStream = nextStream;
    activeCaptureDisplayId = resolvedId;
    displaySelect.value = resolvedId;
    statusEl.textContent = '已切换至显示器 ' + resolvedId;
    pushDisplaysListToClient();

    if (prevStream && prevStream !== nextStream) {
      if (!forceRecapture && prevId && prevId !== resolvedId && prevTrack && prevTrack.readyState === 'live') {
        const old = warmDisplayTracks.get(prevId);
        if (old) {
          warmDisplayTracks.delete(prevId);
          if (old.timer) clearTimeout(old.timer);
          if (old.stream) old.stream.getTracks().forEach((t) => t.stop());
        }
        while (warmDisplayTracks.size >= 1) {
          const oldestKey = warmDisplayTracks.keys().next().value;
          const oldest = warmDisplayTracks.get(oldestKey);
          warmDisplayTracks.delete(oldestKey);
          if (oldest && oldest.timer) clearTimeout(oldest.timer);
          if (oldest && oldest.stream) oldest.stream.getTracks().forEach((t) => t.stop());
        }
        prevTrack.enabled = false;
        const timer = setTimeout(() => {
          const entry = warmDisplayTracks.get(prevId);
          if (entry && entry.stream === prevStream) {
            warmDisplayTracks.delete(prevId);
            prevStream.getTracks().forEach((t) => t.stop());
          }
        }, 15000);
        warmDisplayTracks.set(prevId, { stream: prevStream, track: prevTrack, timer });
      } else {
        prevStream.getTracks().forEach((t) => t.stop());
      }
    }

    if (videoSender) {
      await applyVideoParameters(activeTargetBitrateKbps, captureMaxFps());
    }
  };
  switchingDisplayChain = switchingDisplayChain.then(run, run);
  return switchingDisplayChain;
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

      // Report the codec actually on the wire, not what the SDP claims.
      // v0.5.0 shipped an SDP listing only H264 while still encoding VP8.
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
          // Adaptive contentHint fallback: keep 'detail' for HW encoders (AMD/NV/Intel),
          // switch to 'motion' automatically when Chromium falls back to OpenH264 SW encode.
          if (
            contentHintSelect &&
            contentHintSelect.value === 'auto' &&
            !autoHintFallbackApplied &&
            typeof outboundStat.framesEncoded === 'number' &&
            outboundStat.framesEncoded >= 15 &&
            outboundStat.powerEfficientEncoder === false &&
            localStream
          ) {
            const activeVt = localStream.getVideoTracks()[0];
            if (activeVt && 'contentHint' in activeVt && activeVt.contentHint !== 'motion') {
              activeVt.contentHint = 'motion';
              autoHintFallbackApplied = true;
              showNotice('检测到当前编码器回退为软编 (' + (encoderImpl || 'OpenH264') + ')，已自动切换低延迟 motion');
            }
          }
        }
        if (outboundStat.qualityLimitationReason) {
          limitReason = String(outboundStat.qualityLimitationReason);
        }
        if (
          prevOutboundSnap &&
          typeof outboundStat.framesEncoded === 'number' &&
          typeof outboundStat.totalEncodeTime === 'number'
        ) {
          const dF = outboundStat.framesEncoded - prevOutboundSnap.framesEncoded;
          const dT = outboundStat.totalEncodeTime - prevOutboundSnap.totalEncodeTime;
          const dt = (outboundStat.timestamp - prevOutboundSnap.ts) / 1000;
          if (fps === null && dt > 0 && dF >= 0) {
            fps = Math.round(dF / dt);
          }
          if (dF > 0 && dT >= 0) {
            encodeMs = +(dT / dF * 1000).toFixed(1);
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
        if (typeof outboundStat.framesEncoded === 'number') {
          prevOutboundSnap = {
            ts: outboundStat.timestamp,
            framesEncoded: outboundStat.framesEncoded,
            totalEncodeTime: outboundStat.totalEncodeTime || 0,
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
        txMbps !== null ? txMbps.toFixed(1) + 'Mbps' : txKbps !== null ? txKbps + 'kbps' : '--';

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

      rtcStatsEl.style.color = color;
      rtcStatsEl.textContent = line1 + '\n' + line2;

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
            w: frameW,
            h: frameH,
            limit: limitReason,
            rttMs,
            contentHint: (activeVt && activeVt.contentHint) || '',
          })
        );
      }

      // Idle dynamic FPS throttling (12s no remote input -> 8fps)
      if (
        enableIdleFpsSaverCheckbox &&
        enableIdleFpsSaverCheckbox.checked &&
        hasActivePeer &&
        videoSender &&
        !isIdleThrottled &&
        Date.now() - lastRemoteInputAt > 12000
      ) {
        isIdleThrottled = true;
        applyVideoParameters(activeTargetBitrateKbps, 8).catch(() => {});
      }

      // Auto-sync desktop clipboard changes to mobile when control is enabled
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

function formatFileBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(2) + ' MB';
}

function updateFileTransferUi(statusText, ratio) {
  if (fileTransferStatusEl && typeof statusText === 'string') {
    fileTransferStatusEl.textContent = statusText;
  }
  if (fileProgressWrapEl && fileProgressBarEl) {
    if (typeof ratio === 'number' && Number.isFinite(ratio) && ratio >= 0) {
      fileProgressWrapEl.style.display = 'block';
      fileProgressBarEl.style.width = Math.max(0, Math.min(100, Math.round(ratio * 100))) + '%';
    } else {
      fileProgressWrapEl.style.display = 'none';
      fileProgressBarEl.style.width = '0%';
    }
  }
}

function appendFileTransferLog(line) {
  if (!line) return;
  recentFileLogs.unshift('[' + new Date().toLocaleTimeString() + '] ' + line);
  if (recentFileLogs.length > 5) recentFileLogs.length = 5;
  if (fileTransferLogEl) {
    fileTransferLogEl.textContent = recentFileLogs.join('\n');
  }
}

function rejectPendingOutgoingFileWaiters(reason) {
  if (pendingOutgoingOffer) {
    const p = pendingOutgoingOffer;
    pendingOutgoingOffer = null;
    p.reject(new Error(reason));
  }
  if (pendingOutgoingAck) {
    const p = pendingOutgoingAck;
    pendingOutgoingAck = null;
    p.reject(new Error(reason));
  }
}

function waitForFileOfferResponse(id, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pendingOutgoingOffer && pendingOutgoingOffer.id === id) {
        pendingOutgoingOffer = null;
        reject(new Error('手机端响应接收请求超时'));
      }
    }, timeoutMs);
    pendingOutgoingOffer = {
      id,
      resolve: (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    };
  });
}

function waitForFileAck(id, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pendingOutgoingAck && pendingOutgoingAck.id === id) {
        pendingOutgoingAck = null;
        reject(new Error('等待手机落盘确认超时'));
      }
    }, timeoutMs);
    pendingOutgoingAck = {
      id,
      resolve: (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    };
  });
}

async function waitFileChannelDrain(dc) {
  if (!dc || dc.readyState !== 'open' || dc.bufferedAmount <= 1048576) return;
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      dc.onbufferedamountlow = null;
      clearInterval(poll);
      resolve();
    };
    dc.onbufferedamountlow = () => {
      if (dc.bufferedAmount <= 524288) finish();
    };
    const poll = setInterval(() => {
      if (!dc || dc.readyState !== 'open' || dc.bufferedAmount <= 524288) {
        finish();
      }
    }, 30);
  });
}

function enqueueFilesForMobile(fileList) {
  if (!fileDc || fileDc.readyState !== 'open') {
    showNotice('请先连接支持文件传输的手机客户端 (AirDesk v0.7.0+)');
    return;
  }
  for (const f of Array.from(fileList)) {
    if (!f) continue;
    if (f.size > MAX_FILE_TRANSFER_BYTES) {
      showNotice('文件过大（超过 500MB 上限）：' + f.name);
      continue;
    }
    outgoingFileQueue.push(f);
  }
  processOutgoingFileQueue().catch(() => {});
}

async function processOutgoingFileQueue() {
  if (outgoingFileBusy) return;
  outgoingFileBusy = true;
  try {
    while (outgoingFileQueue.length > 0) {
      const file = outgoingFileQueue.shift();
      if (!file || !fileDc || fileDc.readyState !== 'open') break;
      const transferId = 'tx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      try {
        updateFileTransferUi('正在请求手机接收：' + file.name + ' (' + formatFileBytes(file.size) + ')', 0);
        fileDc.send(
          JSON.stringify({
            t: 'file:offer',
            id: transferId,
            name: file.name,
            size: file.size,
            mime: file.type || 'application/octet-stream',
          })
        );
        await waitForFileOfferResponse(transferId);

        let offset = 0;
        let lastUiAt = 0;
        while (offset < file.size) {
          if (!fileDc || fileDc.readyState !== 'open') {
            throw new Error('file-transfer 通道已断开');
          }
          await waitFileChannelDrain(fileDc);
          const end = Math.min(file.size, offset + FILE_CHUNK_BYTES);
          const buf = await file.slice(offset, end).arrayBuffer();
          fileDc.send(buf);
          offset = end;
          const nowTs = Date.now();
          if (nowTs - lastUiAt >= 80 || offset >= file.size) {
            lastUiAt = nowTs;
            updateFileTransferUi(
              '正在发送至手机：' + file.name + ' (' + formatFileBytes(offset) + ' / ' + formatFileBytes(file.size) + ')',
              file.size > 0 ? offset / file.size : 1
            );
          }
        }

        fileDc.send(JSON.stringify({ t: 'file:done', id: transferId, bytes: file.size }));
        const ack = await waitForFileAck(transferId);
        const savedLabel = (ack && (ack.savedPath || ack.savedName)) || file.name;
        updateFileTransferUi('发送完成：' + file.name, 1);
        appendFileTransferLog('已发送到手机：' + file.name + ' -> ' + savedLabel);
        showNotice('文件已发送到手机：' + file.name);
      } catch (err) {
        if (fileDc && fileDc.readyState === 'open') {
          try {
            fileDc.send(JSON.stringify({ t: 'file:cancel', id: transferId, reason: err.message }));
          } catch {}
        }
        updateFileTransferUi('发送失败：' + file.name + ' (' + err.message + ')', -1);
        appendFileTransferLog('发送失败：' + file.name + ' (' + err.message + ')');
        showNotice('发送失败：' + err.message);
      }
    }
  } finally {
    outgoingFileBusy = false;
  }
}

function attachFileTransferChannel(dc) {
  fileDc = dc;
  dc.binaryType = 'arraybuffer';
  try {
    dc.bufferedAmountLowThreshold = 262144;
  } catch {}

  dc.onopen = () => {
    updateFileTransferUi('文件传输通道已就绪（支持双向 16KB 分片传输，最大 500MB）', -1);
  };

  dc.onclose = () => {
    rejectPendingOutgoingFileWaiters('文件通道已关闭');
    outgoingFileQueue.length = 0;
    const stale = activeIncomingFile;
    activeIncomingFile = null;
    if (stale) {
      incomingFileWriteChain = incomingFileWriteChain
        .then(() => window.airdeskAPI.fileRecvEnd(stale.id, false))
        .catch(() => {});
    }
    updateFileTransferUi('文件传输通道已断开', -1);
  };

  dc.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const t = msg && msg.t;
      if (t === 'file:accept') {
        if (pendingOutgoingOffer && pendingOutgoingOffer.id === msg.id) {
          const p = pendingOutgoingOffer;
          pendingOutgoingOffer = null;
          p.resolve(msg);
        }
      } else if (t === 'file:reject') {
        if (pendingOutgoingOffer && pendingOutgoingOffer.id === msg.id) {
          const p = pendingOutgoingOffer;
          pendingOutgoingOffer = null;
          p.reject(new Error(msg.reason || '对方拒绝接收文件'));
        }
      } else if (t === 'file:ack') {
        if (pendingOutgoingAck && pendingOutgoingAck.id === msg.id) {
          const p = pendingOutgoingAck;
          pendingOutgoingAck = null;
          if (msg.ok === false) p.reject(new Error(msg.message || '对方保存文件失败'));
          else p.resolve(msg);
        }
      } else if (t === 'file:offer') {
        incomingFileWriteChain = incomingFileWriteChain.then(async () => {
          if (activeIncomingFile) {
            if (dc.readyState === 'open') {
              dc.send(JSON.stringify({ t: 'file:reject', id: msg.id, reason: '电脑端正在接收另一文件' }));
            }
            return;
          }
          const res = await window.airdeskAPI.fileRecvBegin({
            id: msg.id,
            name: msg.name,
            size: msg.size,
            mime: msg.mime,
          });
          if (!res || !res.ok) {
            if (dc.readyState === 'open') {
              dc.send(
                JSON.stringify({
                  t: 'file:reject',
                  id: msg.id,
                  reason: (res && res.reason) || '电脑端拒绝接收',
                })
              );
            }
            showNotice((res && res.reason) || '拒绝接收手机文件');
            return;
          }
          activeIncomingFile = {
            id: msg.id,
            name: res.finalName || msg.name || 'file',
            expectedSize: Number(msg.size) || 0,
            receivedBytes: 0,
            lastUiAt: 0,
          };
          updateFileTransferUi(
            '正在接收手机文件：' + activeIncomingFile.name + ' (0 / ' + formatFileBytes(activeIncomingFile.expectedSize) + ')',
            0
          );
          if (dc.readyState === 'open') {
            dc.send(JSON.stringify({ t: 'file:accept', id: msg.id }));
          }
        }).catch((err) => {
          console.error('[AirDesk FileRecv] file:offer error:', err);
        });
      } else if (t === 'file:done') {
        incomingFileWriteChain = incomingFileWriteChain.then(async () => {
          const cur = activeIncomingFile;
          if (!cur || cur.id !== msg.id) return;
          activeIncomingFile = null;
          const res = await window.airdeskAPI.fileRecvEnd(cur.id, true);
          if (res && res.ok) {
            updateFileTransferUi('接收完成：' + (res.finalName || cur.name), 1);
            appendFileTransferLog('收到手机文件：' + (res.savedPath || res.finalName));
            showNotice('已接收手机文件：' + (res.finalName || cur.name));
            if (dc.readyState === 'open') {
              dc.send(
                JSON.stringify({
                  t: 'file:ack',
                  id: cur.id,
                  ok: true,
                  savedName: res.finalName,
                  savedPath: res.savedPath,
                })
              );
            }
          } else {
            updateFileTransferUi('保存失败：' + ((res && res.reason) || '写入错误'), -1);
            if (dc.readyState === 'open') {
              dc.send(
                JSON.stringify({
                  t: 'file:ack',
                  id: cur.id,
                  ok: false,
                  message: (res && res.reason) || '写入失败',
                })
              );
            }
          }
        }).catch((err) => {
          console.error('[AirDesk FileRecv] file:done error:', err);
        });
      } else if (t === 'file:cancel') {
        incomingFileWriteChain = incomingFileWriteChain.then(async () => {
          const cur = activeIncomingFile;
          if (cur && (!msg.id || cur.id === msg.id)) {
            activeIncomingFile = null;
            await window.airdeskAPI.fileRecvEnd(cur.id, false);
            updateFileTransferUi('对方取消了文件传输：' + cur.name, -1);
          }
        }).catch((err) => {
          console.error('[AirDesk FileRecv] file:cancel error:', err);
        });
      }
      return;
    }

    const rawChunk = ev.data;
    incomingFileWriteChain = incomingFileWriteChain.then(async () => {
      const cur = activeIncomingFile;
      if (!cur) return;
      let u8 = null;
      if (rawChunk instanceof ArrayBuffer) {
        u8 = new Uint8Array(rawChunk);
      } else if (rawChunk && typeof rawChunk.arrayBuffer === 'function') {
        u8 = new Uint8Array(await rawChunk.arrayBuffer());
      } else if (ArrayBuffer.isView(rawChunk)) {
        u8 = new Uint8Array(rawChunk.buffer, rawChunk.byteOffset, rawChunk.byteLength);
      }
      if (!u8) return;
      const res = await window.airdeskAPI.fileRecvChunk(cur.id, u8);
      if (!res || !res.ok) {
        activeIncomingFile = null;
        await window.airdeskAPI.fileRecvEnd(cur.id, false);
        updateFileTransferUi('接收失败：' + ((res && res.reason) || '分片写入失败'), -1);
        if (dc.readyState === 'open') {
          dc.send(JSON.stringify({ t: 'file:cancel', id: cur.id, reason: (res && res.reason) || 'write_error' }));
        }
        return;
      }
      cur.receivedBytes = res.receivedBytes;
      const nowTs = Date.now();
      if (nowTs - cur.lastUiAt >= 80 || cur.receivedBytes >= cur.expectedSize) {
        cur.lastUiAt = nowTs;
        updateFileTransferUi(
          '正在接收手机文件：' + cur.name + ' (' + formatFileBytes(cur.receivedBytes) + ' / ' + formatFileBytes(cur.expectedSize) + ')',
          cur.expectedSize > 0 ? cur.receivedBytes / cur.expectedSize : 1
        );
      }
    }).catch((err) => {
      console.error('[AirDesk FileRecv] chunk write error:', err);
    });
  };
}

function cleanupPeerConnection(scheduleIdleRelease = true) {
  if (disconnectGraceTimer) {
    clearTimeout(disconnectGraceTimer);
    disconnectGraceTimer = null;
  }
  clearWarmDisplayTracks();
  if (statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
  }
  prevOutboundSnap = null;
  lastClientDiag = null;
  isIdleThrottled = false;
  lastRemoteInputAt = Date.now();
  lastSyncedClipboardText = '';
  syncingClipboardPending = false;
  rejectPendingOutgoingFileWaiters('连接已关闭');
  outgoingFileQueue.length = 0;
  outgoingFileBusy = false;
  const staleIncoming = activeIncomingFile;
  activeIncomingFile = null;
  if (staleIncoming && window.airdeskAPI.fileRecvEnd) {
    incomingFileWriteChain = incomingFileWriteChain
      .then(() => window.airdeskAPI.fileRecvEnd(staleIncoming.id, false))
      .catch(() => {});
  }
  updateFileTransferUi('等待建立 WebRTC 连接后可互传文件（单文件上限 500MB）', -1);
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
  if (fileDc) {
    fileDc.close();
    fileDc = null;
  }
  if (pc) {
    pc.onicecandidate = null;
    pc.onconnectionstatechange = null;
    pc.ondatachannel = null;
    pc.close();
    pc = null;
  }
  videoSender = null;
  audioSender = null;
  updateControlButtonUi();
  if (scheduleIdleRelease) {
    scheduleIdleCaptureRelease(20000);
  } else {
    cancelIdleCaptureRelease();
  }
}

async function stopHost(reason) {
  isHosting = false;
  hasPendingApproval = false;
  hasActivePeer = false;
  activePeerIsOverlay = false;
  currentControlEnabled = false;
  remoteIceServers = [];
  cancelIdleCaptureRelease();
  if (secureDesktopRecoverTimer) {
    clearTimeout(secureDesktopRecoverTimer);
    secureDesktopRecoverTimer = null;
  }
  if (videoTrackRecoverTimer) {
    clearTimeout(videoTrackRecoverTimer);
    videoTrackRecoverTimer = null;
  }
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
  releaseLocalCaptureMedia();
  approvalCard.style.display = 'none';
  pairCodeEl.textContent = '------';
  await renderPairQr('');
  setLivePill('', '未启动');
  btnStart.disabled = false;
  btnStop.disabled = true;
  updateControlButtonUi();
  statusEl.textContent = reason || '已停止并释放屏幕采集';
}

function parseIceServerInput(raw) {
  const tokens = String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const token of tokens) {
    const schemeMatch = token.match(/^(turns?):(.*)$/i);
    if (schemeMatch) {
      const rest = schemeMatch[2];
      const atIdx = rest.lastIndexOf('@');
      if (atIdx > 0) {
        const creds = rest.slice(0, atIdx);
        const colonIdx = creds.indexOf(':');
        if (colonIdx > 0) {
          out.push({
            urls: schemeMatch[1].toLowerCase() + ':' + rest.slice(atIdx + 1),
            username: decodeURIComponent(creds.slice(0, colonIdx)),
            credential: decodeURIComponent(creds.slice(colonIdx + 1)),
          });
          continue;
        }
      }
    }
    out.push({ urls: token });
  }
  return out;
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
  remoteIceServers = [];
  if (wsHeartbeatTimer) {
    clearInterval(wsHeartbeatTimer);
    wsHeartbeatTimer = null;
  }
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
    ws = new WebSocket(wsUrl);
  } catch (err) {
    releaseLocalCaptureMedia();
    isHosting = false;
    btnStart.disabled = false;
    btnStop.disabled = true;
    updateControlButtonUi();
    showNotice('信令地址格式无效（需以 http://、https://、ws:// 或 wss:// 开头）：' + err.message);
    return;
  }

  isHosting = true;
  setLivePill('waiting', '待连接');
  btnStart.disabled = true;
  btnStop.disabled = false;
  updateControlButtonUi();
  statusEl.textContent = '正在连接信令服务器...';

  ws.onopen = () => {
    const createPayload = {
      type: 'host:create',
      hostLabel: 'AirDesk Electron Desktop',
      audioEnabled: Boolean(enableAudioCheckbox && enableAudioCheckbox.checked),
    };
    if (signalingModeSelect.value === 'local' && localSignalingInfo && localSignalingInfo.localHostToken) {
      createPayload.localHostToken = localSignalingInfo.localHostToken;
    }
    const rk = relayAccessKeyInput ? relayAccessKeyInput.value.trim() : '';
    if (rk) createPayload.accessKey = rk;
    ws.send(JSON.stringify(createPayload));
    if (signalingModeSelect.value === 'remote') {
      wsHeartbeatTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ws:ping', ts: Date.now() }));
        }
      }, 25000);
    }
  };

  ws.onerror = () => {
    showNotice('信令连接出现异常，请检查服务器地址或网络连通性');
  };

  ws.onclose = () => {
    if (wsHeartbeatTimer) {
      clearInterval(wsHeartbeatTimer);
      wsHeartbeatTimer = null;
    }
    if (isHosting) {
      stopHost('信令连接已断开，已自动释放采集并切回只读');
    }
  };

  ws.onmessage = async (ev) => {
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
      pairCodeEl.textContent = msg.code;
      await renderPairQr(msg.code);
      const hasTurn = remoteIceServers.some((s) => {
        const u = Array.isArray(s.urls) ? s.urls.join(',') : String(s.urls || '');
        return /^turns?:/i.test(u);
      });
      statusEl.textContent =
        signalingModeSelect.value === 'local'
          ? '内置本地信令已就绪：手机连接同一热点/Wi-Fi 扫码即可 0 流量直连'
          : (hasTurn
              ? '公网信令已就绪（已配 TURN 中继兜底）：等待手机输入 6 位配对码...'
              : '公网信令已就绪（STUN P2P 穿透）：等待手机输入 6 位配对码...');
    } else if (msg.type === 'host:approval_request') {
      hasPendingApproval = true;
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
      await handleOffer(msg.sdp);
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
      approvalCard.style.display = 'none';
      showNotice(msg.reason || '连接请求已取消');
    } else if (msg.type === 'host:client_disconnected') {
      statusEl.textContent = '客户端已断开：' + msg.reason;
      currentControlEnabled = false;
      activePeerIsOverlay = false;
      if (isHosting) setLivePill('waiting', '待连接');
      cleanupPeerConnection();
      await window.airdeskAPI.setSessionActive(false);
    }
  };
}

function boostVideoSdpBitrate(sdp, minKbps = 1500, startKbps = 6000, maxKbps = 15000) {
  if (!sdp || typeof sdp !== 'string') return sdp;
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(/\r?\n/);

  let inVideo = false;
  let mLinePts = [];
  const skipPts = new Set();
  const existingFmtpPts = new Set();

  for (const line of lines) {
    if (line.startsWith('m=')) {
      inVideo = line.startsWith('m=video ');
      if (inVideo) {
        mLinePts = line.trim().split(/\s+/).slice(3);
      }
      continue;
    }
    if (!inVideo) continue;
    const rtpmapMatch = line.match(/^a=rtpmap:(\d+)\s+([^/\s]+)/i);
    if (rtpmapMatch) {
      const pt = rtpmapMatch[1];
      const codec = rtpmapMatch[2].toLowerCase();
      if (codec === 'rtx' || codec === 'red' || codec === 'ulpfec' || codec === 'flexfec-03') {
        skipPts.add(pt);
      }
      continue;
    }
    const fmtpMatch = line.match(/^a=fmtp:(\d+)\s+/i);
    if (fmtpMatch) {
      existingFmtpPts.add(fmtpMatch[1]);
    }
  }

  const targetPts = new Set(mLinePts.filter((pt) => !skipPts.has(pt)));
  if (targetPts.size === 0) return sdp;

  const bitrateParams =
    'x-google-min-bitrate=' +
    minKbps +
    ';x-google-start-bitrate=' +
    startKbps +
    ';x-google-max-bitrate=' +
    maxKbps;

  inVideo = false;
  let videoBInjected = false;
  const out = [];

  for (const line of lines) {
    if (line.startsWith('m=')) {
      inVideo = line.startsWith('m=video ');
      out.push(line);
      continue;
    }
    if (!inVideo) {
      out.push(line);
      continue;
    }
    if (/^b=(AS|TIAS):/i.test(line)) {
      continue;
    }
    if (line.startsWith('c=IN ')) {
      out.push(line);
      if (!videoBInjected) {
        out.push('b=AS:' + maxKbps);
        videoBInjected = true;
      }
      continue;
    }
    const fmtpMatch = line.match(/^a=fmtp:(\d+)\s+(.*)$/i);
    if (fmtpMatch && targetPts.has(fmtpMatch[1])) {
      const pt = fmtpMatch[1];
      const cleaned = fmtpMatch[2]
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s && !/^x-google-(min|start|max)-bitrate=/i.test(s));
      cleaned.push(bitrateParams);
      out.push('a=fmtp:' + pt + ' ' + cleaned.join(';'));
      continue;
    }
    out.push(line);
    const rtpmapMatch = line.match(/^a=rtpmap:(\d+)\s+/i);
    if (rtpmapMatch && targetPts.has(rtpmapMatch[1]) && !existingFmtpPts.has(rtpmapMatch[1])) {
      out.push('a=fmtp:' + rtpmapMatch[1] + ' ' + bitrateParams);
    }
  }

  if (!videoBInjected) {
    const mIdx = out.findIndex((l) => l.startsWith('m=video '));
    if (mIdx >= 0) {
      out.splice(mIdx + 1, 0, 'b=AS:' + maxKbps);
    }
  }

  return out.join(eol);
}

function enhanceAudioOpusSdp(sdp) {
  if (!sdp || typeof sdp !== 'string') return sdp;
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(/\r?\n/);

  let inAudio = false;
  const opusPts = new Set();
  const existingFmtpPts = new Set();

  for (const line of lines) {
    if (line.startsWith('m=')) {
      inAudio = line.startsWith('m=audio ');
      continue;
    }
    if (!inAudio) continue;
    const rm = line.match(/^a=rtpmap:(\d+)\s+opus\//i);
    if (rm) {
      opusPts.add(rm[1]);
      continue;
    }
    const fm = line.match(/^a=fmtp:(\d+)\s+/i);
    if (fm) {
      existingFmtpPts.add(fm[1]);
    }
  }

  if (opusPts.size === 0) return sdp;

  const stereoParams = 'stereo=1;sprop-stereo=1;maxaveragebitrate=128000';
  inAudio = false;
  const out = [];

  for (const line of lines) {
    if (line.startsWith('m=')) {
      inAudio = line.startsWith('m=audio ');
      out.push(line);
      continue;
    }
    if (!inAudio) {
      out.push(line);
      continue;
    }
    const fm = line.match(/^a=fmtp:(\d+)\s+(.*)$/i);
    if (fm && opusPts.has(fm[1])) {
      const pt = fm[1];
      const cleaned = fm[2]
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s && !/^(stereo|sprop-stereo|maxaveragebitrate)=/i.test(s));
      cleaned.push(stereoParams);
      out.push('a=fmtp:' + pt + ' ' + cleaned.join(';'));
      continue;
    }
    out.push(line);
    const rm = line.match(/^a=rtpmap:(\d+)\s+opus\//i);
    if (rm && opusPts.has(rm[1]) && !existingFmtpPts.has(rm[1])) {
      out.push('a=fmtp:' + rm[1] + ' ' + stereoParams);
    }
  }

  return out.join(eol);
}

function sdpPrefersHevc(sdp) {
  if (!sdp || typeof sdp !== 'string') return false;
  const lines = sdp.split(/\r?\n/);
  let inVideo = false;
  let firstPt = '';
  for (const line of lines) {
    if (line.startsWith('m=')) {
      inVideo = line.startsWith('m=video ');
      if (inVideo) {
        const parts = line.trim().split(/\s+/);
        firstPt = parts[3] || '';
      }
      continue;
    }
    if (!inVideo || !firstPt) continue;
    const m = line.match(new RegExp('^a=rtpmap:' + firstPt + '\\s+([^/\\s]+)', 'i'));
    if (m) {
      const codec = m[1].toLowerCase();
      return codec === 'h265' || codec === 'hevc';
    }
  }
  return false;
}

const PLAYOUT_DELAY_EXT_URI = 'http://www.webrtc.org/experiments/rtp-hdrext/playout-delay';

function ensurePlayoutDelayExtInSdp(sdp, preferredId = null) {
  if (!sdp || typeof sdp !== 'string') return { sdp, extId: null };
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(/\r?\n/);

  const usedIds = new Set();
  let inVideo = false;
  let videoStartIdx = -1;
  let videoEndIdx = lines.length;
  let lastVideoExtIdx = -1;
  let firstVideoRtpmapIdx = -1;
  let existingExtId = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const em = line.match(/^a=extmap:(\d+)(?:\/[^\s]+)?\s+(\S+)/i);
    if (em) {
      const id = Number(em[1]);
      if (Number.isInteger(id)) usedIds.add(id);
      if (inVideo) {
        lastVideoExtIdx = i;
        if (em[2].toLowerCase() === PLAYOUT_DELAY_EXT_URI) {
          existingExtId = id;
        }
      }
      continue;
    }
    if (line.startsWith('m=')) {
      if (inVideo && videoEndIdx === lines.length) {
        videoEndIdx = i;
      }
      inVideo = line.startsWith('m=video ');
      if (inVideo) videoStartIdx = i;
      continue;
    }
    if (inVideo && firstVideoRtpmapIdx < 0 && line.startsWith('a=rtpmap:')) {
      firstVideoRtpmapIdx = i;
    }
  }

  if (videoStartIdx < 0) return { sdp, extId: null };
  if (existingExtId !== null) return { sdp, extId: existingExtId };

  let chosenId = null;
  if (Number.isInteger(preferredId) && preferredId >= 1 && preferredId <= 14 && !usedIds.has(preferredId)) {
    chosenId = preferredId;
  } else {
    for (let id = 1; id <= 14; id++) {
      if (!usedIds.has(id)) {
        chosenId = id;
        break;
      }
    }
  }
  if (chosenId === null) return { sdp, extId: null };

  const extLine = 'a=extmap:' + chosenId + ' ' + PLAYOUT_DELAY_EXT_URI;
  const insertAt =
    lastVideoExtIdx >= 0
      ? lastVideoExtIdx + 1
      : firstVideoRtpmapIdx >= 0
        ? firstVideoRtpmapIdx
        : videoEndIdx;
  lines.splice(insertAt, 0, extLine);
  return { sdp: lines.join(eol), extId: chosenId };
}

async function handleOffer(remoteSdp) {
  cancelIdleCaptureRelease();
  cleanupPeerConnection(false);

  const currentPc = new RTCPeerConnection({
    iceServers: buildIceServers(),
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
  });
  pc = currentPc;

  try {
    await ensureLocalCaptureReady();
  } catch (err) {
    if (pc === currentPc) {
      cleanupPeerConnection(false);
    }
    showNotice('启动屏幕采集失败：' + (err && err.message ? err.message : err));
    return;
  }
  if (pc !== currentPc || !isHosting || !localStream) {
    return;
  }



  // 过滤代理 TUN (Clash/Mihomo 198.18.0.0/15)；未勾选“允许异地组网”时仅在非异地直连会话下过滤 Tailscale 100.64.0.0/10
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
        statusEl.textContent = 'WebRTC 链路波动 (disconnected)，等待 2.5s 自动恢复...';
        disconnectGraceTimer = setTimeout(() => {
          disconnectGraceTimer = null;
          if (pc === currentPc && currentPc.connectionState !== 'connected') {
            resetOnConnectionLost(currentPc.connectionState).catch(() => {});
          }
        }, 2500);
      }
    } else if (state === 'failed' || state === 'closed') {
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
      attachFileTransferChannel(dc);
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
          applyVideoParameters(activeTargetBitrateKbps, captureMaxFps()).catch(() => {});
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
        await switchActiveDisplay(data.displayId);
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
          applyContentHintToActiveTrack();
        }
        if (needRecapture && localStream) {
          clearWarmDisplayTracks();
          await switchActiveDisplay(displaySelect.value, true);
        }
        const maxPolicyCap = signalingModeSelect && signalingModeSelect.value === 'remote' ? 8000 : 35000;
        const targetBitrate = Math.min(maxPolicyCap, Math.max(1000, Number(data.maxBitrateKbps) || 15000));
        const targetFps = reqFps > 0 ? reqFps : data.preset === 'office_saver' ? 20 : captureMaxFps();
        await applyVideoParameters(targetBitrate, targetFps);
      } else if (data.t === 'diag:rx') {
        lastClientDiag = data;
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
        await setDesktopAudioEnabled(Boolean(data.enabled), true);
      } else if (data.t === 'video:pli') {
        const nowTs = Date.now();
        if (nowTs - lastPliHandledAt >= 250) {
          lastPliHandledAt = nowTs;
          await applyVideoParameters(activeTargetBitrateKbps, captureMaxFps());
        }
      } else {
        await window.airdeskAPI.injectInput(data);
      }
    };
  };

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

  // Attach tracks AFTER setRemoteDescription so Unified Plan reuses the offer's exact video/audio transceivers
  const vTrack = localStream.getVideoTracks()[0];
  if (vTrack && 'contentHint' in vTrack) {
    vTrack.contentHint = initialTrackContentHint();
  }
  videoSender = pc.addTrack(vTrack, localStream);
  if (enableAudioCheckbox && enableAudioCheckbox.checked) {
    await maybeRouteVirtualAudioForStream();
    if (!localAudioTrack || localAudioTrack.readyState !== 'live') {
      await ensureDesktopAudioTrack();
    }
  }
  const aTrack = localAudioTrack || localStream.getAudioTracks()[0];
  audioSender = aTrack ? pc.addTrack(aTrack, localStream) : null;

  const videoTransceiver = pc.getTransceivers().find((t) => t.sender === videoSender);
  if (videoTransceiver && RTCRtpReceiver.getCapabilities) {
    // setCodecPreferences validates against the RECEIVER capability list.
    // Passing RTCRtpSender.getCapabilities() (which lists H264) throws
    // InvalidModificationError: invalid codec with name "H264".
    const recvCaps = RTCRtpReceiver.getCapabilities('video');
    if (recvCaps && recvCaps.codecs) {
      const h264 = recvCaps.codecs
        .filter((c) => c.mimeType.toLowerCase() === 'video/h264')
        .sort((a, b) => {
          const score = (c) => {
            const f = String(c.sdpFmtpLine || '').toLowerCase();
            if (f.includes('640c')) return 0;
            if (f.includes('42e01f')) return 1;
            if (f.includes('42e0')) return 2;
            if (f.includes('42001f')) return 3;
            if (f.includes('4200')) return 4;
            if (f.includes('6400')) return 5;
            return 6;
          };
          return score(a) - score(b);
        });
      const preferHevc = Boolean(codecSelect && codecSelect.value === 'hevc') || sdpPrefersHevc(remoteSdp);
      const hevc = recvCaps.codecs.filter((c) => {
        const mt = c.mimeType.toLowerCase();
        return mt === 'video/hevc' || mt === 'video/h265';
      });
      const preferredCodecs = preferHevc ? [...hevc, ...h264] : [...h264, ...hevc];
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
  ws.send(JSON.stringify({ type: 'rtc:answer', sdp: sentAnswer.sdp }));
  hasActivePeer = true;
  if (Date.now() < audioRenegotiatePreserveCtrlUntil) {
    currentControlEnabled = preservedControlEnabled;
    audioRenegotiatePreserveCtrlUntil = 0;
  }
  await window.airdeskAPI.setSessionActive(true);
  await window.airdeskAPI.setControlPermission(currentControlEnabled);
  updateControlButtonUi();
  await applyVideoParameters(tier.maxKbps, captureMaxFps());
  startRtcStatsMonitor();
  setLivePill('live', '串流中');
  statusEl.textContent = activePeerIsOverlay
    ? 'WebRTC 异地组网串流已建立（支持全局快捷键切屏/切权与系统级操控）'
    : 'WebRTC 串流已建立（支持全局快捷键切屏/切权与系统级操控）';
}

async function approveRequest(mode) {
  hasPendingApproval = false;
  approvalCard.style.display = 'none';
  hasActivePeer = true;
  currentControlEnabled = mode === 'full_control';
  await window.airdeskAPI.setSessionActive(true);
  await window.airdeskAPI.setControlPermission(currentControlEnabled);
  updateControlButtonUi();
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'host:approval_decision', approved: true, mode }));
  }
}

function rejectRequest() {
  hasPendingApproval = false;
  approvalCard.style.display = 'none';
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'host:approval_decision', approved: false }));
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
