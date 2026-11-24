export function createMediaCaptureManager({
  getScreenSources,
  getSelectedDisplayId,
  setSelectedDisplayId,
  getSelectedResolution,
  getCaptureMaxFps,
  getContentHintPref,
  getAudioEnabled,
  setAudioEnabledState,
  getVirtualAudioInfo,
  getMuteHostVirtualAudio,
  getIsHosting,
  getHasActivePeer,
  getHasPc,
  getPcStats,
  getHostInSecureDesktop,
  getVideoSender,
  getAudioSender,
  getReliableDc,
  getWs,
  onAudioRenegotiatePreserveCtrl,
  applyVideoParameters,
  getAbrTargetKbps,
  getAbrFpsCap,
  getIsIdleThrottled,
  pushDisplaysListToClient,
  pushUiConfigToClient,
  showNotice,
  setStatusText,
  airdeskAPI,
}) {
  let localStream = null;
  let localAudioStream = null;
  let localAudioTrack = null;
  let activeCaptureDisplayId = '';
  const warmDisplayTracks = new Map();
  let autoHintFallbackApplied = false;
  let idleCaptureReleaseTimer = null;
  let captureInitPromise = null;
  let hostSessionGen = 0;
  let videoTrackRecoverTimer = null;
  let lastTrackRecoveryAt = 0;
  let switchingDisplayChain = Promise.resolve();

  function initialTrackContentHint() {
    const pref = getContentHintPref() || 'auto';
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

  function stopAudioCaptureOnly() {
    if (localAudioStream) {
      localAudioStream.getTracks().forEach((t) => t.stop());
      localAudioStream = null;
    }
    localAudioTrack = null;
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

  async function maybeRouteVirtualAudioForStream() {
    const virtualAudioInfo = getVirtualAudioInfo();
    if (
      !getMuteHostVirtualAudio() ||
      !virtualAudioInfo ||
      !virtualAudioInfo.available ||
      !airdeskAPI.setVirtualAudioRoute
    ) {
      return;
    }
    try {
      const res = await airdeskAPI.setVirtualAudioRoute({
        enable: true,
        deviceId: virtualAudioInfo.deviceId || '',
      });
      if (res && res.ok && res.switched) {
        await new Promise((r) => setTimeout(r, 150));
        stopAudioCaptureOnly();
      }
    } catch {}
  }

  async function ensureDesktopAudioTrack() {
    if (localAudioTrack && localAudioTrack.readyState === 'live') {
      return localAudioTrack;
    }
    stopAudioCaptureOnly();
    try {
      const screenSources = getScreenSources();
      const selectedId = getSelectedDisplayId();
      const src =
        screenSources.find(
          (s) => s.displayId === (activeCaptureDisplayId || selectedId) || s.id === selectedId
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

  async function getOutboundVideoFramesCount() {
    if (!getHasPc()) return null;
    try {
      const report = await getPcStats();
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

  async function captureDisplayVideoStream(displayId) {
    const screenSources = getScreenSources();
    const src =
      screenSources.find((s) => s.displayId === displayId || s.id === displayId) || screenSources[0];
    if (!src) throw new Error('未找到可采集的屏幕源');
    const resolvedId = src.displayId || src.id;
    await airdeskAPI.setActiveDisplay(resolvedId);
    const mandatory = {
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: src.id,
      maxFrameRate: getCaptureMaxFps(),
    };
    const resPref = getSelectedResolution();
    if (resPref === '720p') {
      mandatory.maxWidth = 1280;
      mandatory.maxHeight = 720;
    } else if (resPref === '900p') {
      mandatory.maxWidth = 1600;
      mandatory.maxHeight = 900;
    } else if (resPref === '1080p') {
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
        if (!getIsHosting() || getHostInSecureDesktop() || !localStream || localStream.getVideoTracks()[0] !== vt) {
          return;
        }
        if (videoTrackRecoverTimer) clearTimeout(videoTrackRecoverTimer);
        videoTrackRecoverTimer = setTimeout(() => {
          videoTrackRecoverTimer = null;
          recoverVideoCaptureIfNeeded('track_ended').catch(() => {});
        }, 300);
      };
      vt.onmute = () => {
        if (!getIsHosting() || getHostInSecureDesktop() || !localStream || localStream.getVideoTracks()[0] !== vt) {
          return;
        }
        if (videoTrackRecoverTimer) clearTimeout(videoTrackRecoverTimer);
        videoTrackRecoverTimer = setTimeout(() => {
          videoTrackRecoverTimer = null;
          if (!getIsHosting() || getHostInSecureDesktop() || !localStream || localStream.getVideoTracks()[0] !== vt) {
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
    if (getAudioEnabled()) {
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
    hostSessionGen++;
    captureInitPromise = null;
    cancelIdleCaptureRelease();
    clearWarmDisplayTracks();
    stopAudioCaptureOnly();
    activeCaptureDisplayId = '';
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    if (airdeskAPI && airdeskAPI.setVirtualAudioRoute) {
      airdeskAPI.setVirtualAudioRoute({ enable: false }).catch(() => {});
    }
  }

  function scheduleIdleCaptureRelease(delayMs = 20000) {
    cancelIdleCaptureRelease();
    if (!localStream && !localAudioStream && !localAudioTrack) return;
    idleCaptureReleaseTimer = setTimeout(() => {
      idleCaptureReleaseTimer = null;
      if (getHasActivePeer() || getHasPc() || captureInitPromise) return;
      releaseLocalCaptureMedia();
      if (getIsHosting()) {
        setStatusText('已空闲 20 秒，自动释放桌面采集与显存（下次连接自动秒开）');
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
    const myGen = hostSessionGen;
    const targetDisplayId = activeCaptureDisplayId || getSelectedDisplayId();
    const run = (async () => {
      if (localStream) {
        localStream.getTracks().forEach((t) => t.stop());
        localStream = null;
      }
      const stream = await captureDisplayById(targetDisplayId);
      if (!getIsHosting() || myGen !== hostSessionGen) {
        stream.getTracks().forEach((t) => t.stop());
        stopAudioCaptureOnly();
        throw new Error('共享已停止或已重新启动');
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

  async function switchActiveDisplay(displayId, forceRecapture = false) {
    const run = async () => {
      const prevStream = localStream;
      const prevTrack = prevStream ? prevStream.getVideoTracks()[0] : null;
      const prevId = activeCaptureDisplayId || getSelectedDisplayId();

      let nextStream = null;
      let resolvedId = displayId;

      if (!forceRecapture && warmDisplayTracks.has(displayId)) {
        const cached = warmDisplayTracks.get(displayId);
        warmDisplayTracks.delete(displayId);
        if (cached && cached.timer) clearTimeout(cached.timer);
        if (cached && cached.track && cached.track.readyState === 'live') {
          cached.track.enabled = true;
          nextStream = cached.stream;
          await airdeskAPI.setActiveDisplay(displayId);
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
      const videoSender = getVideoSender();
      if (videoSender && nextTrack) {
        await videoSender.replaceTrack(nextTrack);
      }

      localStream = nextStream;
      activeCaptureDisplayId = resolvedId;
      setSelectedDisplayId(resolvedId);
      setStatusText('已切换至显示器 ' + resolvedId);
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

      if (getVideoSender()) {
        await applyVideoParameters(
          getAbrTargetKbps(),
          getIsIdleThrottled() ? 8 : getAbrFpsCap() || getCaptureMaxFps()
        );
      }
    };
    switchingDisplayChain = switchingDisplayChain.then(run, run);
    return switchingDisplayChain;
  }

  async function recoverVideoCaptureIfNeeded(reason) {
    if (!getIsHosting() || !localStream || getHostInSecureDesktop()) return;
    if (Date.now() - lastTrackRecoveryAt < 1200) return;

    const vt = localStream.getVideoTracks()[0];
    let needRecapture = !vt || vt.readyState !== 'live' || vt.muted;

    if (!needRecapture && getHasPc() && getHasActivePeer()) {
      const f1 = await getOutboundVideoFramesCount();
      await new Promise((r) => setTimeout(r, 400));
      if (!getIsHosting() || !localStream || getHostInSecureDesktop()) return;
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
      await switchActiveDisplay(activeCaptureDisplayId || getSelectedDisplayId(), true);
      showNotice('已从 UAC / 安全桌面恢复桌面采集 (' + reason + ')');
    } catch (err) {
      console.warn('[AirDesk] Video capture recovery failed:', err && err.message ? err.message : err);
    }
  }

  async function setDesktopAudioEnabled(enabled, fromRemote = false) {
    const next = Boolean(enabled);
    setAudioEnabledState(next);
    const ws = getWs();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'host:update_config', audioEnabled: next }));
    }
    const reliableDc = getReliableDc();
    const audioSender = getAudioSender();
    const hasActivePeer = getHasActivePeer();
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
          if (airdeskAPI.setVirtualAudioRoute) {
            airdeskAPI.setVirtualAudioRoute({ enable: false }).catch(() => {});
          }
        }
        if (next && !actualAudio) {
          if (airdeskAPI.setVirtualAudioRoute) {
            airdeskAPI.setVirtualAudioRoute({ enable: false }).catch(() => {});
          }
          setAudioEnabledState(false);
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
          onAudioRenegotiatePreserveCtrl();
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

  function bumpSessionGen() {
    hostSessionGen++;
    captureInitPromise = null;
  }

  function clearRecoverTimer() {
    if (videoTrackRecoverTimer) {
      clearTimeout(videoTrackRecoverTimer);
      videoTrackRecoverTimer = null;
    }
  }

  return {
    bumpSessionGen,
    getLocalStream: () => localStream,
    getLocalAudioTrack: () => localAudioTrack,
    getActiveCaptureDisplayId: () => activeCaptureDisplayId,
    getAutoHintFallbackApplied: () => autoHintFallbackApplied,
    setAutoHintFallbackApplied: (val) => {
      autoHintFallbackApplied = Boolean(val);
    },
    initialTrackContentHint,
    applyContentHintToActiveTrack,
    stopAudioCaptureOnly,
    clearWarmDisplayTracks,
    maybeRouteVirtualAudioForStream,
    ensureDesktopAudioTrack,
    captureDisplayVideoStream,
    captureDisplayById,
    cancelIdleCaptureRelease,
    releaseLocalCaptureMedia,
    scheduleIdleCaptureRelease,
    ensureLocalCaptureReady,
    switchActiveDisplay,
    recoverVideoCaptureIfNeeded,
    setDesktopAudioEnabled,
    clearRecoverTimer,
  };
}
