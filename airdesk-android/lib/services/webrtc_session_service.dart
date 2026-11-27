import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' show Offset;
import 'package:flutter/foundation.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import '../models/airdesk_models.dart';
import 'file_transfer_manager.dart';
import 'native_bridge.dart';
import 'scrypt_helper.dart';
import 'sdp_helper.dart';
import 'storage_service.dart';

enum SessionPhase {
  idle,
  connectingWs,
  waitingApproval,
  negotiatingRtc,
  connected,
  disconnected,
  error,
}

class _PrevInSnap {
  final double ts;
  final int framesDecoded;
  final double totalDecodeTime;
  final int jbEmit;
  final double jbDelay;
  final double? jbTargetDelay;
  final double? jbMinDelay;

  const _PrevInSnap({
    required this.ts,
    required this.framesDecoded,
    required this.totalDecodeTime,
    required this.jbEmit,
    required this.jbDelay,
    this.jbTargetDelay,
    this.jbMinDelay,
  });
}

class WebRtcSessionService extends ChangeNotifier {
  final StorageService storage;
  final RTCVideoRenderer remoteRenderer = RTCVideoRenderer();

  WebSocket? _ws;
  RTCPeerConnection? _pc;
  RTCDataChannel? _reliableDc;
  RTCDataChannel? _unreliableDc;

  late final FileTransferManager _fileTransfer = FileTransferManager(
    onToast: _emitToast,
    onNotify: notifyListeners,
  );
  FileTransferProgress? get activeFileTransfer => _fileTransfer.activeFileTransfer;
  List<FileTransferProgress> get recentTransfers => _fileTransfer.recentTransfers;
  bool get fileChannelReady => _fileTransfer.channelReady;

  Timer? _pingTimer;
  Timer? _diagTimer;
  Timer? _wsHeartbeatTimer;
  Timer? _wsPongTimeoutTimer;
  static const int _pointerCoalesceMs = 8;
  Timer? _pointerFlushTimer;
  int _lastPointerSentAtMs = 0;
  String? _pendingPointerType;
  double _pendingRelDx = 0;
  double _pendingRelDy = 0;
  double? _pendingAbsX;
  double? _pendingAbsY;
  double _pendingWhlDx = 0;
  double _pendingWhlDy = 0;
  _PrevInSnap? _prevInSnap;
  int? _prevRxDropped;
  int? _prevRxFreezes;
  DateTime _lastPliSentAt = DateTime.fromMillisecondsSinceEpoch(0);
  final List<RTCIceCandidate> _pendingRemoteIce = [];
  MediaStream? _fallbackRemoteStream;
  MediaStreamTrack? _remoteAudioTrack;

  final ValueNotifier<Offset?> remoteCursorNorm = ValueNotifier<Offset?>(null);

  bool _rendererInitialized = false;
  bool _manualDisconnect = false;
  int _wsGen = 0;
  int _rtcGen = 0;
  String? _activeHostIp;
  int _activeHostPort = 47820;
  String? _activeSignalingUrl;
  String? _activeHostId;
  String? _activeSessionToken;
  String? _activeCustomIceRaw;
  String? _pendingAuthPassword;
  String? _lastConnectPinCode;
  String? _lastConnectPassword;
  List<String> _lastConnectIceStunUrls = const [];
  RTCIceConnectionState? _lastIceConnectionState;
  Timer? _iceRestartTimer;
  Timer? _iceRestartWatchdogTimer;
  Timer? _wsSilentReconnectTimer;
  Timer? _pendingIceRestartTimer;
  Timer? _hostOfflineRetryTimer;
  int _wsSilentReconnectAttempt = 0;
  bool _wsSilentReconnecting = false;
  bool _pendingIceRestartAfterWs = false;
  int _hostOfflineRetryCount = 0;
  int _iceRestartAttempts = 0;
  bool _iceRestartInFlight = false;
  static const int _maxIceRestartAttempts = 2;
  static const int _maxWsSilentReconnectAttempts = 4;
  static const List<int> _wsSilentReconnectDelaysSec = [1, 2, 4, 8];
  static const Duration _iceDisconnectRestartDelay = Duration(milliseconds: 2000);
  static const Duration _iceRestartWatchdogDelay = Duration(milliseconds: 6000);
  static const Duration _pendingIceRestartWaitDelay = Duration(milliseconds: 8000);

  SessionPhase phase = SessionPhase.idle;
  String statusMessage = '未连接';
  String hostLabel = '';
  bool controlEnabled = false;
  bool hostAudioEnabled = false;
  bool audioMuted = true;
  bool hostInSecureDesktop = false;
  bool hostElevatedConnected = false;
  int? lastRttMs;
  int jbSettingMs = 0;
  int _lastRxAliveAtMs = 0;

  List<RemoteDisplayInfo> displays = [];
  String activeDisplayId = '';
  TelemetrySnapshot telemetry = const TelemetrySnapshot();

  final StreamController<String> _toastCtrl = StreamController<String>.broadcast();
  final StreamController<String> _clipboardCtrl = StreamController<String>.broadcast();
  Stream<String> get toasts => _toastCtrl.stream;
  Stream<String> get remoteClipboards => _clipboardCtrl.stream;

  WebRtcSessionService(this.storage);

  static bool isOverlayHost(String ip) {
    final clean = ip.trim().toLowerCase();
    return RegExp(r'^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.').hasMatch(clean) ||
        clean.startsWith('fd7a:115c:a1e0:');
  }

  static String normalizeRelayWsUrl(String raw) {
    final trimmed = raw.trim();
    if (trimmed.isEmpty) return '';
    final withScheme = trimmed.contains('://') ? trimmed : 'https://$trimmed';
    final uri = Uri.parse(withScheme);
    final wsScheme = (uri.scheme == 'https' || uri.scheme == 'wss') ? 'wss' : 'ws';
    final portPart = uri.hasPort ? ':${uri.port}' : '';
    var path = uri.path;
    if (path.isEmpty || path == '/') {
      path = '/ws/signaling';
    } else if (!path.endsWith('/ws/signaling')) {
      path = '${path.replaceFirst(RegExp(r'/+$'), '')}/ws/signaling';
    }
    return '$wsScheme://${uri.host}$portPart$path';
  }

  static String tokenKeyForEndpoint({
    String hostIp = '',
    int port = 47820,
    String? signalingUrl,
    String? hostId,
  }) {
    final s = signalingUrl?.trim() ?? '';
    if (s.isNotEmpty) {
      String base;
      try {
        final wsUrl = normalizeRelayWsUrl(s);
        final uri = Uri.parse(wsUrl);
        final effectivePort = uri.hasPort ? uri.port : (uri.scheme == 'wss' ? 443 : 80);
        base = 'relay:${uri.host}:$effectivePort';
      } catch (_) {
        base = 'relay:$s';
      }
      final cleanHostId = hostId?.trim() ?? '';
      return cleanHostId.isNotEmpty ? '$base:$cleanHostId' : base;
    }
    return '$hostIp:$port';
  }

  @visibleForTesting
  static Map<String, dynamic> buildRtcConfig(
    List<Map<String, dynamic>> iceServers, {
    bool forceTurnRelay = false,
  }) {
    final hasTurn = iceServers.any((s) {
      final u = s['urls'];
      if (u is String) {
        return RegExp(r'^turns?:', caseSensitive: false).hasMatch(u.trim());
      }
      if (u is List) {
        return u.any(
          (item) => RegExp(r'^turns?:', caseSensitive: false).hasMatch(item.toString().trim()),
        );
      }
      return false;
    });
    final config = <String, dynamic>{
      'iceServers': iceServers,
      'iceCandidatePoolSize': iceServers.isNotEmpty ? 2 : 0,
      'sdpSemantics': 'unified-plan',
      'bundlePolicy': 'max-bundle',
      'rtcpMuxPolicy': 'require',
    };
    if (forceTurnRelay && hasTurn) {
      config['iceTransportPolicy'] = 'relay';
    }
    return config;
  }

