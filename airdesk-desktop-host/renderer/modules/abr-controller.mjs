export function computeAbrFloorKbps(isLanLike) {
  return isLanLike ? 2500 : 800;
}

export function createAbrController() {
  const state = {
    baseMaxKbps: 15000,
    minFloorKbps: 2500,
    currentTargetKbps: 15000,
    adaptiveFpsCap: null,
    congestedStreak: 0,
    healthyStreak: 0,
    lastAdjustAtMs: 0,
    state: 'normal',
  };

  let prevAbrClientDropped = null;
  let prevAbrClientFreezes = null;

  function reset({ baseMaxOverride = null, defaultMaxKbps = 15000, isLanLike = false } = {}) {
    const baseMax = Math.max(500, Number(baseMaxOverride) || Number(defaultMaxKbps) || 15000);
    const floor = Math.min(baseMax, computeAbrFloorKbps(isLanLike));
    state.baseMaxKbps = baseMax;
    state.minFloorKbps = floor;
    state.currentTargetKbps = baseMax;
    state.adaptiveFpsCap = null;
    state.congestedStreak = 0;
    state.healthyStreak = 0;
    state.lastAdjustAtMs = 0;
    state.state = 'normal';
    prevAbrClientDropped = null;
    prevAbrClientFreezes = null;
  }

  function evaluate({
    hasActivePeer,
    hasPc,
    hasVideoSender,
    isIdleThrottled,
    hostInSecureDesktop,
    isLanLike,
    captureMaxFps,
    limitReason,
    encodeMs,
    rttMs,
    lastClientDiag,
    lastClientDiagAt,
    nowMs = Date.now(),
  }) {
    if (!hasActivePeer || !hasPc || !hasVideoSender || isIdleThrottled || hostInSecureDesktop) {
      return null;
    }

    const freshClient = Boolean(lastClientDiag && nowMs - lastClientDiagAt < 5000);
    const clientJbMs =
      freshClient && typeof lastClientDiag.jbMs === 'number' ? lastClientDiag.jbMs : null;

    let deltaDropped = 0;
    let deltaFreezes = 0;
    if (freshClient) {
      if (typeof lastClientDiag.dropped === 'number') {
        if (prevAbrClientDropped !== null && lastClientDiag.dropped >= prevAbrClientDropped) {
          deltaDropped = lastClientDiag.dropped - prevAbrClientDropped;
        }
        prevAbrClientDropped = lastClientDiag.dropped;
      }
      if (typeof lastClientDiag.freezes === 'number') {
        if (prevAbrClientFreezes !== null && lastClientDiag.freezes >= prevAbrClientFreezes) {
          deltaFreezes = lastClientDiag.freezes - prevAbrClientFreezes;
        }
        prevAbrClientFreezes = lastClientDiag.freezes;
      }
    }

    const rttLimit = isLanLike ? 60 : 180;
    const rttCongested =
      rttMs !== null &&
      rttMs > rttLimit &&
      ((encodeMs !== null && encodeMs > 16) || (clientJbMs !== null && clientJbMs > 25));
    const limitCongested = limitReason === 'bandwidth' || limitReason === 'cpu';
    const clientCongested =
      freshClient && (deltaDropped >= 3 || deltaFreezes > 0 || (clientJbMs !== null && clientJbMs > 75));
    const freezeDetected = freshClient && deltaFreezes > 0;
    const isCongested = limitCongested || rttCongested || clientCongested;

    if (isCongested) {
      state.healthyStreak = 0;
      state.congestedStreak++;
      if (
        (state.congestedStreak >= 2 || freezeDetected) &&
        nowMs - state.lastAdjustAtMs >= 4000
      ) {
        const prevKbps = state.currentTargetKbps;
        const prevFpsCap = state.adaptiveFpsCap;
        state.currentTargetKbps = Math.max(
          state.minFloorKbps,
          Math.round(state.currentTargetKbps * 0.75)
        );
        if (
          captureMaxFps >= 60 &&
          ((limitReason === 'cpu' && encodeMs !== null && encodeMs > 20) ||
            (limitReason === 'bandwidth' && state.currentTargetKbps < 3500))
        ) {
          state.adaptiveFpsCap = 30;
        }
        state.state =
          state.currentTargetKbps < state.baseMaxKbps || state.adaptiveFpsCap !== null
            ? 'throttled'
            : 'normal';
        state.lastAdjustAtMs = nowMs;
        state.congestedStreak = 0;
        if (state.currentTargetKbps !== prevKbps || state.adaptiveFpsCap !== prevFpsCap) {
          return {
            action: 'step_down',
            targetKbps: state.currentTargetKbps,
            fps: state.adaptiveFpsCap || captureMaxFps,
          };
        }
      }
      return null;
    }

    const isHealthy =
      limitReason === 'none' &&
      (rttMs === null || rttMs <= rttLimit) &&
      (clientJbMs === null || clientJbMs <= 55);
    if (!isHealthy) {
      state.congestedStreak = 0;
      state.healthyStreak = 0;
      return null;
    }

    state.congestedStreak = 0;
    state.healthyStreak++;

    if (
      (state.currentTargetKbps < state.baseMaxKbps || state.adaptiveFpsCap !== null) &&
      state.healthyStreak >= 4 &&
      nowMs - state.lastAdjustAtMs >= 6000
    ) {
      const prevKbps = state.currentTargetKbps;
      const prevFpsCap = state.adaptiveFpsCap;
      if (state.adaptiveFpsCap !== null) {
        state.adaptiveFpsCap = null;
      } else {
        const step = Math.max(1200, Math.round(state.currentTargetKbps * 0.15));
        state.currentTargetKbps = Math.min(state.baseMaxKbps, state.currentTargetKbps + step);
      }
      if (state.currentTargetKbps >= state.baseMaxKbps && state.adaptiveFpsCap === null) {
        state.state = 'normal';
      }
      state.lastAdjustAtMs = nowMs;
      state.healthyStreak = 0;
      if (state.currentTargetKbps !== prevKbps || state.adaptiveFpsCap !== prevFpsCap) {
        return {
          action: 'ramp_up',
          targetKbps: state.currentTargetKbps,
          fps: state.adaptiveFpsCap || captureMaxFps,
        };
      }
    }
    return null;
  }

  return {
    state,
    reset,
    evaluate,
  };
}
