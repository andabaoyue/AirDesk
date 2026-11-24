import 'dart:async';
import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../models/airdesk_models.dart';
import '../services/native_bridge.dart';
import '../services/storage_service.dart';
import '../services/webrtc_session_service.dart';
import '../widgets/stage/stage_overlays.dart';
import '../widgets/stage/stage_secure_desktop_banner.dart';
import '../widgets/stage/stage_telemetry_hud.dart';
import '../widgets/stage/stage_video_layer.dart';

class RemoteStagePage extends StatefulWidget {
  final StorageService storage;
  final WebRtcSessionService session;

  const RemoteStagePage({
    super.key,
    required this.storage,
    required this.session,
  });

  @override
  State<RemoteStagePage> createState() => _RemoteStagePageState();
}

class _RemoteStagePageState extends State<RemoteStagePage> with WidgetsBindingObserver {
  final TransformationController _zoomCtrl = TransformationController();
  final _imeCtrl = TextEditingController();

  ScenePreset _preset = ScenePreset.officeClear;
  ViewScaleMode _scaleMode = ViewScaleMode.adaptiveFill;
  double _fillRatio = 1.0;
  InputControlMode _inputMode = InputControlMode.direct;
  String _contentHint = 'auto';
  bool _preferHevc = false;
  bool _pointerCaptureEnabled = false;
  bool _autoSyncClipboard = false;
  String _lastSyncedClip = '';
  bool _showHud = false;
  bool _drawerOpen = false;
  bool _showVkb = false;
  int _drawerTab = 0;

  // Track UI-relevant session fields so 1s ping / 2s diag updates never rebuild the whole stage
  SessionPhase _lastUiPhase = SessionPhase.idle;
  bool _lastUiControlEnabled = false;
  bool _lastUiHostAudioEnabled = false;
  bool _lastUiAudioMuted = true;
  bool _lastUiSecureDesktop = false;
  bool _lastUiElevatedConnected = false;
  int _lastUiDisplayCount = 0;
  String _lastUiActiveDisplayId = '';
  String _lastUiStatusMsg = '';

  // Floating orb position
  double _orbX = 16;
  double _orbY = 64;

  // Modifiers for virtual keyboard
  final Set<String> _lockedMods = {};

  // Gesture & raw pointer state for zero-delay Direct Touch + Touchpad
  final Set<int> _activePointers = {};
  int? _directPointerId;
  Offset? _lastSingleFocal;
  Offset? _downFocal;
  DateTime? _downAt;
  bool _dragSent = false;
  bool _longPressTriggered = false;
  Timer? _longPressTimer;
  int _maxPointerCount = 0;

  // Touchpad local 120Hz zero-latency crosshair feedback
  final ValueNotifier<Offset?> _localCursorNorm = ValueNotifier<Offset?>(null);
  Offset _virtualCursorPos = const Offset(0.5, 0.5);
  Timer? _cursorHideTimer;
  bool _isTouchpadSliding = false;

  DateTime? _lastBackSwipeAt;
  StreamSubscription<String>? _toastSub;
  StreamSubscription<String>? _clipSub;
  StreamSubscription<NativeInputEvent>? _hwSub;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    NativeBridge.enterStreamFullscreen();
    NativeBridge.setLowLatencyLocks(true);
    NativeBridge.setCaptureExternalInput(true);

    widget.session.addListener(_onSessionUpdated);
    widget.session.remoteCursorNorm.addListener(_onRemoteCursorUpdated);
    _toastSub = widget.session.toasts.listen(_showToast);
    _clipSub = widget.session.remoteClipboards.listen((txt) async {
      _lastSyncedClip = txt;
      await Clipboard.setData(ClipboardData(text: txt));
      _showToast(txt.isEmpty ? '电脑剪贴板为空' : '已同步电脑剪贴板到手机 (${txt.length}字)');
    });
    _hwSub = NativeBridge.hardwareInputEvents.listen((evt) {
      if (!widget.session.controlEnabled) return;
      if (evt.kind == 'k:down' || evt.kind == 'k:up') {
        if (evt.code != null) {
          widget.session.sendReliable({'t': evt.kind, 'code': evt.code});
        }
      } else if (evt.kind == 'm:btn' && evt.button != null && evt.state != null) {
        widget.session.sendReliable({'t': 'm:btn', 'button': evt.button, 'state': evt.state});
      } else if (evt.kind == 'm:rel' && evt.dx != null && evt.dy != null) {
        widget.session.sendPointerFast({'t': 'm:rel', 'dx': evt.dx, 'dy': evt.dy});
      } else if (evt.kind == 'm:whl' && evt.dy != null) {
        widget.session.sendPointerFast({'t': 'm:whl', 'dy': evt.dy});
      }
    });

