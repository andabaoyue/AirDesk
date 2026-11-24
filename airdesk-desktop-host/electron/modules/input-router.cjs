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

function createInputRouter({
  screen,
  getMainWindow,
  getActiveDisplayId,
  getAuthoritativeControl,
  getHasActiveSession,
  getPhysicalMouseSilencedUntil,
  updateLastHeartbeat,
  sendToHelper,
  releaseAllInputs,
  activePressedKeys,
  activePressedMouseButtons,
}) {
  let lastCursorSyncAt = 0;
  let cursorSyncTimer = null;

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
    const targetId = displayId || getActiveDisplayId();
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

  function emitCursorPosNow() {
    cursorSyncTimer = null;
    const win = getMainWindow();
    if (!getHasActiveSession() || !win || win.isDestroyed()) return;
    try {
      const pt = screen.getCursorScreenPoint();
      const target = resolveTargetDisplay(getActiveDisplayId());
      const b = target && target.bounds;
      if (!b || b.width <= 0 || b.height <= 0) return;
      const nx = Math.max(0, Math.min(1, (pt.x - b.x) / b.width));
      const ny = Math.max(0, Math.min(1, (pt.y - b.y) / b.height));
      lastCursorSyncAt = Date.now();
      win.webContents.send('airdesk:cursor-pos', { x: nx, y: ny });
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

  function clearCursorSyncTimer() {
    if (cursorSyncTimer) {
      clearTimeout(cursorSyncTimer);
      cursorSyncTimer = null;
    }
  }

  function handleValidatedInput(msg) {
    if (!validateInputPayload(msg)) {
      return { dropped: true, reason: 'invalid_payload' };
    }

    // Always allow button/key release events even if view-only or silenced to prevent stuck state
    const isReleaseEvent =
      (msg.t === 'm:btn' && msg.state === 'up') || msg.t === 'k:up' || msg.t === 'k:release_all';

    if (!getAuthoritativeControl() && !isReleaseEvent) {
      return { dropped: true, reason: 'view_only' };
    }

    updateLastHeartbeat(Date.now());

    // During 3s physical mouse override, block remote movement/down but ALWAYS pass m:btn up
    if (
      (msg.t === 'm:rel' || msg.t === 'm:abs' || (msg.t === 'm:btn' && msg.state === 'down')) &&
      Date.now() < getPhysicalMouseSilencedUntil()
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

  return {
    getAllDisplayDescriptors,
    resolveTargetDisplay,
    validateInputPayload,
    emitCursorPosNow,
    scheduleCursorPosSync,
    clearCursorSyncTimer,
    handleValidatedInput,
  };
}

module.exports = {
  createInputRouter,
};