  static List<Map<String, dynamic>> parseIceServers(String? raw) {
    final tokens = (raw ?? '')
        .split(',')
        .map((e) => e.trim())
        .where((e) => e.isNotEmpty);
    final out = <Map<String, dynamic>>[];
    for (final token in tokens) {
      final m = RegExp(r'^(turns?):(.*)$', caseSensitive: false).firstMatch(token);
      if (m != null) {
        final scheme = m.group(1)!.toLowerCase();
        final rest = m.group(2)!;
        final atIdx = rest.lastIndexOf('@');
        if (atIdx > 0) {
          final creds = rest.substring(0, atIdx);
          final colonIdx = creds.indexOf(':');
          if (colonIdx > 0) {
            out.add({
              'urls': '$scheme:${rest.substring(atIdx + 1)}',
              'username': Uri.decodeComponent(creds.substring(0, colonIdx)),
              'credential': Uri.decodeComponent(creds.substring(colonIdx + 1)),
            });
            continue;
          }
        }
      }
      out.add({'urls': token});
    }
    return out;
  }

  Future<void> ensureRendererReady() async {
    if (!_rendererInitialized) {
      await remoteRenderer.initialize();
      _rendererInitialized = true;
    }
  }

  void _emitToast(String msg) {
    if (!_toastCtrl.isClosed) _toastCtrl.add(msg);
  }

  void _setPhase(SessionPhase next, String message) {
    phase = next;
    statusMessage = message;
    notifyListeners();
  }

  @visibleForTesting
  static bool shouldClearSavedTokenOnError(
    String type,
    Map<String, dynamic> msg, {
    required bool hadToken,
  }) {
    if (!hadToken) return false;
    if (type == 'client:rejected') return true;
    if (type != 'error') return false;
    final errCode = (msg['code'] ?? '').toString().trim();
    if (errCode == 'HOST_OFFLINE') return false;
    if (msg['retryable'] == true) return false;
    if (errCode == 'TOKEN_INVALID') return true;
    final reason = (msg['reason'] ?? msg['message'] ?? '').toString();
    return reason.contains('凭证') ||
        reason.contains('过期') ||
        reason.contains('撤销') ||
        reason.contains('拒绝');
  }

  @visibleForTesting
  static bool shouldSkipRtcRebuildOnApproved(
    Map<String, dynamic> msg, {
    required bool hasLivePc,
  }) {
    return msg['reattached'] == true && hasLivePc;
  }

  @visibleForTesting
  static Map<String, dynamic> buildClientJoinPayload({
    required String deviceLabel,
    String platformHint = 'Android App',
    String? pinCode,
    String? sessionToken,
    String? hostId,
    String? authMode,
    bool attachExisting = false,
  }) {
    final payload = <String, dynamic>{
      'type': 'client:join',
      'protoVersion': 2,
      'deviceLabel': deviceLabel,
      'platformHint': platformHint,
    };
    final cleanToken = sessionToken?.trim() ?? '';
    final cleanHostId = hostId?.trim() ?? '';
    if (authMode == 'password' && cleanHostId.isNotEmpty) {
      payload['authMode'] = 'password';
      payload['hostId'] = cleanHostId;
    } else if (cleanToken.isNotEmpty) {
      payload['sessionToken'] = cleanToken;
      if (cleanHostId.isNotEmpty) {
        payload['hostId'] = cleanHostId;
      }
      if (attachExisting && cleanHostId.isNotEmpty) {
        payload['attachExisting'] = true;
      }
    } else {
      payload['code'] = (pinCode ?? '').replaceAll(RegExp(r'\D'), '');
    }
    return payload;
  }

  static int _parseStrictIntParam(dynamic raw, int defaultValue, String name) {
    if (raw == null) return defaultValue;
    if (raw is int) return raw;
    if (raw is double && raw.isFinite && raw == raw.truncateToDouble()) {
      return raw.toInt();
    }
    throw ArgumentError.value(raw, name, 'scrypt $name must be an integer');
  }

  @visibleForTesting
  static ({int n, int r, int p, int dkLen}) parseAndValidateChallengeKdfParams(
    Map<String, dynamic> msg,
  ) {
    final kdfRaw = msg['kdf'];
    if (kdfRaw != null && kdfRaw.toString() != 'scrypt') {
      throw ArgumentError.value(kdfRaw, 'kdf', 'Unsupported KDF algorithm');
    }
    final n = _parseStrictIntParam(msg['n'], 16384, 'n');
    final r = _parseStrictIntParam(msg['r'], 8, 'r');
    final p = _parseStrictIntParam(msg['p'], 1, 'p');
    final dkLen = _parseStrictIntParam(msg['dkLen'], 32, 'dkLen');
    ScryptHelper.validateScryptParams(n: n, r: r, p: p, dkLen: dkLen);
    return (n: n, r: r, p: p, dkLen: dkLen);
  }

  bool get _hasLiveMediaSession =>
      _pc != null &&
      (phase == SessionPhase.connected ||
          _reliableDc?.state == RTCDataChannelState.RTCDataChannelOpen ||
          _iceRestartInFlight ||
          _pendingIceRestartAfterWs);

  void _startWsHeartbeat(WebSocket sock, int myWsGen) {
    _wsHeartbeatTimer?.cancel();
    _wsHeartbeatTimer = Timer.periodic(const Duration(seconds: 25), (_) {
      if (_ws != sock || _wsGen != myWsGen) return;
      _sendWs({'type': 'ws:ping', 'ts': DateTime.now().millisecondsSinceEpoch});
      _clearWsPongTimeout();
      _wsPongTimeoutTimer = Timer(const Duration(seconds: 10), () {
        _wsPongTimeoutTimer = null;
        if (_ws == sock && _wsGen == myWsGen) {
          try {
            sock.close(4008, 'pong timeout');
          } catch (_) {}
        }
      });
    });
  }

  void _attachRelayOrLanSocket({
    required WebSocket sock,
    required int myWsGen,
    required String cleanHostIp,
    required int port,
    required List<String> iceStunUrls,
    required String tokenKey,
    required String baseRelayKey,
    required bool isRelayMode,
    required String? customIceRaw,
    required bool hadToken,
  }) {
    sock.listen(
      (raw) {
        if (_ws != sock || _wsGen != myWsGen) return;
        _handleWsMessage(
          raw,
          cleanHostIp,
          port,
          iceStunUrls,
          tokenKey: tokenKey,
          baseRelayKey: baseRelayKey,
          isRelayMode: isRelayMode,
          customIceRaw: customIceRaw,
          hadToken: hadToken,
          sock: sock,
          wsGen: myWsGen,
        );
      },
      onError: (err) {
        if (_ws != sock || _wsGen != myWsGen) return;
        _clearWsPongTimeout();
        _wsHeartbeatTimer?.cancel();
        _wsHeartbeatTimer = null;
        _pendingAuthPassword = null;
        if (isRelayMode && !_manualDisconnect && _hasLiveMediaSession) {
          _ws = null;
          if (!_wsSilentReconnecting) {
            _scheduleWsSilentReconnect();
          }
          return;
        }
        if (!_manualDisconnect) {
          _setPhase(SessionPhase.error, '信令连接异常：$err');
        }
      },
      onDone: () {
        if (_ws != sock || _wsGen != myWsGen) return;
        _clearWsPongTimeout();
        _wsHeartbeatTimer?.cancel();
        _wsHeartbeatTimer = null;
        _pendingAuthPassword = null;
        if (isRelayMode && !_manualDisconnect && _hasLiveMediaSession) {
          _ws = null;
          if (!_wsSilentReconnecting) {
            _scheduleWsSilentReconnect();
          }
          return;
        }
        if (!_manualDisconnect && phase != SessionPhase.error) {
          _cleanupRtc();
          _setPhase(SessionPhase.disconnected, '信令连接已断开');
        }
      },
    );
  }