    _loadPrefs();
  }

  Future<void> _loadPrefs() async {
    final preset = await widget.storage.getScenePreset();
    final scale = await widget.storage.getViewScaleMode();
    final fillRatio = await widget.storage.getFillRatio();
    final input = await widget.storage.getInputControlMode();
    final hud = await widget.storage.getShowHud();
    final preferHevc = await widget.storage.getPreferHevc();
    final pointerCapture = await widget.storage.getPointerCaptureEnabled();
    final autoClip = await widget.storage.getAutoSyncClipboard();
    if (!mounted) return;
    setState(() {
      _preset = preset;
      _scaleMode = scale;
      _fillRatio = fillRatio;
      _inputMode = input;
      _contentHint = preset.contentHint;
      _showHud = hud;
      _preferHevc = preferHevc;
      _pointerCaptureEnabled = pointerCapture;
      _autoSyncClipboard = autoClip;
    });
    _syncPointerCaptureWithUi();
  }

  void _syncPointerCaptureWithUi() {
    final active = _pointerCaptureEnabled &&
        !_drawerOpen &&
        !_showVkb &&
        widget.session.controlEnabled;
    NativeBridge.setPointerCapture(active);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.inactive ||
        state == AppLifecycleState.paused ||
        state == AppLifecycleState.hidden) {
      _longPressTimer?.cancel();
      if (_lockedMods.isNotEmpty) {
        setState(() => _lockedMods.clear());
      }
      _dragSent = false;
      _activePointers.clear();
      _resetGestureState();
      if (widget.session.controlEnabled) {
        widget.session.sendReliable({'t': 'k:release_all', 'reason': 'android_background'});
      }
      if (state == AppLifecycleState.paused || state == AppLifecycleState.hidden) {
        NativeBridge.setPointerCapture(false);
        NativeBridge.setCaptureExternalInput(false);
        NativeBridge.setLowLatencyLocks(false);
      }
      return;
    }
    if (state == AppLifecycleState.resumed) {
      NativeBridge.enterStreamFullscreen();
      NativeBridge.setLowLatencyLocks(true);
      NativeBridge.setCaptureExternalInput(true);
      _syncPointerCaptureWithUi();
      if (widget.session.phase == SessionPhase.disconnected) {
        unawaited(widget.session.reconnectSaved());
      } else if (widget.session.phase == SessionPhase.connected) {
        unawaited(widget.session.verifyAliveOnResume());
      }
      if (_autoSyncClipboard && widget.session.controlEnabled) {
        Clipboard.getData(Clipboard.kTextPlain).then((data) {
          if (!mounted) return;
          final txt = data?.text ?? '';
          if (txt.isNotEmpty && txt != _lastSyncedClip) {
            _lastSyncedClip = txt;
            widget.session.sendReliable({'t': 'clip:push', 'text': txt});
            _showToast('已自动同步手机剪贴板至电脑');
          }
        }).catchError((_) {});
      }
    }
  }

  void _onRemoteCursorUpdated() {
    if (_isTouchpadSliding) return;
    final norm = widget.session.remoteCursorNorm.value;
    if (norm != null) {
      _virtualCursorPos = norm;
    }
  }

  void _onSessionUpdated() {
    if (!mounted) return;
    final s = widget.session;
    if ((s.phase == SessionPhase.disconnected || s.phase == SessionPhase.error) &&
        s.phase != _lastUiPhase) {
      _showToast(s.statusMessage);
    }
    final uiChanged = s.phase != _lastUiPhase ||
        s.controlEnabled != _lastUiControlEnabled ||
        s.hostAudioEnabled != _lastUiHostAudioEnabled ||
        s.audioMuted != _lastUiAudioMuted ||
        s.hostInSecureDesktop != _lastUiSecureDesktop ||
        s.hostElevatedConnected != _lastUiElevatedConnected ||
        s.displays.length != _lastUiDisplayCount ||
        s.activeDisplayId != _lastUiActiveDisplayId ||
        (s.phase != SessionPhase.connected && s.statusMessage != _lastUiStatusMsg);
    if (!uiChanged) return;
    _lastUiPhase = s.phase;
    _lastUiControlEnabled = s.controlEnabled;
    _lastUiHostAudioEnabled = s.hostAudioEnabled;
    _lastUiAudioMuted = s.audioMuted;
    _lastUiSecureDesktop = s.hostInSecureDesktop;
    _lastUiElevatedConnected = s.hostElevatedConnected;
    _lastUiDisplayCount = s.displays.length;
    _lastUiActiveDisplayId = s.activeDisplayId;
    _lastUiStatusMsg = s.statusMessage;
    _syncPointerCaptureWithUi();
    setState(() {});
  }

  void _showToast(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(
        SnackBar(
          content: Text(
            msg,
            style: const TextStyle(color: Colors.white, fontSize: 12.5),
          ),
          backgroundColor: const Color(0xE60F172A),
          behavior: SnackBarBehavior.floating,
          elevation: 6,
          margin: const EdgeInsets.fromLTRB(48, 0, 48, 18),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(12),
            side: const BorderSide(color: Color(0xFF334155)),
          ),
          duration: const Duration(seconds: 2),
        ),
      );
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _longPressTimer?.cancel();
    _cursorHideTimer?.cancel();
    _toastSub?.cancel();
    _clipSub?.cancel();
    _hwSub?.cancel();
    widget.session.remoteCursorNorm.removeListener(_onRemoteCursorUpdated);
    widget.session.removeListener(_onSessionUpdated);
    NativeBridge.setPointerCapture(false);
    NativeBridge.setCaptureExternalInput(false);
    NativeBridge.setLowLatencyLocks(false);
    NativeBridge.exitStreamFullscreen();
    _localCursorNorm.dispose();
    _zoomCtrl.dispose();
    _imeCtrl.dispose();
    super.dispose();
  }

  Future<void> _exitStage() async {
    await widget.session.disconnect();
    if (mounted) Navigator.of(context).pop();
  }

  /// Inverse-maps screen coordinates (inside the interactive stage box) to normalized [0..1]
  /// desktop coordinates taking into account zoom/pan, aspect adaptation, and zero-crop fill ratio.
  Offset? _screenToNormalizedDesktop(Offset localPos, Size stageSize) {
    if (stageSize.width <= 0 || stageSize.height <= 0) return null;
    final Matrix4 inv = Matrix4.inverted(_zoomCtrl.value);
    final Offset childPos = MatrixUtils.transformPoint(inv, localPos);
    final rect = computeStageVideoRect(
      stageSize: stageSize,
      renderer: widget.session.remoteRenderer,
      scaleMode: _scaleMode,
      fillRatio: _fillRatio,
      fallbackTxW: widget.session.telemetry.txW,
      fallbackTxH: widget.session.telemetry.txH,
      rotation: widget.session.remoteRenderer.value.rotation,
    );
    if (rect.width <= 0 || rect.height <= 0) return null;

    final nx = ((childPos.dx - rect.left) / rect.width).clamp(0.0, 1.0);
    final ny = ((childPos.dy - rect.top) / rect.height).clamp(0.0, 1.0);
    return Offset(nx, ny);
  }

  void _handlePointerDown(PointerDownEvent ev, Size stageSize) {
    _activePointers.add(ev.pointer);
    _maxPointerCount = math.max(_maxPointerCount, _activePointers.length);
    if (_inputMode != InputControlMode.direct || !widget.session.controlEnabled) return;

    if (_activePointers.length > 1) {
      _longPressTimer?.cancel();
      if (_dragSent) {
        widget.session.sendReliable({'t': 'm:btn', 'button': 'left', 'state': 'up'});
        _dragSent = false;
      }
      _directPointerId = null;
      return;
    }

    _directPointerId = ev.pointer;
    _downFocal = ev.localPosition;
    _lastSingleFocal = ev.localPosition;
    _downAt = DateTime.now();
    _dragSent = false;
    _longPressTriggered = false;

    final downNorm = _screenToNormalizedDesktop(ev.localPosition, stageSize);
    if (downNorm != null) {
      widget.session.sendReliable({'t': 'm:abs', 'x': downNorm.dx, 'y': downNorm.dy});
    }

    _longPressTimer?.cancel();
    _longPressTimer = Timer(const Duration(milliseconds: 430), () {
      if (!mounted ||
          _dragSent ||
          _maxPointerCount > 1 ||
          _downFocal == null ||
          _directPointerId != ev.pointer) {
        return;
      }
      _longPressTriggered = true;
      HapticFeedback.mediumImpact();
      final norm = _screenToNormalizedDesktop(_downFocal!, stageSize);
      if (norm != null) {
        widget.session.sendReliable({'t': 'm:abs', 'x': norm.dx, 'y': norm.dy});
      }
      widget.session.sendReliable({'t': 'm:btn', 'button': 'right', 'state': 'down'});
      widget.session.sendReliable({'t': 'm:btn', 'button': 'right', 'state': 'up'});
    });
  }

  void _handlePointerMove(PointerMoveEvent ev, Size stageSize) {
    if (_inputMode != InputControlMode.direct || !widget.session.controlEnabled) return;
    if (_activePointers.length > 1 || ev.pointer != _directPointerId || _longPressTriggered) return;

    final totalMove = _downFocal != null ? (ev.localPosition - _downFocal!).distance : 0.0;
    if (totalMove > 8.0) {
      _longPressTimer?.cancel();
      final norm = _screenToNormalizedDesktop(ev.localPosition, stageSize);
      if (norm != null) {
        if (!_dragSent) {
          _dragSent = true;
          widget.session.sendReliable({'t': 'm:abs', 'x': norm.dx, 'y': norm.dy});
          widget.session.sendReliable({'t': 'm:btn', 'button': 'left', 'state': 'down'});
        } else {
          widget.session.sendPointerFast({'t': 'm:abs', 'x': norm.dx, 'y': norm.dy});
        }
      }
    }
  }

  void _handlePointerUp(PointerUpEvent ev, Size stageSize) {
    _activePointers.remove(ev.pointer);
    if (_inputMode != InputControlMode.direct) return;
    _longPressTimer?.cancel();

    if (ev.pointer != _directPointerId || !widget.session.controlEnabled) {
      if (_activePointers.isEmpty) _resetGestureState();
      return;
    }

    if (_dragSent) {
      widget.session.sendReliable({'t': 'm:btn', 'button': 'left', 'state': 'up'});
    } else if (!_longPressTriggered && _maxPointerCount == 1 && _downFocal != null) {
      final elapsedMs = _downAt != null
          ? DateTime.now().difference(_downAt!).inMilliseconds
          : 999;
      if (elapsedMs < 350) {
        final norm = _screenToNormalizedDesktop(_downFocal!, stageSize);
        if (norm != null) {
          widget.session.sendReliable({'t': 'm:abs', 'x': norm.dx, 'y': norm.dy});
        }
        widget.session.sendReliable({'t': 'm:btn', 'button': 'left', 'state': 'down'});
        widget.session.sendReliable({'t': 'm:btn', 'button': 'left', 'state': 'up'});
      }
    }

    if (_activePointers.isEmpty) _resetGestureState();
  }

  void _handlePointerCancel(PointerCancelEvent ev) {
    _activePointers.remove(ev.pointer);
    if (_inputMode != InputControlMode.direct) return;
    _longPressTimer?.cancel();
    if (_dragSent && widget.session.controlEnabled) {
      widget.session.sendReliable({'t': 'm:btn', 'button': 'left', 'state': 'up'});
    }
    if (_activePointers.isEmpty) _resetGestureState();
  }

  void _onScaleStart(ScaleStartDetails details, Size stageSize) {
    _lastSingleFocal = details.localFocalPoint;
    if (_inputMode == InputControlMode.direct) return;
    _maxPointerCount = details.pointerCount;
    _downFocal ??= details.localFocalPoint;
    _downAt ??= DateTime.now();
    if (details.pointerCount == 1) {
      _isTouchpadSliding = true;
      _cursorHideTimer?.cancel();
    }
  }

  void _onScaleUpdate(ScaleUpdateDetails details, Size stageSize) {
    if (details.pointerCount >= 2) {
      if (_scaleMode != ViewScaleMode.freeZoom && _lastSingleFocal != null && widget.session.controlEnabled) {
        final dy = details.localFocalPoint.dy - _lastSingleFocal!.dy;
        if (dy.abs() >= 2.0) {
          widget.session.sendPointerFast({'t': 'm:whl', 'dy': (-dy / 22.0).clamp(-4.0, 4.0)});
        }
      }
      _lastSingleFocal = details.localFocalPoint;
      return;
    }

    if (_inputMode != InputControlMode.touchpad || !widget.session.controlEnabled) return;
    _maxPointerCount = math.max(_maxPointerCount, details.pointerCount);
    final prev = _lastSingleFocal ?? details.localFocalPoint;
    final dx = details.localFocalPoint.dx - prev.dx;
    final dy = details.localFocalPoint.dy - prev.dy;
    _lastSingleFocal = details.localFocalPoint;

    final speed = math.sqrt(dx * dx + dy * dy);
    final gain = 1.2 + math.min(2.2, speed * 0.08);
    if (dx.abs() > 0.2 || dy.abs() > 0.2) {
      final relDx = dx * gain;
      final relDy = dy * gain;
      widget.session.sendPointerFast({'t': 'm:rel', 'dx': relDx, 'dy': relDy});

      _isTouchpadSliding = true;
      final eff = effectiveStageVideoSize(
        renderer: widget.session.remoteRenderer,
        fallbackTxW: widget.session.telemetry.txW,
        fallbackTxH: widget.session.telemetry.txH,
        rotation: widget.session.remoteRenderer.value.rotation,
      );
      final nextX = (_virtualCursorPos.dx + relDx / eff.width).clamp(0.0, 1.0);
      final nextY = (_virtualCursorPos.dy + relDy / eff.height).clamp(0.0, 1.0);
      _virtualCursorPos = Offset(nextX, nextY);
      _localCursorNorm.value = _virtualCursorPos;
      _cursorHideTimer?.cancel();
    }
  }

  void _onScaleEnd(ScaleEndDetails details, Size stageSize) {
    if (_inputMode != InputControlMode.touchpad) return;
    _isTouchpadSliding = false;
    if (_localCursorNorm.value != null) {
      _cursorHideTimer?.cancel();
      _cursorHideTimer = Timer(const Duration(milliseconds: 450), () {
        if (mounted) _localCursorNorm.value = null;
      });
    }
    if (!widget.session.controlEnabled) {
      _resetGestureState();
      return;
    }

    final elapsedMs = _downAt != null
        ? DateTime.now().difference(_downAt!).inMilliseconds
        : 999;

    if (elapsedMs < 260) {
      if (_maxPointerCount == 1) {
        widget.session.sendReliable({'t': 'm:btn', 'button': 'left', 'state': 'down'});
        widget.session.sendReliable({'t': 'm:btn', 'button': 'left', 'state': 'up'});
      } else if (_maxPointerCount == 2) {
        widget.session.sendReliable({'t': 'm:btn', 'button': 'right', 'state': 'down'});
        widget.session.sendReliable({'t': 'm:btn', 'button': 'right', 'state': 'up'});
      }
    }
    _resetGestureState();
  }

  void _resetGestureState() {
    _isTouchpadSliding = false;
    _directPointerId = null;
    _downFocal = null;
    _lastSingleFocal = null;
    _downAt = null;
    _dragSent = false;
    _longPressTriggered = false;
    _maxPointerCount = 0;
  }

  Future<void> _applyPreset(ScenePreset preset) async {
    await widget.storage.setScenePreset(preset);
    setState(() {
      _preset = preset;
      _contentHint = preset.contentHint;
    });
    widget.session.sendPolicy(
      preset: preset.id,
      resolution: preset.resolution,
      fps: preset.fps,
      maxBitrateKbps: preset.bitrateKbps,
      contentHint: preset.contentHint,
    );
    _showToast('已切换预设：${preset.label} (${preset.subtitle})');
  }

  void _sendKeyTap(String code) {
    if (!widget.session.controlEnabled) {
      _showToast('当前为只读模式，请在电脑按 Ctrl+Alt+L 开启操控');
      return;
    }
    widget.session.sendReliable({'t': 'k:down', 'code': code});
    widget.session.sendReliable({'t': 'k:up', 'code': code});
    if (_lockedMods.isNotEmpty) {
      for (final m in _lockedMods.toList()) {
        widget.session.sendReliable({'t': 'k:up', 'code': m});
      }
      setState(() => _lockedMods.clear());
    }
  }

  void _toggleMod(String code) {
    if (!widget.session.controlEnabled) return;
    setState(() {
      if (_lockedMods.contains(code)) {
        _lockedMods.remove(code);
        widget.session.sendReliable({'t': 'k:up', 'code': code});
      } else {
        _lockedMods.add(code);
        widget.session.sendReliable({'t': 'k:down', 'code': code});
      }
    });
  }

  void _sendCombo(List<String> codes) {
    if (!widget.session.controlEnabled) return;
    for (final c in codes) {
      widget.session.sendReliable({'t': 'k:down', 'code': c});
    }
    for (final c in codes.reversed) {
      widget.session.sendReliable({'t': 'k:up', 'code': c});
    }
  }

  void _toggleAudioFromUi() {
    if (!widget.session.controlEnabled) {
      if (widget.session.hostAudioEnabled) {
        widget.session.toggleAudioMute();
      } else {
        _showToast('当前为只读模式，需授予操控权或在电脑端开启声音');
      }
      return;
    }
    if (!widget.session.hostAudioEnabled) {
      widget.session.requestHostAudio(true);
      return;
    }
    if (widget.session.audioMuted) {
      widget.session.toggleAudioMute();
      return;
    }
    widget.session.requestHostAudio(false);
  }

  Future<void> _toggleHudFromUi() async {
    final next = !_showHud;
    await widget.storage.setShowHud(next);
    if (mounted) setState(() => _showHud = next);
  }

  Future<void> _pickAndSendFile() async {
    if (!widget.session.fileChannelReady) {
      _showToast('文件传输通道尚未就绪（请确认电脑端为 v0.5.11+）');
      return;
    }
    final picked = await NativeBridge.pickFileForTransfer();
    if (!mounted || picked == null) return;
    unawaited(widget.session.sendLocalFile(picked));
  }

  @override
  Widget build(BuildContext context) {
    final screenSize = MediaQuery.of(context).size;

    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) return;
        if (_drawerOpen) {
          setState(() => _drawerOpen = false);
          _syncPointerCaptureWithUi();
          return;
        }
        if (_showVkb) {
          setState(() => _showVkb = false);
          _syncPointerCaptureWithUi();
          return;
        }
        final now = DateTime.now();
        if (_lastBackSwipeAt != null &&
            now.difference(_lastBackSwipeAt!).inMilliseconds < 1800) {
          _exitStage();
        } else {
          _lastBackSwipeAt = now;
          _showToast('再按一次返回退出远程桌面');
        }
      },
      child: Scaffold(
        backgroundColor: Colors.black,
        body: LayoutBuilder(
          builder: (ctx, constraints) {
            final stageSize = Size(constraints.maxWidth, constraints.maxHeight);
            final videoWidget = StageVideoLayer(
              stageSize: stageSize,
              renderer: widget.session.remoteRenderer,
              scaleMode: _scaleMode,
              fillRatio: _fillRatio,
              fallbackTxW: widget.session.telemetry.txW,
              fallbackTxH: widget.session.telemetry.txH,
              localCursorNorm: _localCursorNorm,
              inputMode: _inputMode,
            );

            return Stack(
              children: [
                Positioned.fill(
                  child: Listener(
                    onPointerDown: (ev) => _handlePointerDown(ev, stageSize),
                    onPointerMove: (ev) => _handlePointerMove(ev, stageSize),
                    onPointerUp: (ev) => _handlePointerUp(ev, stageSize),
                    onPointerCancel: _handlePointerCancel,
                    child: GestureDetector(
                      behavior: HitTestBehavior.opaque,
                      onScaleStart: (d) => _onScaleStart(d, stageSize),
                      onScaleUpdate: (d) => _onScaleUpdate(d, stageSize),
                      onScaleEnd: (d) => _onScaleEnd(d, stageSize),
                      child: _scaleMode == ViewScaleMode.freeZoom
                          ? InteractiveViewer(
                              transformationController: _zoomCtrl,
                              minScale: 1.0,
                              maxScale: 4.0,
                              panEnabled: true,
                              scaleEnabled: true,
                              child: SizedBox.expand(child: videoWidget),
                            )
                          : SizedBox.expand(child: videoWidget),
                    ),
                  ),
                ),

                if (widget.session.phase != SessionPhase.connected)
                  Positioned.fill(
                    child: Container(
                      color: const Color(0xB805070A),
                      alignment: Alignment.center,
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const CircularProgressIndicator(),
                          const SizedBox(height: 14),
                          Text(
                            widget.session.statusMessage,
                            style: const TextStyle(color: Colors.white, fontSize: 14),
                          ),
                          const SizedBox(height: 14),
                          Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              OutlinedButton(
                                onPressed: () => widget.session.reconnectSaved(),
                                child: const Text('重试直连'),
                              ),
                              const SizedBox(width: 10),
                              FilledButton(
                                style: FilledButton.styleFrom(backgroundColor: const Color(0xFFDC2626)),
                                onPressed: _exitStage,
                                child: const Text('返回首页'),
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),
                  ),

                if (widget.session.phase == SessionPhase.connected &&
                    widget.session.hostInSecureDesktop)
                  Positioned(
                    top: 12,
                    left: 16,
                    right: 16,
                    child: SafeArea(
                      bottom: false,
                      child: Center(
                        child: StageSecureDesktopBanner(
                          elevatedConnected: widget.session.hostElevatedConnected,
                          controlEnabled: widget.session.controlEnabled,
                          onSendEsc: () {
                            _sendKeyTap('Escape');
                            _showToast('已发送 Esc（取消 UAC）');
                          },
                          onSendAltY: () {
                            _sendCombo(['AltLeft', 'KeyY']);
                            _showToast('已发送 Alt+Y（允许 UAC）');
                          },
                        ),
                      ),
                    ),
                  ),

                if (_showHud)
                  Positioned(
                    top: 10,
                    left: 14,
                    child: StageTelemetryHud(session: widget.session),
                  ),

                if (_inputMode == InputControlMode.touchpad)
                  Positioned(
                    left: 16,
                    bottom: _showVkb ? 175 : 16,
                    child: StageTouchpadQuickButtons(
                      controlEnabled: widget.session.controlEnabled,
                      onMouseButton: (button, state) {
                        widget.session.sendReliable({'t': 'm:btn', 'button': button, 'state': state});
                      },
                    ),
                  ),

                if (_showVkb)
                  Positioned(
                    left: 0,
                    right: 0,
                    bottom: 0,
                    child: StageVirtualKeyboard(
                      imeController: _imeCtrl,
                      lockedMods: _lockedMods,
                      controlEnabled: widget.session.controlEnabled,
                      onKeyTap: _sendKeyTap,
                      onToggleMod: _toggleMod,
                      onCombo: _sendCombo,
                      onSendText: () {
                        final txt = _imeCtrl.text;
                        if (txt.isEmpty) return;
                        widget.session.sendReliable({'t': 'text:unicode', 'text': txt});
                        _imeCtrl.clear();
                      },
                      onSendSas: () => widget.session.sendReliable({'t': 'sys:sas'}),
                      onHide: () {
                        setState(() => _showVkb = false);
                        _syncPointerCaptureWithUi();
                      },
                    ),
                  ),

                Positioned(
                  right: _orbX.clamp(8.0, math.max(8.0, screenSize.width - 56)),
                  top: _orbY.clamp(8.0, math.max(8.0, screenSize.height - 56)),
                  child: GestureDetector(
                    onPanUpdate: (d) {
                      setState(() {
                        _orbX = (_orbX - d.delta.dx).clamp(8.0, screenSize.width - 56);
                        _orbY = (_orbY + d.delta.dy).clamp(8.0, screenSize.height - 56);
                      });
                    },
                    onTap: () {
                      setState(() => _drawerOpen = !_drawerOpen);
                      _syncPointerCaptureWithUi();
                    },
                    child: Opacity(
                      opacity: _drawerOpen ? 0.96 : 0.42,
                      child: Container(
                        width: 44,
                        height: 44,
                        decoration: BoxDecoration(
                          color: const Color(0xFF0F172A),
                          shape: BoxShape.circle,
                          border: Border.all(
                            color: widget.session.controlEnabled
                                ? const Color(0xFF34D399)
                                : const Color(0xFF60A5FA),
                            width: 1.5,
                          ),
                          boxShadow: const [
                            BoxShadow(color: Colors.black54, blurRadius: 8),
                          ],
                        ),
                        child: Icon(
                          _drawerOpen ? Icons.close : Icons.tune_rounded,
                          color: Colors.white,
                          size: 20,
                        ),
                      ),
                    ),
                  ),
                ),

                if (_drawerOpen)
                  Positioned(
                    right: 12,
                    top: 12,
                    bottom: 12,
                    width: math.min(350, screenSize.width * 0.46),
                    child: StageControlDrawer(
                      session: widget.session,
                      activeTab: _drawerTab,
                      preset: _preset,
                      scaleMode: _scaleMode,
                      fillRatio: _fillRatio,
                      inputMode: _inputMode,
                      contentHint: _contentHint,
                      preferHevc: _preferHevc,
                      pointerCaptureEnabled: _pointerCaptureEnabled,
                      autoSyncClipboard: _autoSyncClipboard,
                      showHud: _showHud,
                      showVkb: _showVkb,
                      onTabChanged: (i) => setState(() => _drawerTab = i),
                      onApplyPreset: _applyPreset,
                      onChangeScaleMode: (m) async {
                        await widget.storage.setViewScaleMode(m);
                        if (!mounted) return;
                        setState(() {
                          _scaleMode = m;
                          if (m != ViewScaleMode.freeZoom) {
                            _zoomCtrl.value = Matrix4.identity();
                          }
                        });
                      },
                      onPreviewFillRatio: (v) => setState(() => _fillRatio = v),
                      onCommitFillRatio: (ratio) async {
                        setState(() => _fillRatio = ratio);
                        await widget.storage.setFillRatio(ratio);
                      },
                      onChangeInputMode: (m) async {
                        await widget.storage.setInputControlMode(m);
                        if (mounted) setState(() => _inputMode = m);
                      },
                      onChangeContentHint: (hint) {
                        setState(() => _contentHint = hint);
                        widget.session.sendPolicy(
                          preset: _preset.id,
                          resolution: _preset.resolution,
                          fps: _preset.fps,
                          maxBitrateKbps: _preset.bitrateKbps,
                          contentHint: hint,
                        );
                      },
                      onChangePreferHevc: (preferHevc) async {
                        await widget.storage.setPreferHevc(preferHevc);
                        if (mounted) setState(() => _preferHevc = preferHevc);
                        _showToast(
                          preferHevc
                              ? '已设为优先 H.265 (HEVC)（点工具页「重连会话」生效）'
                              : '已设为 H.264 通用硬解（点工具页「重连会话」生效）',
                        );
                      },
                      onChangePointerCapture: (v) async {
                        await widget.storage.setPointerCaptureEnabled(v);
                        if (!mounted) return;
                        setState(() => _pointerCaptureEnabled = v);
                        _syncPointerCaptureWithUi();
                        _showToast(v ? '已开启外接鼠标 Pointer Capture（收起抽屉后生效）' : '已关闭 Pointer Capture');
                      },
                      onChangeAutoClipboard: (v) async {
                        await widget.storage.setAutoSyncClipboard(v);
                        if (mounted) setState(() => _autoSyncClipboard = v);
                      },
                      onToggleAudio: _toggleAudioFromUi,
                      onToggleHud: _toggleHudFromUi,
                      onToggleVkb: () {
                        setState(() {
                          _showVkb = !_showVkb;
                          _drawerOpen = false;
                        });
                        _syncPointerCaptureWithUi();
                      },
                      onPullClipboard: () => widget.session.sendReliable({'t': 'clip:pull'}),
                      onPushClipboard: () async {
                        final data = await Clipboard.getData(Clipboard.kTextPlain);
                        final txt = data?.text ?? '';
                        if (txt.isEmpty) {
                          _showToast('手机剪贴板为空');
                        } else {
                          _lastSyncedClip = txt;
                          widget.session.sendReliable({'t': 'clip:push', 'text': txt});
                          _showToast('已发送剪贴板到电脑');
                        }
                      },
                      onPickAndSendFile: _pickAndSendFile,
                      onEnterPip: () async {
                        setState(() => _drawerOpen = false);
                        final ok = await NativeBridge.enterPipMode();
                        if (!ok) _showToast('当前系统或桌面模式不支持画中画');
                      },
                      onReconnect: () {
                        setState(() => _drawerOpen = false);
                        widget.session.reconnectSaved();
                      },
                      onCloseDrawer: () {
                        setState(() => _drawerOpen = false);
                        _syncPointerCaptureWithUi();
                      },
                      onExitStage: _exitStage,
                    ),
                  ),
              ],
            );
          },
        ),
      ),
    );
  }
}
