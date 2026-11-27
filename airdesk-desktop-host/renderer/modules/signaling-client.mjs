export function createSignalingClient({
  WebSocketCtor = WebSocket,
  reconnectDelaysMs = [2000, 5000, 10000, 30000],
  heartbeatIntervalMs = 25000,
  pongTimeoutMs = 10000,
  onOpen,
  onMessage,
  onClose,
  onError,
  onReconnectScheduled,
} = {}) {
  let ws = null;
  let heartbeatTimer = null;
  let pongTimeoutTimer = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let stopped = false;

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function clearPongTimeout() {
    if (pongTimeoutTimer) {
      clearTimeout(pongTimeoutTimer);
      pongTimeoutTimer = null;
    }
  }

  function clearHeartbeatTimer() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function closeSocketOnly() {
    clearPongTimeout();
    clearHeartbeatTimer();
    if (ws) {
      const old = ws;
      ws = null;
      old.onopen = null;
      old.onerror = null;
      old.onclose = null;
      old.onmessage = null;
      try {
        old.close();
      } catch {}
    }
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocketCtor.OPEN) {
      ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  function isOpen() {
    return Boolean(ws && ws.readyState === WebSocketCtor.OPEN);
  }

  function getSocket() {
    return ws;
  }

  function startHeartbeat(sock, shouldSendPing) {
    clearHeartbeatTimer();
    if (!shouldSendPing) return;
    heartbeatTimer = setInterval(() => {
      if (ws !== sock || sock.readyState !== WebSocketCtor.OPEN) return;
      sock.send(JSON.stringify({ type: 'ws:ping', ts: Date.now() }));
      if (!pongTimeoutTimer) {
        pongTimeoutTimer = setTimeout(() => {
          pongTimeoutTimer = null;
          if (ws === sock && sock.readyState === WebSocketCtor.OPEN) {
            try {
              sock.close(4008, 'pong timeout');
            } catch {}
          }
        }, pongTimeoutMs);
      }
    }, heartbeatIntervalMs);
  }

  function connect(wsUrl, { enableHeartbeat = false } = {}) {
    stopped = false;
    clearReconnectTimer();
    closeSocketOnly();

    let sock;
    try {
      sock = new WebSocketCtor(wsUrl);
    } catch (err) {
      if (onError) onError(err, reconnectAttempt, true);
      return null;
    }
    ws = sock;

    sock.onopen = () => {
      if (ws !== sock || stopped) {
        try {
          sock.close();
        } catch {}
        return;
      }
      reconnectAttempt = 0;
      clearReconnectTimer();
      startHeartbeat(sock, enableHeartbeat);
      if (onOpen) onOpen(sock);
    };

    sock.onerror = (err) => {
      if (ws !== sock) return;
      if (onError) onError(err, reconnectAttempt, false);
    };

    sock.onclose = (ev) => {
      if (ws !== sock) return;
      ws = null;
      clearPongTimeout();
      clearHeartbeatTimer();
      if (onClose) onClose(ev, sock);
    };

    sock.onmessage = (ev) => {
      if (ws !== sock) return;
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      clearPongTimeout();
      if (onMessage) onMessage(msg, sock);
    };

    return sock;
  }

  function scheduleReconnect(wsUrl, opts = {}) {
    if (stopped) return false;
    const delayMs = reconnectDelaysMs[Math.min(reconnectAttempt, reconnectDelaysMs.length - 1)];
    reconnectAttempt += 1;
    clearReconnectTimer();
    if (onReconnectScheduled) {
      onReconnectScheduled(delayMs, reconnectAttempt);
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!stopped) {
        connect(wsUrl, opts);
      }
    }, delayMs);
    return true;
  }

  function resetReconnectAttempts() {
    reconnectAttempt = 0;
  }

  function getReconnectAttempt() {
    return reconnectAttempt;
  }

  function stop({ closePayload } = {}) {
    stopped = true;
    reconnectAttempt = 0;
    clearReconnectTimer();
    clearPongTimeout();
    clearHeartbeatTimer();
    if (ws) {
      const old = ws;
      ws = null;
      if (closePayload && old.readyState === WebSocketCtor.OPEN) {
        try {
          old.send(JSON.stringify(closePayload));
        } catch {}
      }
      old.onopen = null;
      old.onerror = null;
      old.onclose = null;
      old.onmessage = null;
      try {
        old.close();
      } catch {}
    }
  }

  return {
    connect,
    scheduleReconnect,
    resetReconnectAttempts,
    getReconnectAttempt,
    send,
    isOpen,
    getSocket,
    clearPongTimeout,
    clearReconnectTimer,
    stop,
  };
}