  void _scheduleWsSilentReconnect() {
    if (_manualDisconnect || !_hasLiveMediaSession) {
      _wsSilentReconnecting = false;
      return;
    }
    final relayUrl = _activeSignalingUrl?.trim() ?? '';
    final hostId = _activeHostId?.trim() ?? '';
    final token = _activeSessionToken?.trim() ?? '';
    if (relayUrl.isEmpty ||
        hostId.isEmpty ||
        token.isEmpty ||
        _wsSilentReconnectAttempt >= _maxWsSilentReconnectAttempts) {
      _wsSilentReconnecting = false;
      _wsSilentReconnectTimer?.cancel();
      _wsSilentReconnectTimer = null;
      _pendingIceRestartAfterWs = false;
      _pendingIceRestartTimer?.cancel();
      _pendingIceRestartTimer = null;
      unawaited(_cleanupRtc().then((_) {
        if (!_manualDisconnect) {
          _setPhase(SessionPhase.disconnected, '信令连接已断开');
        }
      }));
      return;
    }

    final delaySec = _wsSilentReconnectDelaysSec[
        _wsSilentReconnectAttempt.clamp(0, _wsSilentReconnectDelaysSec.length - 1)];
    _wsSilentReconnectAttempt += 1;
    _wsSilentReconnecting = true;
    _wsSilentReconnectTimer?.cancel();
    _wsSilentReconnectTimer = Timer(Duration(seconds: delaySec), () async {
      _wsSilentReconnectTimer = null;
      if (_manualDisconnect || !_hasLiveMediaSession) {
        _wsSilentReconnecting = false;
        return;
      }
      final myWsGen = ++_wsGen;
      final baseRelayKey = tokenKeyForEndpoint(signalingUrl: relayUrl);
      final tokenKey = tokenKeyForEndpoint(signalingUrl: relayUrl, hostId: hostId);
      try {
        final wsUrl = normalizeRelayWsUrl(relayUrl);
        final sock = await WebSocket.connect(wsUrl).timeout(const Duration(seconds: 10));
        if (_manualDisconnect || !_hasLiveMediaSession || _wsGen != myWsGen) {
          try {
            await sock.close();
          } catch (_) {}
          return;
        }
        _ws = sock;
        _startWsHeartbeat(sock, myWsGen);
        _attachRelayOrLanSocket(
          sock: sock,
          myWsGen: myWsGen,
          cleanHostIp: '',
          port: _activeHostPort,
          iceStunUrls: _lastConnectIceStunUrls,
          tokenKey: tokenKey,
          baseRelayKey: baseRelayKey,
          isRelayMode: true,
          customIceRaw: _activeCustomIceRaw,
          hadToken: true,
        );
        final deviceModel = await NativeBridge.getDeviceModelName();
        final deviceLabel = await storage.getDeviceLabel('$deviceModel (APK)');
        if (_manualDisconnect || _ws != sock || _wsGen != myWsGen) return;
        _sendWs(
          buildClientJoinPayload(
            deviceLabel: deviceLabel,
            sessionToken: token,
            hostId: hostId,
            attachExisting: true,
          ),
        );
      } catch (_) {
        if (!_manualDisconnect && _wsGen == myWsGen) {
          _scheduleWsSilentReconnect();
        }
      }
    });
  }

  Future<void> connect({
    String hostIp = '',
    int port = 47820,
    String? signalingUrl,
    String? customIceRaw,
    String? pinCode,
    String? sessionToken,
    String? hostId,
    String? password,
    List<String> iceStunUrls = const [],
    bool resetOfflineRetry = true,
  }) async {
    await ensureRendererReady();
    await disconnect(silent: true, resetOfflineRetry: resetOfflineRetry);

    final relayUrl = signalingUrl?.trim() ?? '';
    final isRelayMode = relayUrl.isNotEmpty;
    final cleanHostIp = hostIp.trim();
    final baseRelayKey = isRelayMode
        ? tokenKeyForEndpoint(signalingUrl: relayUrl)
        : '$cleanHostIp:$port';
    final tokenKey = tokenKeyForEndpoint(
      hostIp: cleanHostIp,
      port: port,
      signalingUrl: isRelayMode ? relayUrl : null,
      hostId: isRelayMode ? hostId : null,
    );

    _manualDisconnect = false;
    if (resetOfflineRetry) {
      _hostOfflineRetryCount = 0;
    }
    final myWsGen = ++_wsGen;
    _activeHostIp = isRelayMode ? null : cleanHostIp;
    _activeHostPort = port;
    _activeSignalingUrl = isRelayMode ? relayUrl : null;
    _activeHostId = hostId?.trim();
    _activeSessionToken = sessionToken?.trim();
    _activeCustomIceRaw = customIceRaw?.trim();
    _pendingAuthPassword = (password != null && password.isNotEmpty) ? password : null;
    _lastConnectPinCode = pinCode;
    _lastConnectPassword = password;
    _lastConnectIceStunUrls = iceStunUrls;

    final isOverlay = !isRelayMode && isOverlayHost(cleanHostIp);

    final allowOverlay = await storage.getAllowOverlayTun();
    await NativeBridge.setAllowOverlayTun(allowOverlay);
    final isPureLan = !isRelayMode && !isOverlay && !cleanHostIp.contains(':');
    await NativeBridge.setLanOnlyNetFilter(isPureLan);

    _setPhase(
      SessionPhase.connectingWs,
      isRelayMode
          ? '正在连接公网信令服务器...'
          : (isOverlay ? '正在通过异地组网直连 $cleanHostIp:$port...' : '正在连接电脑端信令...'),
    );

    final deviceModel = await NativeBridge.getDeviceModelName();
    final deviceLabel = await storage.getDeviceLabel('$deviceModel (APK)');

    String wsUrl;
    late final WebSocket sock;
    try {
      wsUrl = isRelayMode
          ? normalizeRelayWsUrl(relayUrl)
          : 'ws://$cleanHostIp:$port/ws/signaling';
      sock = await WebSocket.connect(wsUrl).timeout(
        Duration(seconds: (isRelayMode || isOverlay) ? 10 : 6),
      );
      if (_manualDisconnect || _wsGen != myWsGen) {
        try {
          await sock.close();
        } catch (_) {}
        return;
      }
      _ws = sock;
    } catch (e) {
      if (_manualDisconnect || _wsGen != myWsGen) return;
      _setPhase(
        SessionPhase.error,
        isRelayMode
            ? '无法连接公网信令 $relayUrl，请确认服务器已启动且电脑端已点“启动串流与配对” ($e)'
            : (isOverlay
                ? '无法连接异地主机 $cleanHostIp:$port，请确认手机与电脑均已登录 Tailscale/ZeroTier 且电脑端已点“启动串流与配对” ($e)'
                : '无法连接 $cleanHostIp:$port，请确认同一热点/Wi-Fi 且电脑端已点“启动串流与配对” ($e)'),
      );
      return;
    }

    if (isRelayMode) {
      _startWsHeartbeat(sock, myWsGen);
    }

    final usePasswordAuth = isRelayMode &&
        _pendingAuthPassword != null &&
        _pendingAuthPassword!.isNotEmpty &&
        hostId != null &&
        hostId.trim().isNotEmpty;

    _attachRelayOrLanSocket(
      sock: sock,
      myWsGen: myWsGen,
      cleanHostIp: cleanHostIp,
      port: port,
      iceStunUrls: iceStunUrls,
      tokenKey: tokenKey,
      baseRelayKey: baseRelayKey,
      isRelayMode: isRelayMode,
      customIceRaw: customIceRaw,
      hadToken: sessionToken != null,
    );

    final joinPayload = buildClientJoinPayload(
      deviceLabel: deviceLabel,
      pinCode: pinCode,
      sessionToken: usePasswordAuth ? null : sessionToken,
      hostId: isRelayMode ? hostId : null,
      authMode: usePasswordAuth ? 'password' : null,
    );
    _sendWs(joinPayload);
  }

  void _clearWsPongTimeout() {
    _wsPongTimeoutTimer?.cancel();
    _wsPongTimeoutTimer = null;
  }

  void _sendWs(Map<String, dynamic> obj) {
    try {
      _ws?.add(jsonEncode(obj));
    } catch (_) {}
  }

  List<Map<String, dynamic>> _resolveIceServers({
    required bool isRelayMode,
    required List<String> iceStunUrls,
    dynamic serverIceRaw,
    String? customIceRaw,
  }) {
    final merged = <Map<String, dynamic>>[];
    if (serverIceRaw is List) {
      for (final item in serverIceRaw) {
        if (item is Map) {
          merged.add(Map<String, dynamic>.from(item));
        }
      }
    }
    merged.addAll(parseIceServers(customIceRaw));
    for (final u in iceStunUrls) {
      if (u.trim().isNotEmpty) merged.add({'urls': u.trim()});
    }
    if (isRelayMode && merged.isEmpty) {
      return [
        {'urls': 'stun:stun.miwifi.com:3478'},
        {'urls': 'stun:stun.l.google.com:19302'},
      ];
    }
    return merged;
  }

