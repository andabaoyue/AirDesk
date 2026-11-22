import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' show Offset;
import 'package:flutter/foundation.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import '../models/airdesk_models.dart';
import 'native_bridge.dart';
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
  RTCDataChannel? _fileDc;

  static const int _fileChunkBytes = 16384;
  static const int _maxFileBytes = 500 * 1024 * 1024;
  bool _sendingFile = false;
  String? _pendingOfferId;
  Completer<void>? _pendingOfferCompleter;
  String? _pendingAckId;
  Completer<Map<String, dynamic>>? _pendingAckCompleter;
  String? _incomingFileId;
  String? _incomingFileName;
  String? _incomingFileMime;
  int _incomingFileTotal = 0;
  int _incomingFileReceived = 0;
  File? _incomingTempFile;
  IOSink? _incomingSink;
  DateTime _lastFileUiNotifyAt = DateTime.fromMillisecondsSinceEpoch(0);
  Future<void> _incomingFileChain = Future<void>.value();

  FileTransferProgress? activeFileTransfer;
  final List<FileTransferProgress> recentTransfers = [];
  bool get fileChannelReady =>
      _fileDc != null && _fileDc!.state == RTCDataChannelState.RTCDataChannelOpen;

  Timer? _pingTimer;
  Timer? _diagTimer;
  Timer? _wsHeartbeatTimer;
  _PrevInSnap? _prevInSnap;
  int? _prevRxDropped;
  int? _prevRxFreezes;
  DateTime _lastPliSentAt = DateTime.fromMillisecondsSinceEpoch(0);
  final List<RTCIceCandidate> _pendingRemoteIce = [];

  final ValueNotifier<Offset?> remoteCursorNorm = ValueNotifier<Offset?>(null);

  bool _rendererInitialized = false;
  bool _manualDisconnect = false;
  int _wsGen = 0;
  int _rtcGen = 0;
  String? _activeHostIp;
  int _activeHostPort = 47820;
  String? _activeSignalingUrl;
  String? _activeCustomIceRaw;
  List<Map<String, dynamic>> _activeIceServers = const [];

  SessionPhase phase = SessionPhase.idle;
  String statusMessage = '未连接';
  String hostLabel = '';
  bool controlEnabled = false;
  bool hostAudioEnabled = false;
  bool audioMuted = true;
  int? lastRttMs;
  int jbSettingMs = 0;

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
  }) {
    final s = signalingUrl?.trim() ?? '';
    if (s.isNotEmpty) {
      try {
        final wsUrl = normalizeRelayWsUrl(s);
        final uri = Uri.parse(wsUrl);
        final effectivePort = uri.hasPort ? uri.port : (uri.scheme == 'wss' ? 443 : 80);
        return 'relay:${uri.host}:$effectivePort';
      } catch (_) {
        return 'relay:$s';
      }
    }
    return '$hostIp:$port';
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

  Future<void> connect({
    String hostIp = '',
    int port = 47820,
    String? signalingUrl,
    String? customIceRaw,
    String? pinCode,
    String? sessionToken,
    List<String> iceStunUrls = const [],
  }) async {
    await ensureRendererReady();
    await disconnect(silent: true);

    final relayUrl = signalingUrl?.trim() ?? '';
    final isRelayMode = relayUrl.isNotEmpty;
    final cleanHostIp = hostIp.trim();
    final tokenKey = tokenKeyForEndpoint(
      hostIp: cleanHostIp,
      port: port,
      signalingUrl: isRelayMode ? relayUrl : null,
    );

    _manualDisconnect = false;
    final myWsGen = ++_wsGen;
    _activeHostIp = isRelayMode ? null : cleanHostIp;
    _activeHostPort = port;
    _activeSignalingUrl = isRelayMode ? relayUrl : null;
    _activeCustomIceRaw = customIceRaw?.trim();

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
      _wsHeartbeatTimer = Timer.periodic(const Duration(seconds: 25), (_) {
        _sendWs({'type': 'ws:ping', 'ts': DateTime.now().millisecondsSinceEpoch});
      });
    }

    sock.listen(
      (raw) {
        if (_ws != sock || _wsGen != myWsGen) return;
        _handleWsMessage(
          raw,
          cleanHostIp,
          port,
          iceStunUrls,
          tokenKey: tokenKey,
          isRelayMode: isRelayMode,
          customIceRaw: customIceRaw,
          hadToken: sessionToken != null,
        );
      },
      onError: (err) {
        if (_ws != sock || _wsGen != myWsGen) return;
        _wsHeartbeatTimer?.cancel();
        _wsHeartbeatTimer = null;
        if (!_manualDisconnect) {
          _setPhase(SessionPhase.error, '信令连接异常：$err');
        }
      },
      onDone: () {
        if (_ws != sock || _wsGen != myWsGen) return;
        _wsHeartbeatTimer?.cancel();
        _wsHeartbeatTimer = null;
        if (!_manualDisconnect && phase != SessionPhase.error) {
          _cleanupRtc();
          _setPhase(SessionPhase.disconnected, '信令连接已断开');
        }
      },
    );

    final joinPayload = <String, dynamic>{
      'type': 'client:join',
      'deviceLabel': deviceLabel,
      'platformHint': 'Android App',
    };
    if (sessionToken != null && sessionToken.isNotEmpty) {
      joinPayload['sessionToken'] = sessionToken;
    } else {
      joinPayload['code'] = (pinCode ?? '').replaceAll(RegExp(r'\D'), '');
    }
    _sendWs(joinPayload);
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
    required bool isRelayMode,
    String? customIceRaw,
    required bool hadToken,
  }) async {
    Map<String, dynamic> msg;
    try {
      msg = jsonDecode(raw.toString()) as Map<String, dynamic>;
    } catch (_) {
      return;
    }

    final type = (msg['type'] ?? '').toString();
    if (type == 'ws:pong') {
      return;
    } else if (type == 'client:waiting_approval') {
      hostLabel = (msg['hostLabel'] ?? (isRelayMode ? '远程电脑' : hostIp)).toString();
      _setPhase(SessionPhase.waitingApproval, '等待电脑审批（可在电脑按 Ctrl+Alt+Y 批准）...');
    } else if (type == 'client:rejected' || type == 'error') {
      if (hadToken) {
        await storage.removeTokenForKey(tokenKey);
      }
      final reason = (msg['reason'] ?? msg['message'] ?? '连接被拒绝').toString();
      _setPhase(SessionPhase.error, reason);
    } else if (type == 'client:approved') {
      hostLabel = (msg['hostLabel'] ?? (isRelayMode ? '远程电脑' : hostIp)).toString();
      controlEnabled = msg['mode'] == 'full_control';
      hostAudioEnabled = msg['audioEnabled'] == true;
      audioMuted = !hostAudioEnabled;
      final newToken = (msg['sessionToken'] ?? '').toString();
      if (newToken.isNotEmpty) {
        await storage.saveTokenForKey(tokenKey, newToken);
      }
      if (!isRelayMode && hostIp.isNotEmpty) {
        await storage.saveRecentHost(hostIp, port, hostLabel);
      }
      final iceServers = _resolveIceServers(
        isRelayMode: isRelayMode,
        iceStunUrls: iceStunUrls,
        serverIceRaw: msg['iceServers'],
        customIceRaw: customIceRaw,
      );
      _activeIceServers = iceServers;
      await _startRtc(iceServers, wantAudio: hostAudioEnabled);
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

  Future<void> _startRtc(
    List<Map<String, dynamic>> iceServers, {
    bool wantAudio = false,
  }) async {
    final myRtcGen = ++_rtcGen;
    await _cleanupRtc();
    if (_manualDisconnect || _rtcGen != myRtcGen) return;
    _setPhase(SessionPhase.negotiatingRtc, '正在建立超低延迟 WebRTC 视频通道...');

    final config = <String, dynamic>{
      'iceServers': iceServers,
      'sdpSemantics': 'unified-plan',
      'bundlePolicy': 'max-bundle',
      'rtcpMuxPolicy': 'require',
    };
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
      if (state == RTCIceConnectionState.RTCIceConnectionStateConnected ||
          state == RTCIceConnectionState.RTCIceConnectionStateCompleted) {
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
      } else if (state == RTCIceConnectionState.RTCIceConnectionStateFailed ||
          state == RTCIceConnectionState.RTCIceConnectionStateDisconnected) {
        if (!_manualDisconnect) {
          _setPhase(SessionPhase.disconnected, '视频通道中断 (${state.name})');
        }
      }
    };

    pc.onTrack = (RTCTrackEvent event) {
      if (isStale()) return;
      if (event.track.kind == 'audio') {
        event.track.enabled = !audioMuted;
        return;
      }
      if (event.track.kind != 'video') return;
      if (event.streams.isNotEmpty) {
        remoteRenderer.srcObject = event.streams[0];
        notifyListeners();
      } else {
        createLocalMediaStream('airdesk_remote').then((s) {
          if (isStale()) return;
          s.addTrack(event.track);
          remoteRenderer.srcObject = s;
          notifyListeners();
        });
      }
    };

    pc.onIceCandidate = (RTCIceCandidate candidate) {
      if (isStale()) return;
      final cs = candidate.candidate ?? '';
      if (_isVirtualCandidate(cs)) return;
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
    if (wantAudio) {
      await pc.addTransceiver(
        kind: RTCRtpMediaType.RTCRtpMediaTypeAudio,
        init: RTCRtpTransceiverInit(direction: TransceiverDirection.RecvOnly),
      );
      if (isStale()) return;
    }

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
    _fileDc = fileDc;

    fileDc.onDataChannelState = (state) {
      if (isStale()) return;
      if (state == RTCDataChannelState.RTCDataChannelClosed) {
        _abortFileTransferWaiters('文件传输通道已关闭');
      }
      notifyListeners();
    };
    fileDc.onMessage = (RTCDataChannelMessage message) {
      if (isStale()) return;
      _incomingFileChain = _incomingFileChain
          .then((_) => _handleFileDcMessage(message))
          .catchError((_) {});
    };

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
    final preferredSdp = _prioritizeVideoCodecsInSdp(offer.sdp ?? '', preferHevc: preferHevc);
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
          _emitToast(
            hostAudioEnabled
                ? '电脑已开启声音，正在无感重连同步...'
                : '电脑已关闭声音，正在切回纯画面...',
          );
          if (_ws != null) {
            unawaited(_startRtc(_activeIceServers, wantAudio: hostAudioEnabled));
          } else {
            unawaited(reconnectSaved());
          }
        }
      }
    } else if (t == 'pong' && d['ts'] is num) {
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
    }
  }

  bool _isVirtualCandidate(String candStr) {
    final parts = candStr.split(' ');
    if (parts.length < 5) return false;
    final addr = parts[4];
    if (RegExp(r'^198\.1[89]\.').hasMatch(addr)) return true;
    if (RegExp(r'^172\.19\.').hasMatch(addr)) return true;
    return false;
  }

  /// Reorders the m=video SDP payload types so H.265/HEVC (when [preferHevc] is enabled)
  /// or H.264 (preferring Constrained Baseline 42e01f > 42001f) is listed first,
  /// ensuring Android MediaCodec hardware decoding engages consistently.
  String _prioritizeVideoCodecsInSdp(String sdp, {bool preferHevc = false}) {
    if (sdp.isEmpty) return sdp;
    final eol = sdp.contains('\r\n') ? '\r\n' : '\n';
    final lines = sdp.split(RegExp(r'\r?\n'));
    bool inVideo = false;
    int mLineIdx = -1;
    final Map<String, String> rtpmap = {};
    final Map<String, String> fmtp = {};
    final Map<String, String> rtxApt = {};

    for (var i = 0; i < lines.length; i++) {
      final line = lines[i];
      if (line.startsWith('m=')) {
        inVideo = line.startsWith('m=video ');
        if (inVideo) mLineIdx = i;
        continue;
      }
      if (!inVideo) continue;
      final rm = RegExp(r'^a=rtpmap:(\d+)\s+([^\s]+)').firstMatch(line);
      if (rm != null) {
        rtpmap[rm.group(1)!] = rm.group(2)!.toLowerCase();
        continue;
      }
      final fm = RegExp(r'^a=fmtp:(\d+)\s+(.+)$').firstMatch(line);
      if (fm != null) {
        final pt = fm.group(1)!;
        final val = fm.group(2)!.toLowerCase();
        fmtp[pt] = val;
        final aptMatch = RegExp(r'apt=(\d+)').firstMatch(val);
        if (aptMatch != null) {
          rtxApt[aptMatch.group(1)!] = pt;
        }
      }
    }

    if (mLineIdx < 0) return sdp;
    final parts = lines[mLineIdx].trim().split(RegExp(r'\s+'));
    if (parts.length <= 4) return sdp;
    final header = parts.take(3).toList();
    final pts = parts.skip(3).toList();

    final hevcPts = <String>[];
    final h264Pts = <String>[];
    final otherPts = <String>[];
    final associatedRtx = <String>{};

    for (final pt in pts) {
      final codec = rtpmap[pt] ?? '';
      if (codec.startsWith('h265/') || codec.startsWith('hevc/')) {
        hevcPts.add(pt);
        if (rtxApt.containsKey(pt)) associatedRtx.add(rtxApt[pt]!);
      } else if (codec.startsWith('h264/')) {
        h264Pts.add(pt);
        if (rtxApt.containsKey(pt)) associatedRtx.add(rtxApt[pt]!);
      }
    }
    if (h264Pts.isEmpty && (!preferHevc || hevcPts.isEmpty)) return sdp;

    int scorePt(String pt) {
      final f = fmtp[pt] ?? '';
      if (f.contains('42e01f')) return 0;
      if (f.contains('42001f')) return 1;
      if (f.contains('42e0') || f.contains('4200')) return 2;
      return 3;
    }

    h264Pts.sort((a, b) => scorePt(a).compareTo(scorePt(b)));

    final orderedHevcWithRtx = <String>[];
    if (preferHevc) {
      for (final pt in hevcPts) {
        orderedHevcWithRtx.add(pt);
        if (rtxApt.containsKey(pt)) orderedHevcWithRtx.add(rtxApt[pt]!);
      }
    }

    final orderedH264WithRtx = <String>[];
    for (final pt in h264Pts) {
      orderedH264WithRtx.add(pt);
      if (rtxApt.containsKey(pt)) orderedH264WithRtx.add(rtxApt[pt]!);
    }

    for (final pt in pts) {
      final isIncludedHevc = preferHevc && hevcPts.contains(pt);
      final isIncludedH264 = h264Pts.contains(pt);
      final isIncludedRtx = associatedRtx.contains(pt) &&
          (preferHevc || !hevcPts.any((hp) => rtxApt[hp] == pt));
      if (!isIncludedHevc && !isIncludedH264 && !isIncludedRtx) {
        otherPts.add(pt);
      }
    }

    lines[mLineIdx] = [
      ...header,
      ...orderedHevcWithRtx,
      ...orderedH264WithRtx,
      ...otherPts,
    ].join(' ');
    return _ensurePlayoutDelayExtInSdp(lines.join(eol));
  }

  static const _playoutDelayExtUri =
      'http://www.webrtc.org/experiments/rtp-hdrext/playout-delay';

  String _ensurePlayoutDelayExtInSdp(String sdp) {
    if (sdp.isEmpty) return sdp;
    final eol = sdp.contains('\r\n') ? '\r\n' : '\n';
    final lines = sdp.split(RegExp(r'\r?\n'));
    final usedIds = <int>{};
    bool inVideo = false;
    int videoStartIdx = -1;
    int videoEndIdx = lines.length;
    int lastVideoExtIdx = -1;
    int firstVideoRtpmapIdx = -1;

    for (var i = 0; i < lines.length; i++) {
      final line = lines[i];
      final em = RegExp(r'^a=extmap:(\d+)(?:/[^\s]+)?\s+(\S+)', caseSensitive: false)
          .firstMatch(line);
      if (em != null) {
        final id = int.tryParse(em.group(1)!);
        if (id != null) usedIds.add(id);
        if (inVideo) {
          lastVideoExtIdx = i;
          if (em.group(2)!.toLowerCase() == _playoutDelayExtUri) {
            return sdp;
          }
        }
        continue;
      }
      if (line.startsWith('m=')) {
        if (inVideo && videoEndIdx == lines.length) {
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

    if (videoStartIdx < 0) return sdp;
    int? chosenId;
    for (var id = 1; id <= 14; id++) {
      if (!usedIds.contains(id)) {
        chosenId = id;
        break;
      }
    }
    if (chosenId == null) return sdp;

    final insertAt = lastVideoExtIdx >= 0
        ? lastVideoExtIdx + 1
        : (firstVideoRtpmapIdx >= 0 ? firstVideoRtpmapIdx : videoEndIdx);
    lines.insert(insertAt, 'a=extmap:$chosenId $_playoutDelayExtUri');
    return lines.join(eol);
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

  void sendReliable(Map<String, dynamic> payload) {
    final dc = _reliableDc;
    if (dc != null && dc.state == RTCDataChannelState.RTCDataChannelOpen) {
      dc.send(RTCDataChannelMessage(jsonEncode(payload)));
    }
  }

  void sendPointerFast(Map<String, dynamic> payload) {
    final dc = _unreliableDc;
    if (dc != null && dc.state == RTCDataChannelState.RTCDataChannelOpen) {
      dc.send(RTCDataChannelMessage(jsonEncode(payload)));
    } else {
      sendReliable(payload);
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
    final stream = remoteRenderer.srcObject;
    if (stream != null) {
      for (final t in stream.getAudioTracks()) {
        t.enabled = !audioMuted;
      }
    }
    notifyListeners();
  }

  void _sendFileJson(Map<String, dynamic> obj) {
    final dc = _fileDc;
    if (dc != null && dc.state == RTCDataChannelState.RTCDataChannelOpen) {
      dc.send(RTCDataChannelMessage(jsonEncode(obj)));
    }
  }

  void _abortFileTransferWaiters(String reason) {
    if (_pendingOfferCompleter != null && !_pendingOfferCompleter!.isCompleted) {
      _pendingOfferCompleter!.completeError(StateError(reason));
    }
    _pendingOfferCompleter = null;
    _pendingOfferId = null;

    if (_pendingAckCompleter != null && !_pendingAckCompleter!.isCompleted) {
      _pendingAckCompleter!.completeError(StateError(reason));
    }
    _pendingAckCompleter = null;
    _pendingAckId = null;
  }

  void _recordTransferHistory(FileTransferProgress item) {
    recentTransfers.insert(0, item);
    if (recentTransfers.length > 8) {
      recentTransfers.removeRange(8, recentTransfers.length);
    }
  }

  Future<void> _closeIncomingTemp({bool deleteFile = true}) async {
    final sink = _incomingSink;
    _incomingSink = null;
    if (sink != null) {
      try {
        await sink.flush();
      } catch (_) {}
      try {
        await sink.close();
      } catch (_) {}
    }
    final tf = _incomingTempFile;
    _incomingTempFile = null;
    if (deleteFile && tf != null) {
      try {
        if (await tf.exists()) await tf.delete();
      } catch (_) {}
    }
    _incomingFileId = null;
    _incomingFileName = null;
    _incomingFileMime = null;
    _incomingFileTotal = 0;
    _incomingFileReceived = 0;
  }

  Future<void> _deleteTempFileSilently(String path) async {
    try {
      final f = File(path);
      if (await f.exists()) await f.delete();
    } catch (_) {}
  }

  Future<void> sendLocalFile(PickedLocalFile file) async {
    if (!fileChannelReady) {
      await _deleteTempFileSilently(file.path);
      _emitToast('文件传输通道尚未就绪，请先建立连接');
      return;
    }
    if (_sendingFile) {
      await _deleteTempFileSilently(file.path);
      _emitToast('当前正在发送文件，请等待完成');
      return;
    }
    if (file.size > _maxFileBytes) {
      await _deleteTempFileSilently(file.path);
      _emitToast('文件过大，单文件上限为 500MB');
      return;
    }

    _sendingFile = true;
    final transferId = 'mob_${DateTime.now().millisecondsSinceEpoch}';
    var progressItem = FileTransferProgress(
      id: transferId,
      name: file.name,
      totalBytes: file.size,
      transferredBytes: 0,
      isOutgoing: true,
      state: FileTransferState.negotiating,
      message: '等待电脑确认接收...',
    );
    activeFileTransfer = progressItem;
    notifyListeners();

    try {
      final offerCompleter = Completer<void>();
      _pendingOfferId = transferId;
      _pendingOfferCompleter = offerCompleter;

      _sendFileJson({
        't': 'file:offer',
        'id': transferId,
        'name': file.name,
        'size': file.size,
        'mime': file.mime,
      });

      await offerCompleter.future.timeout(
        const Duration(seconds: 10),
        onTimeout: () => throw TimeoutException('电脑端响应超时'),
      );

      progressItem = progressItem.copyWith(
        state: FileTransferState.transferring,
        message: '正在发送至电脑...',
      );
      activeFileTransfer = progressItem;
      notifyListeners();

      var sentBytes = 0;
      var chunkCounter = 0;
      var lastUiMs = 0;
      final srcFile = File(file.path);
      await for (final data in srcFile.openRead()) {
        final u8 = data is Uint8List ? data : Uint8List.fromList(data);
        var offset = 0;
        while (offset < u8.length) {
          if (!fileChannelReady) {
            throw StateError('文件传输通道已断开');
          }
          final end = (offset + _fileChunkBytes <= u8.length)
              ? offset + _fileChunkBytes
              : u8.length;
          final slice = Uint8List.sublistView(u8, offset, end);
          await _fileDc!.send(RTCDataChannelMessage.fromBinary(slice));
          offset = end;
          sentBytes += slice.length;
          chunkCounter++;

          if (chunkCounter % 8 == 0) {
            try {
              var buffered = await _fileDc!.getBufferedAmount();
              while (buffered > 524288 && fileChannelReady) {
                await Future<void>.delayed(const Duration(milliseconds: 15));
                buffered = await _fileDc!.getBufferedAmount();
              }
            } catch (_) {}
          }

          final nowMs = DateTime.now().millisecondsSinceEpoch;
          if (nowMs - lastUiMs >= 90 || sentBytes >= file.size) {
            lastUiMs = nowMs;
            progressItem = progressItem.copyWith(
              transferredBytes: sentBytes,
              message: '发送中...',
            );
            activeFileTransfer = progressItem;
            notifyListeners();
          }
        }
      }

      progressItem = progressItem.copyWith(
        transferredBytes: sentBytes,
        state: FileTransferState.finalizing,
        message: '等待电脑落盘确认...',
      );
      activeFileTransfer = progressItem;
      notifyListeners();

      final ackCompleter = Completer<Map<String, dynamic>>();
      _pendingAckId = transferId;
      _pendingAckCompleter = ackCompleter;
      _sendFileJson({'t': 'file:done', 'id': transferId, 'bytes': sentBytes});

      final ack = await ackCompleter.future.timeout(
        const Duration(seconds: 15),
        onTimeout: () => throw TimeoutException('等待电脑落盘确认超时'),
      );

      final savedName = (ack['savedName'] ?? file.name).toString();
      final savedPath = (ack['savedPath'] ?? '下载/AirDesk/$savedName').toString();
      final doneItem = progressItem.copyWith(
        transferredBytes: file.size,
        state: FileTransferState.completed,
        message: '已保存到电脑',
        savedPath: savedPath,
      );
      activeFileTransfer = null;
      _recordTransferHistory(doneItem);
      _emitToast('已发送到电脑：$savedName');
    } catch (e) {
      _sendFileJson({'t': 'file:cancel', 'id': transferId, 'reason': e.toString()});
      final failItem = progressItem.copyWith(
        state: FileTransferState.failed,
        message: e.toString(),
      );
      activeFileTransfer = null;
      _recordTransferHistory(failItem);
      _emitToast('发送失败：$e');
    } finally {
      _sendingFile = false;
      _pendingOfferId = null;
      _pendingOfferCompleter = null;
      _pendingAckId = null;
      _pendingAckCompleter = null;
      try {
        final f = File(file.path);
        if (await f.exists()) await f.delete();
      } catch (_) {}
      notifyListeners();
    }
  }

  Future<void> _handleFileDcMessage(RTCDataChannelMessage message) async {
    if (!message.isBinary) {
      Map<String, dynamic> d;
      try {
        d = jsonDecode(message.text) as Map<String, dynamic>;
      } catch (_) {
        return;
      }
      final t = (d['t'] ?? '').toString();
      final id = (d['id'] ?? '').toString();

      if (t == 'file:accept') {
        if (_pendingOfferId == id &&
            _pendingOfferCompleter != null &&
            !_pendingOfferCompleter!.isCompleted) {
          _pendingOfferCompleter!.complete();
        }
        return;
      }
      if (t == 'file:reject') {
        if (_pendingOfferId == id &&
            _pendingOfferCompleter != null &&
            !_pendingOfferCompleter!.isCompleted) {
          _pendingOfferCompleter!.completeError(
            StateError((d['reason'] ?? '电脑拒绝接收').toString()),
          );
        }
        return;
      }
      if (t == 'file:ack') {
        if (_pendingAckId == id &&
            _pendingAckCompleter != null &&
            !_pendingAckCompleter!.isCompleted) {
          if (d['ok'] == false) {
            _pendingAckCompleter!.completeError(
              StateError((d['message'] ?? '保存失败').toString()),
            );
          } else {
            _pendingAckCompleter!.complete(d);
          }
        }
        return;
      }
      if (t == 'file:cancel') {
        if (_incomingFileId != null && (id.isEmpty || id == _incomingFileId)) {
          final cancelledName = _incomingFileName ?? '文件';
          await _closeIncomingTemp(deleteFile: true);
          activeFileTransfer = null;
          _emitToast('对方取消了传输：$cancelledName');
          notifyListeners();
        }
        return;
      }
      if (t == 'file:offer') {
        final size = (d['size'] as num?)?.toInt() ?? 0;
        final name = (d['name'] ?? 'airdesk-file.bin').toString();
        final mime = (d['mime'] ?? 'application/octet-stream').toString();
        if (_incomingFileId != null) {
          _sendFileJson({'t': 'file:reject', 'id': id, 'reason': '手机正在接收另一个文件'});
          return;
        }
        if (size < 0 || size > _maxFileBytes) {
          _sendFileJson({'t': 'file:reject', 'id': id, 'reason': '文件大小超出 500MB 上限'});
          return;
        }
        try {
          final tempFile = File(
            '${Directory.systemTemp.path}/airdesk_rx_${DateTime.now().millisecondsSinceEpoch}.part',
          );
          _incomingSink = tempFile.openWrite();
          _incomingTempFile = tempFile;
          _incomingFileId = id;
          _incomingFileName = name;
          _incomingFileMime = mime;
          _incomingFileTotal = size;
          _incomingFileReceived = 0;
          activeFileTransfer = FileTransferProgress(
            id: id,
            name: name,
            totalBytes: size,
            transferredBytes: 0,
            isOutgoing: false,
            state: FileTransferState.transferring,
            message: '正在接收来自电脑的文件...',
          );
          notifyListeners();
          _sendFileJson({'t': 'file:accept', 'id': id});
        } catch (e) {
          await _closeIncomingTemp(deleteFile: true);
          _sendFileJson({'t': 'file:reject', 'id': id, 'reason': e.toString()});
        }
        return;
      }
      if (t == 'file:done') {
        if (_incomingFileId != id || _incomingTempFile == null) return;
        final fileName = _incomingFileName ?? 'airdesk-file.bin';
        final mime = _incomingFileMime ?? 'application/octet-stream';
        final total = _incomingFileTotal;
        final received = _incomingFileReceived;
        final declaredDone = (d['bytes'] as num?)?.toInt() ?? total;
        final tempFile = _incomingTempFile!;
        final sink = _incomingSink;
        _incomingSink = null;
        if (sink != null) {
          try {
            await sink.flush();
            await sink.close();
          } catch (_) {}
        }
        if (received != total || received != declaredDone) {
          await _closeIncomingTemp(deleteFile: true);
          final failItem = FileTransferProgress(
            id: id,
            name: fileName,
            totalBytes: total,
            transferredBytes: received,
            isOutgoing: false,
            state: FileTransferState.failed,
            message: '接收文件字节数不完整 ($received/$total)',
          );
          activeFileTransfer = null;
          _recordTransferHistory(failItem);
          _sendFileJson({
            't': 'file:ack',
            'id': id,
            'ok': false,
            'message': '接收文件字节数不完整',
          });
          _emitToast('接收文件失败：分片不完整');
          notifyListeners();
          return;
        }
        activeFileTransfer = activeFileTransfer?.copyWith(
          state: FileTransferState.finalizing,
          message: '正在保存到 Download/AirDesk...',
        );
        notifyListeners();

        final saved = await NativeBridge.saveFileToDownloads(
          tempPath: tempFile.path,
          fileName: fileName,
          mimeType: mime,
        );
        await _closeIncomingTemp(deleteFile: !saved.ok);
        if (saved.ok) {
          final doneItem = FileTransferProgress(
            id: id,
            name: saved.savedName,
            totalBytes: total,
            transferredBytes: total,
            isOutgoing: false,
            state: FileTransferState.completed,
            message: '已保存',
            savedPath: saved.displayPath,
          );
          activeFileTransfer = null;
          _recordTransferHistory(doneItem);
          _sendFileJson({
            't': 'file:ack',
            'id': id,
            'ok': true,
            'savedName': saved.savedName,
            'savedPath': saved.displayPath,
          });
          _emitToast('已保存文件到 ${saved.displayPath}');
        } else {
          final failItem = FileTransferProgress(
            id: id,
            name: fileName,
            totalBytes: total,
            transferredBytes: 0,
            isOutgoing: false,
            state: FileTransferState.failed,
            message: saved.error ?? '保存失败',
          );
          activeFileTransfer = null;
          _recordTransferHistory(failItem);
          _sendFileJson({
            't': 'file:ack',
            'id': id,
            'ok': false,
            'message': saved.error ?? '保存失败',
          });
          _emitToast('保存文件失败：${saved.error}');
        }
        notifyListeners();
      }
      return;
    }

    if (_incomingFileId == null || _incomingSink == null) return;
    final bytes = message.binary;
    if (_incomingFileReceived + bytes.length > _maxFileBytes) {
      final badId = _incomingFileId!;
      await _closeIncomingTemp(deleteFile: true);
      activeFileTransfer = null;
      _sendFileJson({'t': 'file:cancel', 'id': badId, 'reason': '超出大小限制'});
      notifyListeners();
      return;
    }
    _incomingSink!.add(bytes);
    _incomingFileReceived += bytes.length;
    final now = DateTime.now();
    if (now.difference(_lastFileUiNotifyAt).inMilliseconds >= 90 ||
        _incomingFileReceived >= _incomingFileTotal) {
      _lastFileUiNotifyAt = now;
      activeFileTransfer = activeFileTransfer?.copyWith(
        transferredBytes: _incomingFileReceived,
        message: '接收中...',
      );
      notifyListeners();
    }
  }

  Future<void> _cleanupRtc() async {
    _pingTimer?.cancel();
    _pingTimer = null;
    _diagTimer?.cancel();
    _diagTimer = null;
    _prevInSnap = null;
    _prevRxDropped = null;
    _prevRxFreezes = null;
    _lastPliSentAt = DateTime.fromMillisecondsSinceEpoch(0);
    remoteCursorNorm.value = null;
    _pendingRemoteIce.clear();
    _abortFileTransferWaiters('WebRTC 连接已重置');
    await _closeIncomingTemp(deleteFile: true);
    activeFileTransfer = null;
    try {
      await _reliableDc?.close();
    } catch (_) {}
    _reliableDc = null;
    try {
      await _unreliableDc?.close();
    } catch (_) {}
    _unreliableDc = null;
    try {
      await _fileDc?.close();
    } catch (_) {}
    _fileDc = null;
    try {
      await _pc?.close();
    } catch (_) {}
    _pc = null;
    if (_rendererInitialized) {
      remoteRenderer.srcObject = null;
    }
  }

  Future<void> disconnect({bool silent = false}) async {
    _manualDisconnect = true;
    _wsGen++;
    _rtcGen++;
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

  Future<void> reconnectSaved() async {
    if (_activeSignalingUrl != null && _activeSignalingUrl!.isNotEmpty) {
      final key = tokenKeyForEndpoint(signalingUrl: _activeSignalingUrl);
      final tok = await storage.getTokenForKey(key);
      if (tok != null && tok.isNotEmpty) {
        await connect(
          signalingUrl: _activeSignalingUrl,
          customIceRaw: _activeCustomIceRaw,
          sessionToken: tok,
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