  Future<void> _handleWsMessage(
    dynamic raw,
    String hostIp,
    int port,
    List<String> iceStunUrls, {
    required String tokenKey,
    required String baseRelayKey,
    required bool isRelayMode,
    String? customIceRaw,
    required bool hadToken,
    required WebSocket sock,
    required int wsGen,
  }) async {
    Map<String, dynamic> msg;
    try {
      msg = jsonDecode(raw.toString()) as Map<String, dynamic>;
    } catch (_) {
      return;
    }
    _clearWsPongTimeout();

    final type = (msg['type'] ?? '').toString();
    if (type == 'ws:pong') {
      return;
    } else if (type == 'client:password_challenge') {
      final pw = _pendingAuthPassword;
      _pendingAuthPassword = null;
      final challengeId = (msg['challengeId'] ?? '').toString();
      final nonce = (msg['nonce'] ?? '').toString();
      final saltHex = (msg['salt'] ?? '').toString();
      final chalHostId = (msg['hostId'] ?? _activeHostId ?? '').toString();
      if (pw == null || pw.isEmpty || challengeId.isEmpty || nonce.isEmpty || saltHex.isEmpty) {
        _setPhase(SessionPhase.error, '访问密码验证参数缺失');
        return;
      }
      final ({int n, int r, int p, int dkLen}) kdfParams;
      try {
        kdfParams = parseAndValidateChallengeKdfParams(msg);
      } on ArgumentError {
        _setPhase(SessionPhase.error, '安全验证参数异常');
        return;
      }
      _setPhase(SessionPhase.waitingApproval, '正在进行安全密码验证...');
      final String proof;
      try {
        proof = await ScryptHelper.computeChallengeProofAsync(
          password: pw,
          saltHex: saltHex,
          hostId: chalHostId,
          challengeId: challengeId,
          nonce: nonce,
          n: kdfParams.n,
          r: kdfParams.r,
          p: kdfParams.p,
          dkLen: kdfParams.dkLen,
        );
      } on ArgumentError {
        if (_manualDisconnect || _ws != sock || _wsGen != wsGen) return;
        _setPhase(SessionPhase.error, '安全验证参数异常');
        return;
      } on FormatException {
        if (_manualDisconnect || _ws != sock || _wsGen != wsGen) return;
        _setPhase(SessionPhase.error, '安全验证参数异常');
        return;
      }
      if (_manualDisconnect || _ws != sock || _wsGen != wsGen) return;
      _sendWs({
        'type': 'client:password_response',
        'challengeId': challengeId,
        'proof': proof,
      });
    } else if (type == 'client:waiting_approval') {
      hostLabel = (msg['hostLabel'] ?? (isRelayMode ? '远程电脑' : hostIp)).toString();
      _setPhase(SessionPhase.waitingApproval, '等待电脑审批（可在电脑按 Ctrl+Alt+Y 批准）...');
    } else if (type == 'client:rejected' || type == 'error') {
      _pendingAuthPassword = null;
      if (type == 'error' &&
          msg['code'] == 'HOST_OFFLINE' &&
          msg['retryable'] == true &&
          isRelayMode &&
          !_manualDisconnect &&
          _hostOfflineRetryCount < 2) {
        _hostOfflineRetryCount += 1;
        final delayMs = _hostOfflineRetryCount == 1 ? 1500 : 3000;
        if (_hasLiveMediaSession) {
          _hostOfflineRetryTimer?.cancel();
          _hostOfflineRetryTimer = Timer(Duration(milliseconds: delayMs), () {
            _hostOfflineRetryTimer = null;
            if (_manualDisconnect || !_hasLiveMediaSession) return;
            _scheduleWsSilentReconnect();
          });
          return;
        }
        final retryRelayUrl = _activeSignalingUrl;
        final retryHostId = _activeHostId;
        final retryToken = _activeSessionToken;
        final retryCustomIce = _activeCustomIceRaw;
        final retryPin = _lastConnectPinCode;
        final retryPw = _lastConnectPassword;
        final retryIceStuns = _lastConnectIceStunUrls;
        _setPhase(SessionPhase.connectingWs, '目标电脑正在恢复上线，正在自动重连 ($_hostOfflineRetryCount/2)...');
        _hostOfflineRetryTimer?.cancel();
        _hostOfflineRetryTimer = Timer(Duration(milliseconds: delayMs), () {
          _hostOfflineRetryTimer = null;
          if (_manualDisconnect || retryRelayUrl == null) return;
          unawaited(
            connect(
              signalingUrl: retryRelayUrl,
              customIceRaw: retryCustomIce,
              pinCode: retryPin,
              sessionToken: retryToken,
              hostId: retryHostId,
              password: retryPw,
              iceStunUrls: retryIceStuns,
              resetOfflineRetry: false,
            ),
          );
        });
        return;
      }
      _wsSilentReconnecting = false;
      _wsSilentReconnectTimer?.cancel();
      _wsSilentReconnectTimer = null;
      if (shouldClearSavedTokenOnError(type, msg, hadToken: hadToken)) {
        if (isRelayMode) {
          await storage.removeTokenForRelay(baseRelayKey, hostId: _activeHostId);
          final legacyHostId = await storage.getHostIdForKey(baseRelayKey);
          if (_activeHostId == null || _activeHostId!.isEmpty || legacyHostId == _activeHostId) {
            await storage.removeHostIdForKey(baseRelayKey);
          }
          await storage.removeHostIdForKey(tokenKey);
        } else {
          await storage.removeTokenForKey(tokenKey);
          await storage.removeHostIdForKey(tokenKey);
        }
      }
      if (_hasLiveMediaSession) {
        await _cleanupRtc();
      }
      final reason = (msg['reason'] ?? msg['message'] ?? '连接被拒绝').toString();
      _setPhase(SessionPhase.error, reason);
    } else if (type == 'client:approved') {
      _pendingAuthPassword = null;
      _wsSilentReconnecting = false;
      _wsSilentReconnectAttempt = 0;
      _wsSilentReconnectTimer?.cancel();
      _wsSilentReconnectTimer = null;
      _hostOfflineRetryCount = 0;
      _hostOfflineRetryTimer?.cancel();
      _hostOfflineRetryTimer = null;
      hostLabel = (msg['hostLabel'] ?? (isRelayMode ? '远程电脑' : hostIp)).toString();
      controlEnabled = msg['mode'] == 'full_control';
      hostAudioEnabled = msg['audioEnabled'] == true;
      audioMuted = !hostAudioEnabled;
      final newToken = (msg['sessionToken'] ?? '').toString();
      final approvedHostId = (msg['hostId'] ?? '').toString().trim();
      if (newToken.isNotEmpty) {
        _activeSessionToken = newToken;
      }
      if (isRelayMode && approvedHostId.isNotEmpty) {
        _activeHostId = approvedHostId;
        final scopedKey = tokenKeyForEndpoint(
          signalingUrl: _activeSignalingUrl,
          hostId: approvedHostId,
        );
        if (newToken.isNotEmpty) {
          await storage.saveTokenForKey(scopedKey, newToken);
        }
        await storage.saveHostIdForKey(baseRelayKey, approvedHostId);
        await storage.saveHostIdForKey(scopedKey, approvedHostId);
      } else if (newToken.isNotEmpty) {
        await storage.saveTokenForKey(tokenKey, newToken);
      }
      if (!isRelayMode && hostIp.isNotEmpty) {
        await storage.saveRecentHost(hostIp, port, hostLabel);
      }
      final profileHostId = approvedHostId.isNotEmpty ? approvedHostId : (_activeHostId ?? '').trim();
      if (profileHostId.isNotEmpty) {
        await storage.upsertHostProfile(
          SavedHostProfile(
            hostId: profileHostId,
            hostLabel: hostLabel.isNotEmpty ? hostLabel : profileHostId,
            relayUrl: isRelayMode ? (_activeSignalingUrl ?? '') : '',
            lastLanIp: !isRelayMode ? hostIp : '',
            lastLanPort: !isRelayMode ? port : 47820,
            customIceRaw: isRelayMode ? (_activeCustomIceRaw ?? '') : '',
            lastUsedMs: DateTime.now().millisecondsSinceEpoch,
          ),
        );
      }
      if (shouldSkipRtcRebuildOnApproved(msg, hasLivePc: _pc != null && !_manualDisconnect)) {
        _remoteAudioTrack?.enabled = !audioMuted;
        _emitToast('信令通道已静默重连，画面保持中');
        notifyListeners();
        final shouldIceRestart = _pendingIceRestartAfterWs ||
            _lastIceConnectionState == RTCIceConnectionState.RTCIceConnectionStateDisconnected ||
            _lastIceConnectionState == RTCIceConnectionState.RTCIceConnectionStateFailed;
        if (shouldIceRestart && _pc != null) {
          _pendingIceRestartAfterWs = false;
          _pendingIceRestartTimer?.cancel();
          _pendingIceRestartTimer = null;
          unawaited(_tryIceRestart(_pc!, _rtcGen, reason: 'ws_reattached'));
        }
        return;
      }
      final iceServers = _resolveIceServers(
        isRelayMode: isRelayMode,
        iceStunUrls: iceStunUrls,
        serverIceRaw: msg['iceServers'],
        customIceRaw: customIceRaw,
      );
      await _startRtc(iceServers);
    } else if (type == 'session:signaling_resumed') {
      _hostOfflineRetryCount = 0;
      _hostOfflineRetryTimer?.cancel();
      _hostOfflineRetryTimer = null;
      _emitToast('电脑端信令已恢复');
    } else if (type == 'rtc:answer' && _pc != null) {
      final sdp = (msg['sdp'] ?? '').toString();
      await _pc!.setRemoteDescription(RTCSessionDescription(sdp, 'answer'));
      for (final c in _pendingRemoteIce) {
        await _pc!.addCandidate(c).catchError((_) {});
      }
      _pendingRemoteIce.clear();
    } else if (type == 'rtc:ice' && msg['candidate'] is Map) {
      final cm = msg['candidate'] as Map<String, dynamic>;
      final cand = RTCIceCandidate(
        (cm['candidate'] ?? '').toString(),
        (cm['sdpMid'] ?? '').toString(),
        (cm['sdpMLineIndex'] as num?)?.toInt(),
      );
      if (_pc != null && (await _pc!.getRemoteDescription()) != null) {
        await _pc!.addCandidate(cand).catchError((_) {});
      } else {
        _pendingRemoteIce.add(cand);
      }
    } else if (type == 'session:permission_updated') {
      controlEnabled = msg['controlEnabled'] == true;
      _emitToast(controlEnabled ? '电脑已开启远程操控权限' : '已切换为只读观看模式');
      notifyListeners();
    } else if (type == 'session:closed') {
      final reason = (msg['reason'] ?? '电脑端已关闭共享').toString();
      await _cleanupRtc();
      _setPhase(SessionPhase.disconnected, reason);
    }
  }

  Future<void> _applyAndroidMediaAudioMode() async {
    try {
      await Helper.setAndroidAudioConfiguration(AndroidAudioConfiguration.media);
    } catch (_) {}
    await NativeBridge.ensureMediaAudioMode();
  }

  Future<void> _startRtc(
    List<Map<String, dynamic>> iceServers,
  ) async {
    final myRtcGen = ++_rtcGen;
    await _cleanupRtc();
    if (_manualDisconnect || _rtcGen != myRtcGen) return;
    _setPhase(SessionPhase.negotiatingRtc, '正在建立超低延迟 WebRTC 视频通道...');

    await _applyAndroidMediaAudioMode();
    if (_manualDisconnect || _rtcGen != myRtcGen) return;

    final forceTurn = await storage.getForceTurnRelay();
    if (_manualDisconnect || _rtcGen != myRtcGen) return;

    final config = buildRtcConfig(iceServers, forceTurnRelay: forceTurn);
    final pc = await createPeerConnection(config);
    if (_manualDisconnect || _rtcGen != myRtcGen) {
      try {
        await pc.close();
      } catch (_) {}
      return;
    }
    _pc = pc;

    bool isStale() => _manualDisconnect || _rtcGen != myRtcGen || _pc != pc;

    pc.onIceConnectionState = (state) {
      if (isStale()) return;
      _lastIceConnectionState = state;
      if (state == RTCIceConnectionState.RTCIceConnectionStateConnected ||
          state == RTCIceConnectionState.RTCIceConnectionStateCompleted) {
        _iceRestartTimer?.cancel();
        _iceRestartTimer = null;
        _iceRestartWatchdogTimer?.cancel();
        _iceRestartWatchdogTimer = null;
        _pendingIceRestartAfterWs = false;
        _pendingIceRestartTimer?.cancel();
        _pendingIceRestartTimer = null;
        _iceRestartAttempts = 0;
        _iceRestartInFlight = false;
        if (phase != SessionPhase.connected) {
          final isRelay = _activeSignalingUrl != null && _activeSignalingUrl!.isNotEmpty;
          final overlayConn = !isRelay && _activeHostIp != null && isOverlayHost(_activeHostIp!);
          _setPhase(
            SessionPhase.connected,
            isRelay
                ? '已通过公网中继连上 $hostLabel'
                : (overlayConn ? '已异地直连 $hostLabel' : '已直连 $hostLabel'),
          );
        }
      } else if (state == RTCIceConnectionState.RTCIceConnectionStateDisconnected) {
        _iceRestartTimer?.cancel();
        _iceRestartTimer = Timer(_iceDisconnectRestartDelay, () {
          _iceRestartTimer = null;
          if (!isStale()) {
            unawaited(_tryIceRestart(pc, myRtcGen, reason: 'ice_disconnected'));
          }
        });
      } else if (state == RTCIceConnectionState.RTCIceConnectionStateFailed) {
        _iceRestartTimer?.cancel();
        _iceRestartTimer = null;
        if (!isStale()) {
          unawaited(_tryIceRestart(pc, myRtcGen, reason: 'ice_failed'));
        }
      }
    };

    pc.onTrack = (RTCTrackEvent event) {
      if (isStale()) return;
      if (event.track.kind == 'audio') {
        _remoteAudioTrack = event.track;
        event.track.enabled = !audioMuted;
        unawaited(
          _applyAndroidMediaAudioMode().then((_) async {
            await Future<void>.delayed(const Duration(milliseconds: 300));
            if (!isStale()) {
              await _applyAndroidMediaAudioMode();
            }
          }),
        );
        return;
      }
      if (event.track.kind != 'video') return;
      if (event.streams.isNotEmpty) {
        remoteRenderer.srcObject = event.streams[0];
        notifyListeners();
      } else {
        createLocalMediaStream('airdesk_remote').then((s) async {
          if (isStale()) {
            try {
              await s.dispose();
            } catch (_) {}
            return;
          }
          final prevFallback = _fallbackRemoteStream;
          _fallbackRemoteStream = s;
          if (prevFallback != null && prevFallback != s) {
            try {
              await prevFallback.dispose();
            } catch (_) {}
          }
          s.addTrack(event.track);
          remoteRenderer.srcObject = s;
          notifyListeners();
        });
      }
    };

    pc.onIceCandidate = (RTCIceCandidate candidate) {
      if (isStale()) return;
      final cs = candidate.candidate ?? '';
      if (SdpHelper.isVirtualCandidate(cs)) return;
      _sendWs({
        'type': 'rtc:ice',
        'candidate': {
          'candidate': candidate.candidate,
          'sdpMid': candidate.sdpMid,
          'sdpMLineIndex': candidate.sdpMLineIndex,
        },
      });
    };

    await pc.addTransceiver(
      kind: RTCRtpMediaType.RTCRtpMediaTypeVideo,
      init: RTCRtpTransceiverInit(direction: TransceiverDirection.RecvOnly),
    );
    if (isStale()) return;
    // Always pre-allocate RecvOnly audio transceiver so audio toggles never recreate RTCPeerConnection
    await pc.addTransceiver(
      kind: RTCRtpMediaType.RTCRtpMediaTypeAudio,
      init: RTCRtpTransceiverInit(direction: TransceiverDirection.RecvOnly),
    );
    if (isStale()) return;

    final reliableDc = await pc.createDataChannel(
      'ctrl-reliable',
      RTCDataChannelInit()..ordered = true,
    );
    if (isStale()) return;
    _reliableDc = reliableDc;

    final unreliableDc = await pc.createDataChannel(
      'input-unreliable',
      RTCDataChannelInit()
        ..ordered = false
        ..maxRetransmits = 0,
    );
    if (isStale()) return;
    _unreliableDc = unreliableDc;

    final fileDc = await pc.createDataChannel(
      'file-transfer',
      RTCDataChannelInit()..ordered = true,
    );
    if (isStale()) return;
    _fileTransfer.attachChannel(fileDc, isStale: isStale);

    reliableDc.onDataChannelState = (state) async {
      if (isStale()) return;
      if (state == RTCDataChannelState.RTCDataChannelOpen) {
        // Push saved preset/policy immediately when DataChannel opens
        final preset = await storage.getScenePreset();
        if (isStale()) return;
        sendPolicy(
          preset: preset.id,
          resolution: preset.resolution,
          fps: preset.fps,
          maxBitrateKbps: preset.bitrateKbps,
          contentHint: preset.contentHint,
        );
        final isRelay = _activeSignalingUrl != null && _activeSignalingUrl!.isNotEmpty;
        final isOverlay = _activeHostIp != null && isOverlayHost(_activeHostIp!);
        if ((isRelay || isOverlay) && preset.bitrateKbps >= 18000) {
          _emitToast(
            isRelay
                ? '当前为公网远程连接，如网络波动可在悬浮球切换「异地省流」'
                : '当前为异地直连，如移动网络波动可在悬浮球切换「异地省流」',
          );
        }
        _collectAndSendRxDiag();
      }
    };

    reliableDc.onMessage = (RTCDataChannelMessage message) {
      if (isStale() || message.isBinary) return;
      _handleDcMessage(message.text);
    };

    unreliableDc.onMessage = (RTCDataChannelMessage message) {
      if (isStale() || message.isBinary) return;
      _handleDcMessage(message.text);
    };

    final preferHevc = await storage.getPreferHevc();
    if (isStale()) return;
    final offer = await pc.createOffer();
    if (isStale()) return;
    final preferredSdp = SdpHelper.prioritizeVideoCodecs(offer.sdp ?? '', preferHevc: preferHevc);
    final finalOffer = RTCSessionDescription(preferredSdp, offer.type);
    await pc.setLocalDescription(finalOffer);
    if (isStale()) return;

    _sendWs({'type': 'rtc:offer', 'sdp': finalOffer.sdp});

    _pingTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      sendReliable({'t': 'ping', 'ts': DateTime.now().millisecondsSinceEpoch});
    });
    _diagTimer = Timer.periodic(const Duration(seconds: 2), (_) {
      _collectAndSendRxDiag();
    });
  }

  Future<void> _tryIceRestart(
    RTCPeerConnection targetPc,
    int myRtcGen, {
    required String reason,
  }) async {
    if (_manualDisconnect || _rtcGen != myRtcGen || _pc != targetPc) return;
    if (_iceRestartInFlight) return;

    final wsReady = _ws != null && _ws!.readyState == WebSocket.open;
    if (!wsReady && _wsSilentReconnecting && _iceRestartAttempts < _maxIceRestartAttempts) {
      _pendingIceRestartAfterWs = true;
      _pendingIceRestartTimer ??= Timer(_pendingIceRestartWaitDelay, () {
        _pendingIceRestartTimer = null;
        if (_manualDisconnect || _rtcGen != myRtcGen || _pc != targetPc) return;
        if (_pendingIceRestartAfterWs) {
          _pendingIceRestartAfterWs = false;
          _setPhase(SessionPhase.disconnected, '视频通道中断 ($reason)');
          unawaited(reconnectSaved());
        }
      });
      return;
    }
    if (!wsReady || _iceRestartAttempts >= _maxIceRestartAttempts) {
      _iceRestartWatchdogTimer?.cancel();
      _iceRestartWatchdogTimer = null;
      _setPhase(SessionPhase.disconnected, '视频通道中断 ($reason)');
      if (!_manualDisconnect && (_activeSignalingUrl != null || _activeHostIp != null)) {
        unawaited(reconnectSaved());
      }
      return;
    }

    _iceRestartInFlight = true;
    _iceRestartAttempts += 1;
    try {
      _emitToast('检测到切网/链路波动，正在无缝刷新通道 ($_iceRestartAttempts/$_maxIceRestartAttempts)...');
      final preferHevc = await storage.getPreferHevc();
      if (_manualDisconnect || _rtcGen != myRtcGen || _pc != targetPc) return;
      final offer = await targetPc.createOffer({'iceRestart': true});
      if (_manualDisconnect || _rtcGen != myRtcGen || _pc != targetPc) return;
      final preferredSdp = SdpHelper.prioritizeVideoCodecs(offer.sdp ?? '', preferHevc: preferHevc);
      final finalOffer = RTCSessionDescription(preferredSdp, offer.type);
      await targetPc.setLocalDescription(finalOffer);
      if (_manualDisconnect || _rtcGen != myRtcGen || _pc != targetPc) return;
      _sendWs({'type': 'rtc:offer', 'sdp': finalOffer.sdp, 'iceRestart': true});

      _iceRestartWatchdogTimer?.cancel();
      _iceRestartWatchdogTimer = Timer(_iceRestartWatchdogDelay, () {
        _iceRestartWatchdogTimer = null;
        if (_manualDisconnect || _rtcGen != myRtcGen || _pc != targetPc) return;
        unawaited(_tryIceRestart(targetPc, myRtcGen, reason: 'ice_restart_timeout'));
      });
    } catch (_) {
      if (!_manualDisconnect && _rtcGen == myRtcGen && _pc == targetPc) {
        _setPhase(SessionPhase.disconnected, '视频通道恢复失败 ($reason)');
        unawaited(reconnectSaved());
      }
    } finally {
      _iceRestartInFlight = false;
    }
  }

  void _handleDcMessage(String text) {
    Map<String, dynamic> d;
    try {
      d = jsonDecode(text) as Map<String, dynamic>;
    } catch (_) {
      return;
    }

    final t = (d['t'] ?? '').toString();
    if (t == 'perm') {
      controlEnabled = d['controlEnabled'] == true;
      _emitToast(controlEnabled ? '已开启操控权' : '已切换为只读');
      notifyListeners();
    } else if (t == 'ui:config') {
      if (d['audioEnabled'] is bool) {
        final nextAudio = d['audioEnabled'] == true;
        if (nextAudio != hostAudioEnabled) {
          hostAudioEnabled = nextAudio;
          audioMuted = !nextAudio;
          _remoteAudioTrack?.enabled = !audioMuted;
          if (hostAudioEnabled) {
            unawaited(_applyAndroidMediaAudioMode());
          }
          _emitToast(
            hostAudioEnabled
                ? '电脑已开启桌面声音'
                : '电脑已关闭桌面声音，已切回纯画面',
          );
          notifyListeners();
        }
      }
    } else if (t == 'pong' && d['ts'] is num) {
      _lastRxAliveAtMs = DateTime.now().millisecondsSinceEpoch;
      final rtt = (DateTime.now().millisecondsSinceEpoch - (d['ts'] as num).toInt()).clamp(1, 9999);
      lastRttMs = rtt;
      telemetry = telemetry.copyWithRx(rttMs: rtt);
      notifyListeners();
    } else if (t == 'displays:list' && d['displays'] is List) {
      displays = (d['displays'] as List<dynamic>)
          .whereType<Map<String, dynamic>>()
          .map(RemoteDisplayInfo.fromJson)
          .toList();
      activeDisplayId = (d['activeDisplayId'] ?? '').toString();
      notifyListeners();
    } else if (t == 'diag:tx') {
      _lastRxAliveAtMs = DateTime.now().millisecondsSinceEpoch;
      telemetry = telemetry.copyWithTx(d);
      notifyListeners();
    } else if (t == 'clip:data') {
      final clip = (d['text'] ?? '').toString();
      if (!_clipboardCtrl.isClosed) _clipboardCtrl.add(clip);
    } else if (t == 'cursor:pos' && d['x'] is num && d['y'] is num) {
      final x = (d['x'] as num).toDouble().clamp(0.0, 1.0);
      final y = (d['y'] as num).toDouble().clamp(0.0, 1.0);
      remoteCursorNorm.value = Offset(x, y);
    } else if (t == 'audio:error') {
      _emitToast((d['message'] ?? '电脑端开启声音失败').toString());
    } else if (t == 'host:secure_desktop') {
      final nextActive = d['active'] == true;
      final nextElevated = d['elevatedConnected'] == true;
      if (nextActive != hostInSecureDesktop || nextElevated != hostElevatedConnected) {
        hostInSecureDesktop = nextActive;
        hostElevatedConnected = nextElevated;
        notifyListeners();
      }
    }
  }

  Future<void> _collectAndSendRxDiag() async {
    if (_pc == null) return;
    try {
      final stats = await _pc!.getStats();
      StatsReport? inStat;
      for (final s in stats) {
        if (s.type == 'inbound-rtp') {
          final kind = (s.values['kind'] ?? s.values['mediaType'] ?? '').toString();
          if (kind == 'video') {
            inStat = s;
            break;
          }
        }
      }
      if (inStat == null) return;

      final v = inStat.values;
      double? rxFps = (v['framesPerSecond'] as num?)?.toDouble();
      double? decodeMs;
      int? jbMs;
      int? jbTargetStatMs;
      int? jbMinMs;

      final framesDec = (v['framesDecoded'] as num?)?.toInt() ?? 0;
      final totDec = (v['totalDecodeTime'] as num?)?.toDouble() ?? 0.0;
      final jbEmit = (v['jitterBufferEmittedCount'] as num?)?.toInt() ?? 0;
      final jbDel = (v['jitterBufferDelay'] as num?)?.toDouble() ?? 0.0;
      final jbTDel = (v['jitterBufferTargetDelay'] as num?)?.toDouble();
      final jbMDel = (v['jitterBufferMinimumDelay'] as num?)?.toDouble();

      if (_prevInSnap != null) {
        final dt = (inStat.timestamp - _prevInSnap!.ts) / 1000.0;
        final dF = framesDec - _prevInSnap!.framesDecoded;
        final dDecT = totDec - _prevInSnap!.totalDecodeTime;
        final dEmit = jbEmit - _prevInSnap!.jbEmit;

        if (dt > 0 && dF >= 0) {
          rxFps = dF / dt;
          if (dF > 0 && dDecT >= 0) {
            decodeMs = (dDecT / dF) * 1000.0;
          }
        }
        if (dEmit >= 5) {
          final dJb = jbDel - _prevInSnap!.jbDelay;
          if (dJb >= 0) jbMs = (dJb / dEmit * 1000.0).round();
          if (jbTDel != null && _prevInSnap!.jbTargetDelay != null) {
            final dT = jbTDel - _prevInSnap!.jbTargetDelay!;
            if (dT >= 0) jbTargetStatMs = (dT / dEmit * 1000.0).round();
          }
          if (jbMDel != null && _prevInSnap!.jbMinDelay != null) {
            final dM = jbMDel - _prevInSnap!.jbMinDelay!;
            if (dM >= 0) jbMinMs = (dM / dEmit * 1000.0).round();
          }
        }
      }

      _prevInSnap = _PrevInSnap(
        ts: inStat.timestamp,
        framesDecoded: framesDec,
        totalDecodeTime: totDec,
        jbEmit: jbEmit,
        jbDelay: jbDel,
        jbTargetDelay: jbTDel,
        jbMinDelay: jbMDel,
      );

      final decoderImpl = v['decoderImplementation']?.toString() ?? '';
      final rxHw = v['powerEfficientDecoder'] is bool ? v['powerEfficientDecoder'] as bool : null;
      final dropped = (v['framesDropped'] as num?)?.toInt() ?? 0;
      final freezes = (v['freezeCount'] as num?)?.toInt() ?? 0;
      final dropBurst = _prevRxDropped != null && (dropped - _prevRxDropped!) >= 3;
      final freezeBurst = _prevRxFreezes != null && freezes > _prevRxFreezes!;
      _prevRxDropped = dropped;
      _prevRxFreezes = freezes;
      if (dropBurst || freezeBurst) {
        final now = DateTime.now();
        if (now.difference(_lastPliSentAt).inMilliseconds >= 300) {
          _lastPliSentAt = now;
          sendReliable({'t': 'video:pli'});
        }
      }
      final rxW = (v['frameWidth'] as num?)?.toInt() ?? remoteRenderer.videoWidth;
      final rxH = (v['frameHeight'] as num?)?.toInt() ?? remoteRenderer.videoHeight;

      final roundedRxFps = rxFps != null ? double.parse(rxFps.toStringAsFixed(1)) : null;
      final roundedDecodeMs = decodeMs != null ? double.parse(decodeMs.toStringAsFixed(2)) : null;

      telemetry = telemetry.copyWithRx(
        rxFps: roundedRxFps,
        decodeMs: roundedDecodeMs,
        decoder: decoderImpl,
        rxHw: rxHw,
        jbMs: jbMs,
        jbTargetMs: jbTargetStatMs,
        jbMinMs: jbMinMs,
        jbSettingMs: jbSettingMs,
        dropped: dropped,
        freezes: freezes,
        rxW: rxW,
        rxH: rxH,
      );
      notifyListeners();

      sendReliable({
        't': 'diag:rx',
        'rxFps': roundedRxFps ?? 0,
        'decodeMs': roundedDecodeMs,
        'decoder': decoderImpl.isEmpty ? null : decoderImpl,
        'hw': rxHw,
        'jbMs': jbMs,
        'jbTargetMs': jbTargetStatMs,
        'jbMinMs': jbMinMs,
        'jbSettingMs': jbSettingMs,
        'dropped': dropped,
        'freezes': freezes,
        'w': rxW,
        'h': rxH,
      });
    } catch (_) {}
  }

  static const Set<String> _orderedInputTypes = {
    'm:btn',
    'm:abs',
    'm:rel',
    'm:whl',
    'k:down',
    'k:up',
    'k:release_all',
    'text:unicode',
    'sys:sas',
  };

  void _clearPendingPointer() {
    _pointerFlushTimer?.cancel();
    _pointerFlushTimer = null;
    _pendingPointerType = null;
    _pendingRelDx = 0;
    _pendingRelDy = 0;
    _pendingAbsX = null;
    _pendingAbsY = null;
    _pendingWhlDx = 0;
    _pendingWhlDy = 0;
  }

  void _sendReliableRaw(Map<String, dynamic> payload) {
    final dc = _reliableDc;
    if (dc != null && dc.state == RTCDataChannelState.RTCDataChannelOpen) {
      dc.send(RTCDataChannelMessage(jsonEncode(payload)));
    }
  }

  void _sendFastImmediate(Map<String, dynamic> payload, {bool viaReliable = false}) {
    _lastPointerSentAtMs = DateTime.now().millisecondsSinceEpoch;
    if (viaReliable) {
      _sendReliableRaw(payload);
      return;
    }
    final dc = _unreliableDc;
    if (dc != null && dc.state == RTCDataChannelState.RTCDataChannelOpen) {
      dc.send(RTCDataChannelMessage(jsonEncode(payload)));
    } else {
      _sendReliableRaw(payload);
    }
  }

  void flushPendingPointer({bool viaReliable = false}) {
    _pointerFlushTimer?.cancel();
    _pointerFlushTimer = null;
    final pType = _pendingPointerType;
    if (pType == null) return;
    _pendingPointerType = null;

    if (pType == 'm:rel') {
      final dx = _pendingRelDx;
      final dy = _pendingRelDy;
      _pendingRelDx = 0;
      _pendingRelDy = 0;
      if (dx != 0 || dy != 0) {
        _sendFastImmediate({'t': 'm:rel', 'dx': dx, 'dy': dy}, viaReliable: viaReliable);
      }
    } else if (pType == 'm:abs') {
      final x = _pendingAbsX;
      final y = _pendingAbsY;
      _pendingAbsX = null;
      _pendingAbsY = null;
      if (x != null && y != null) {
        _sendFastImmediate({'t': 'm:abs', 'x': x, 'y': y}, viaReliable: viaReliable);
      }
    } else if (pType == 'm:whl') {
      final dx = _pendingWhlDx;
      final dy = _pendingWhlDy;
      _pendingWhlDx = 0;
      _pendingWhlDy = 0;
      if (dx != 0 || dy != 0) {
        _sendFastImmediate(
          {'t': 'm:whl', if (dx != 0) 'dx': dx, if (dy != 0) 'dy': dy},
          viaReliable: viaReliable,
        );
      }
    }
  }

  void sendReliable(Map<String, dynamic> payload) {
    final t = (payload['t'] ?? '').toString();
    if (_orderedInputTypes.contains(t)) {
      flushPendingPointer(viaReliable: true);
    }
    _sendReliableRaw(payload);
  }

  void sendPointerFast(Map<String, dynamic> payload) {
    final t = (payload['t'] ?? '').toString();
    if (t != 'm:rel' && t != 'm:abs' && t != 'm:whl') {
      flushPendingPointer();
      _sendFastImmediate(payload);
      return;
    }

    if (_pendingPointerType != null && _pendingPointerType != t) {
      flushPendingPointer();
    }

    final nowMs = DateTime.now().millisecondsSinceEpoch;
    final elapsed = nowMs - _lastPointerSentAtMs;
    if (_pendingPointerType == null &&
        _pointerFlushTimer == null &&
        elapsed >= _pointerCoalesceMs) {
      _sendFastImmediate(payload);
      return;
    }

    _pendingPointerType = t;
    if (t == 'm:rel') {
      _pendingRelDx += (payload['dx'] as num?)?.toDouble() ?? 0.0;
      _pendingRelDy += (payload['dy'] as num?)?.toDouble() ?? 0.0;
    } else if (t == 'm:abs') {
      final x = (payload['x'] as num?)?.toDouble();
      final y = (payload['y'] as num?)?.toDouble();
      if (x != null && y != null) {
        _pendingAbsX = x;
        _pendingAbsY = y;
      }
    } else if (t == 'm:whl') {
      _pendingWhlDx += (payload['dx'] as num?)?.toDouble() ?? 0.0;
      _pendingWhlDy += (payload['dy'] as num?)?.toDouble() ?? 0.0;
    }

    if (_pointerFlushTimer == null) {
      final waitMs = (_pointerCoalesceMs - elapsed).clamp(1, _pointerCoalesceMs);
      _pointerFlushTimer = Timer(Duration(milliseconds: waitMs), () {
        flushPendingPointer();
      });
    }
  }

  void sendPolicy({
    required String preset,
    required String resolution,
    required int fps,
    required int maxBitrateKbps,
    String? contentHint,
  }) {
    sendReliable({
      't': 'policy',
      'preset': preset,
      'resolution': resolution,
      'fps': fps,
      'maxBitrateKbps': maxBitrateKbps,
      'contentHint': ?contentHint,
    });
  }

  void switchDisplay(String displayId) {
    activeDisplayId = displayId;
    sendReliable({'t': 'display:switch', 'displayId': displayId});
    notifyListeners();
  }

  void requestHostAudio(bool enabled) {
    sendReliable({'t': 'audio:set', 'enabled': enabled});
    _emitToast(enabled ? '正在开启电脑声音同步...' : '正在关闭电脑声音，切回纯画面...');
  }

  void toggleAudioMute() {
    audioMuted = !audioMuted;
    final remoteTrack = _remoteAudioTrack;
    if (remoteTrack != null) {
      remoteTrack.enabled = !audioMuted;
    }
    final stream = remoteRenderer.srcObject;
    if (stream != null) {
      for (final t in stream.getAudioTracks()) {
        t.enabled = !audioMuted;
      }
    }
    notifyListeners();
  }

  Future<void> sendLocalFile(PickedLocalFile file) => _fileTransfer.sendLocalFile(file);

  Future<void> _cleanupRtc() async {
    _iceRestartTimer?.cancel();
    _iceRestartTimer = null;
    _iceRestartWatchdogTimer?.cancel();
    _iceRestartWatchdogTimer = null;
    _pendingIceRestartTimer?.cancel();
    _pendingIceRestartTimer = null;
    _pendingIceRestartAfterWs = false;
    _lastIceConnectionState = null;
    _iceRestartAttempts = 0;
    _iceRestartInFlight = false;
    _clearPendingPointer();
    _lastPointerSentAtMs = 0;
    _pingTimer?.cancel();
    _pingTimer = null;
    _diagTimer?.cancel();
    _diagTimer = null;
    _prevInSnap = null;
    _prevRxDropped = null;
    _prevRxFreezes = null;
    _lastPliSentAt = DateTime.fromMillisecondsSinceEpoch(0);
    remoteCursorNorm.value = null;
    _remoteAudioTrack = null;
    hostInSecureDesktop = false;
    hostElevatedConnected = false;
    telemetry = const TelemetrySnapshot();
    _pendingRemoteIce.clear();
    await _fileTransfer.cleanup();
    try {
      await _reliableDc?.close();
    } catch (_) {}
    _reliableDc = null;
    try {
      await _unreliableDc?.close();
    } catch (_) {}
    _unreliableDc = null;
    try {
      await _pc?.close();
    } catch (_) {}
    _pc = null;
    if (_rendererInitialized) {
      remoteRenderer.srcObject = null;
    }
    final oldFallback = _fallbackRemoteStream;
    _fallbackRemoteStream = null;
    if (oldFallback != null) {
      try {
        await oldFallback.dispose();
      } catch (_) {}
    }
  }

  Future<void> disconnect({bool silent = false, bool resetOfflineRetry = true}) async {
    _manualDisconnect = true;
    _pendingAuthPassword = null;
    _activeSessionToken = null;
    _wsSilentReconnecting = false;
    _wsSilentReconnectAttempt = 0;
    _wsSilentReconnectTimer?.cancel();
    _wsSilentReconnectTimer = null;
    if (resetOfflineRetry) {
      _hostOfflineRetryCount = 0;
    }
    _hostOfflineRetryTimer?.cancel();
    _hostOfflineRetryTimer = null;
    _wsGen++;
    _rtcGen++;
    _clearPendingPointer();
    _clearWsPongTimeout();
    _wsHeartbeatTimer?.cancel();
    _wsHeartbeatTimer = null;
    sendReliable({'t': 'k:release_all', 'reason': 'android_client_disconnect'});
    if (_ws != null) {
      _sendWs({'type': 'session:close', 'reason': '客户端主动断开'});
      try {
        await _ws!.close();
      } catch (_) {}
      _ws = null;
    }
    await _cleanupRtc();
    if (!silent) {
      _setPhase(SessionPhase.idle, '已断开');
    }
  }

  Future<void> verifyAliveOnResume() async {
    if (_manualDisconnect || phase != SessionPhase.connected) return;
    final dc = _reliableDc;
    final wsOpen = _ws != null;
    if (dc == null || dc.state != RTCDataChannelState.RTCDataChannelOpen || !wsOpen) {
      await reconnectSaved();
      return;
    }
    final probeStartedAt = DateTime.now().millisecondsSinceEpoch;
    sendReliable({'t': 'ping', 'ts': probeStartedAt});
    await Future<void>.delayed(const Duration(milliseconds: 2200));
    if (_manualDisconnect || phase != SessionPhase.connected) return;
    if (_lastRxAliveAtMs < probeStartedAt) {
      await reconnectSaved();
    }
  }

  Future<void> reconnectSaved() async {
    if (_activeSignalingUrl != null && _activeSignalingUrl!.isNotEmpty) {
      final baseKey = tokenKeyForEndpoint(signalingUrl: _activeSignalingUrl);
      final hostId = (_activeHostId != null && _activeHostId!.trim().isNotEmpty)
          ? _activeHostId!.trim()
          : await storage.getHostIdForKey(baseKey);
      final tok = await storage.getTokenForRelay(baseKey, hostId: hostId);
      if (tok != null && tok.isNotEmpty) {
        await connect(
          signalingUrl: _activeSignalingUrl,
          customIceRaw: _activeCustomIceRaw,
          sessionToken: tok,
          hostId: hostId,
        );
      }
      return;
    }
    if (_activeHostIp == null) return;
    final tok = await storage.getTokenForHost(_activeHostIp!, _activeHostPort);
    if (tok != null && tok.isNotEmpty) {
      await connect(
        hostIp: _activeHostIp!,
        port: _activeHostPort,
        sessionToken: tok,
      );
    }
  }

  @override
  void dispose() {
    final wasInit = _rendererInitialized;
    _rendererInitialized = false;
    disconnect(silent: true);
    if (wasInit) {
      remoteRenderer.dispose();
    }
    remoteCursorNorm.dispose();
    _toastCtrl.close();
    _clipboardCtrl.close();
    super.dispose();
  }
}
