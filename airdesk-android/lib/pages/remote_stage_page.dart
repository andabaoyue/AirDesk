import 'dart:async';
import 'dart:math' as math;
// ignore: deprecated_member_use
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import '../models/airdesk_models.dart';
import '../services/native_bridge.dart';
import '../services/storage_service.dart';
import '../services/webrtc_session_service.dart';

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
  int _lastUiDisplayCount = 0;
  String _lastUiActiveDisplayId = '';
  String _lastUiStatusMsg = '';

  // Floating orb position (fraction of screen)
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
        s.displays.length != _lastUiDisplayCount ||
        s.activeDisplayId != _lastUiActiveDisplayId ||
        (s.phase != SessionPhase.connected && s.statusMessage != _lastUiStatusMsg);
    if (!uiChanged) return;
    _lastUiPhase = s.phase;
    _lastUiControlEnabled = s.controlEnabled;
    _lastUiHostAudioEnabled = s.hostAudioEnabled;
    _lastUiAudioMuted = s.audioMuted;
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

  Size _effectiveVideoSize({double? videoW, double? videoH, int rotation = 0}) {
    final renderer = widget.session.remoteRenderer;
    double vw = (videoW != null && videoW > 0)
        ? videoW
        : (renderer.videoWidth > 0
            ? renderer.videoWidth.toDouble()
            : (widget.session.telemetry.txW ?? 1920).toDouble());
    double vh = (videoH != null && videoH > 0)
        ? videoH
        : (renderer.videoHeight > 0
            ? renderer.videoHeight.toDouble()
            : (widget.session.telemetry.txH ?? 1080).toDouble());
    if (vw <= 0) vw = 1920;
    if (vh <= 0) vh = 1080;
    if ((rotation ~/ 90).isOdd) {
      final tmp = vw;
      vw = vh;
      vh = tmp;
    }
    return Size(vw, vh);
  }

  /// Single source of truth for video layout rectangle and touch inverse-mapping.
  /// Guarantees zero cropping in all modes while dynamically adapting to any phone/PC aspect ratio.
  Rect _computeVideoRect(
    Size stageSize, {
    double? videoW,
    double? videoH,
    int rotation = 0,
  }) {
    if (stageSize.width <= 0 || stageSize.height <= 0) {
      return Rect.zero;
    }
    final eff = _effectiveVideoSize(videoW: videoW, videoH: videoH, rotation: rotation);
    final va = eff.width / eff.height;
    final ba = stageSize.width / stageSize.height;

    double containW = stageSize.width;
    double containH = stageSize.height;
    if (ba > va) {
      containW = stageSize.height * va;
    } else {
      containH = stageSize.width / va;
    }

    double drawW = containW;
    double drawH = containH;
    if (_scaleMode == ViewScaleMode.adaptiveFill) {
      final t = _fillRatio.clamp(0.0, 1.0);
      drawW = containW + (stageSize.width - containW) * t;
      drawH = containH + (stageSize.height - containH) * t;
    }

    final drawLeft = (stageSize.width - drawW) / 2;
    final drawTop = (stageSize.height - drawH) / 2;
    return Rect.fromLTWH(drawLeft, drawTop, drawW, drawH);
  }

  /// Inverse-maps screen coordinates (inside the interactive stage box) to normalized [0..1]
  /// desktop coordinates taking into account zoom/pan, aspect adaptation, and zero-crop fill ratio.
  Offset? _screenToNormalizedDesktop(Offset localPos, Size stageSize) {
    if (stageSize.width <= 0 || stageSize.height <= 0) return null;
    final Matrix4 inv = Matrix4.inverted(_zoomCtrl.value);
    final Offset childPos = MatrixUtils.transformPoint(inv, localPos);
    final rect = _computeVideoRect(
      stageSize,
      rotation: widget.session.remoteRenderer.value.rotation,
    );
    if (rect.width <= 0 || rect.height <= 0) return null;

    final nx = ((childPos.dx - rect.left) / rect.width).clamp(0.0, 1.0);
    final ny = ((childPos.dy - rect.top) / rect.height).clamp(0.0, 1.0);
    return Offset(nx, ny);
  }

  Widget _buildAdaptiveVideo(Size stageSize) {
    final renderer = widget.session.remoteRenderer;
    return ValueListenableBuilder<RTCVideoValue>(
      valueListenable: renderer,
      builder: (context, value, _) {
        final texId = renderer.textureId;
        if (!renderer.renderVideo || texId == null) {
          return const ColoredBox(color: Colors.black);
        }
        final rect = _computeVideoRect(
          stageSize,
          videoW: value.width > 0 ? value.width : null,
          videoH: value.height > 0 ? value.height : null,
          rotation: value.rotation,
        );
        Widget tex = Texture(
          textureId: texId,
          filterQuality: FilterQuality.low,
        );
        final quarterTurns = (value.rotation ~/ 90) % 4;
        if (quarterTurns != 0) {
          tex = RotatedBox(quarterTurns: quarterTurns, child: tex);
        }
        return ColoredBox(
          color: Colors.black,
          child: Stack(
            children: [
              Positioned(
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
                child: RepaintBoundary(child: tex),
              ),
              ValueListenableBuilder<Offset?>(
                valueListenable: _localCursorNorm,
                builder: (_, norm, _) {
                  if (_inputMode != InputControlMode.touchpad || norm == null) {
                    return const SizedBox.shrink();
                  }
                  final cx = rect.left + norm.dx * rect.width;
                  final cy = rect.top + norm.dy * rect.height;
                  return Positioned(
                    left: cx - 12,
                    top: cy - 12,
                    width: 24,
                    height: 24,
                    child: RepaintBoundary(
                      child: IgnorePointer(
                        child: Container(
                          decoration: BoxDecoration(
                            shape: BoxShape.circle,
                            border: Border.all(color: const Color(0xCC22D3EE), width: 1.6),
                            color: const Color(0x2222D3EE),
                          ),
                          child: Center(
                            child: Container(
                              width: 4,
                              height: 4,
                              decoration: const BoxDecoration(
                                shape: BoxShape.circle,
                                color: Color(0xEE22D3EE),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  );
                },
              ),
            ],
          ),
        );
      },
    );
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

    // Zero-delay pointer positioning: move PC cursor on ordered reliable channel at touch-down
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
        // Send abs move + click down/up strictly in order on ctrl-reliable to avoid race conditions
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
      // Two-finger vertical scroll in contain/cover modes (both direct and touchpad)
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
      final eff = _effectiveVideoSize(
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

            final videoWidget = _buildAdaptiveVideo(stageSize);

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

                // Disconnected / Negotiating overlay
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

                // Debug telemetry HUD pill (top-left, hidden by default; isolated via ListenableBuilder + RepaintBoundary)
                if (_showHud)
                  Positioned(
                    top: 10,
                    left: 14,
                    child: RepaintBoundary(
                      child: IgnorePointer(
                        child: ListenableBuilder(
                          listenable: widget.session,
                          builder: (_, _) => _buildTelemetryHud(),
                        ),
                      ),
                    ),
                  ),

                // Touchpad quick Left/Right mouse buttons when in Touchpad mode
                if (_inputMode == InputControlMode.touchpad)
                  Positioned(
                    left: 16,
                    bottom: _showVkb ? 175 : 16,
                    child: Row(
                      children: [
                        _quickMouseBtn('左键', 'left'),
                        const SizedBox(width: 8),
                        _quickMouseBtn('右键', 'right'),
                      ],
                    ),
                  ),

                // Virtual Keyboard & Chinese IME drawer at bottom
                if (_showVkb)
                  Positioned(
                    left: 0,
                    right: 0,
                    bottom: 0,
                    child: _buildVirtualKeyboard(),
                  ),

                // Translucent draggable floating control orb
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

                // Quick Drawer Overlay
                if (_drawerOpen)
                  Positioned(
                    right: 12,
                    top: 12,
                    bottom: 12,
                    width: math.min(350, screenSize.width * 0.46),
                    child: _buildControlDrawer(),
                  ),
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _quickMouseBtn(String label, String button) {
    return GestureDetector(
      onTapDown: (_) {
        if (widget.session.controlEnabled) {
          widget.session.sendReliable({'t': 'm:btn', 'button': button, 'state': 'down'});
        }
      },
      onTapUp: (_) {
        if (widget.session.controlEnabled) {
          widget.session.sendReliable({'t': 'm:btn', 'button': button, 'state': 'up'});
        }
      },
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        decoration: BoxDecoration(
          color: const Color(0xAA0F172A),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: const Color(0xFF334155)),
        ),
        child: Text(label, style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600)),
      ),
    );
  }

  Widget _buildTelemetryHud() {
    final t = widget.session.telemetry;
    final txHw = t.txHw == null ? '' : (t.txHw! ? '·硬编' : '·软编');
    final rxHw = t.rxHw == null ? '' : (t.rxHw! ? '·硬解' : '·软解');
    final rttStr = t.rttMs != null ? '${t.rttMs}ms' : '--';
    final line1 =
        'PC: ${t.codec.isEmpty ? "--" : t.codec} [${t.encoder}$txHw ${t.encodeMs ?? "--"}ms] '
        '${t.txW ?? "--"}x${t.txH ?? "--"} @ ${t.txFps ?? "--"}fps · RTT:$rttStr';
    final line2 =
        '手机: ${t.rxFps ?? "--"}fps [${t.decoder}$rxHw ${t.decodeMs ?? "--"}ms] · '
        '缓冲:${t.jbMs ?? "--"}/${t.jbTargetMs ?? "--"}ms · 掉帧:${t.dropped ?? 0}';

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: const Color(0x990B0F14),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: const Color(0x4494A3B8)),
      ),
      child: DefaultTextStyle(
        style: const TextStyle(
          fontSize: 10.5,
          fontFamily: 'monospace',
          color: Color(0xFF34D399),
          height: 1.35,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(line1),
            Text(line2, style: const TextStyle(color: Color(0xFF93C5FD))),
          ],
        ),
      ),
    );
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

  String _shortPresetSpec(ScenePreset p) {
    final bps = p.bitrateKbps >= 1000
        ? '${(p.bitrateKbps / 1000).round()}M'
        : '${p.bitrateKbps}K';
    final res = p.resolution == 'native' ? '原生' : p.resolution;
    return '$res·${p.fps}f·$bps';
  }

  Widget _buildResolutionAdapterSection() {
    final mq = MediaQuery.of(context);
    final stageW = math.max(mq.size.width, mq.size.height);
    final stageH = math.min(mq.size.width, mq.size.height);
    final stageSize = Size(stageW, stageH);
    final physW = (stageW * mq.devicePixelRatio).round();
    final physH = (stageH * mq.devicePixelRatio).round();
    final phoneRatio9 = stageH > 0 ? (stageW / stageH * 9).toStringAsFixed(1) : '--';

    final eff = _effectiveVideoSize(
      rotation: widget.session.remoteRenderer.value.rotation,
    );
    final pcW = eff.width.round();
    final pcH = eff.height.round();
    final pcRatio9 = eff.height > 0 ? (eff.width / eff.height * 9).toStringAsFixed(1) : '--';

    final rect = _computeVideoRect(
      stageSize,
      rotation: widget.session.remoteRenderer.value.rotation,
    );
    final pcAspect = eff.width / eff.height;
    final drawAspect = rect.height > 0 ? rect.width / rect.height : pcAspect;
    final stretchRatio = pcAspect > 0 ? (drawAspect / pcAspect) : 1.0;

    final pct = (_fillRatio * 100).round();
    final summaryText = _scaleMode == ViewScaleMode.adaptiveFill
        ? '填充 $pct% · 横向 ${stretchRatio.toStringAsFixed(2)}× · 零裁切'
        : (_scaleMode == ViewScaleMode.freeZoom
            ? '双指缩放漫游 · 原比例 1.00×'
            : '原比例完整 · 1.00×');

    Widget quickPresetBtn(String label, double ratio) {
      final selected = (_fillRatio - ratio).abs() < 0.025;
      return Expanded(
        child: InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: () async {
            setState(() => _fillRatio = ratio);
            await widget.storage.setFillRatio(ratio);
          },
          child: Container(
            padding: const EdgeInsets.symmetric(vertical: 5),
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: selected ? const Color(0xFF1D4ED8) : const Color(0xFF16202F),
              borderRadius: BorderRadius.circular(8),
              border: Border.all(
                color: selected ? const Color(0xFF60A5FA) : const Color(0xFF2B3A4E),
              ),
            ),
            child: Text(
              label,
              style: TextStyle(
                fontSize: 11,
                fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
                color: Colors.white,
              ),
            ),
          ),
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('屏幕与分辨率适配', style: TextStyle(fontSize: 11.5, color: Color(0xFF94A3B8))),
        const SizedBox(height: 5),
        Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
          decoration: BoxDecoration(
            color: const Color(0x99070B11),
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: const Color(0xFF243041)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '手机 $physW×$physH ($phoneRatio9:9)  ·  电脑 $pcW×$pcH ($pcRatio9:9)',
                style: const TextStyle(fontSize: 10.5, color: Color(0xFFCBD5E1)),
              ),
              const SizedBox(height: 2),
              Text(
                summaryText,
                style: const TextStyle(
                  fontSize: 11,
                  color: Color(0xFF34D399),
                  fontWeight: FontWeight.w500,
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 6),
        Row(
          children: ViewScaleMode.values.map((m) {
            final selected = _scaleMode == m;
            final shortLabel = switch (m) {
              ViewScaleMode.adaptiveFill => '自适应铺满',
              ViewScaleMode.contain => '原比例',
              ViewScaleMode.freeZoom => '自由缩放',
            };
            return Expanded(
              child: Padding(
                padding: EdgeInsets.only(right: m == ViewScaleMode.values.last ? 0 : 6),
                child: InkWell(
                  borderRadius: BorderRadius.circular(8),
                  onTap: () async {
                    await widget.storage.setViewScaleMode(m);
                    setState(() {
                      _scaleMode = m;
                      if (m != ViewScaleMode.freeZoom) {
                        _zoomCtrl.value = Matrix4.identity();
                      }
                    });
                  },
                  child: Container(
                    padding: const EdgeInsets.symmetric(vertical: 6),
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: selected ? const Color(0xFF1E3A8A) : const Color(0xFF16202F),
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(
                        color: selected ? const Color(0xFF60A5FA) : const Color(0xFF2B3A4E),
                      ),
                    ),
                    child: Text(
                      shortLabel,
                      style: TextStyle(
                        fontSize: 11,
                        fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
                        color: Colors.white,
                      ),
                    ),
                  ),
                ),
              ),
            );
          }).toList(),
        ),
        if (_scaleMode == ViewScaleMode.adaptiveFill) ...[
          const SizedBox(height: 7),
          Row(
            children: [
              const Text('黑边填充度', style: TextStyle(fontSize: 11, color: Color(0xFFCBD5E1))),
              const Spacer(),
              Text(
                '$pct%',
                style: const TextStyle(
                  fontSize: 11,
                  fontFamily: 'monospace',
                  color: Color(0xFF60A5FA),
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
          SliderTheme(
            data: SliderTheme.of(context).copyWith(
              trackHeight: 3,
              thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 7),
              overlayShape: const RoundSliderOverlayShape(overlayRadius: 12),
            ),
            child: Slider(
              value: _fillRatio,
              min: 0.0,
              max: 1.0,
              divisions: 20,
              onChanged: (v) => setState(() => _fillRatio = v),
              onChangeEnd: (v) => widget.storage.setFillRatio(v),
            ),
          ),
          Row(
            children: [
              quickPresetBtn('50% 均衡', 0.5),
              const SizedBox(width: 6),
              quickPresetBtn('80% 避挖孔', 0.8),
              const SizedBox(width: 6),
              quickPresetBtn('100% 全满', 1.0),
            ],
          ),
        ],
      ],
    );
  }

  Widget _buildDrawerVideoTab() {
    final presets = ScenePreset.values;
    final rows = <Widget>[];
    for (var i = 0; i < presets.length; i += 2) {
      final left = presets[i];
      final right = i + 1 < presets.length ? presets[i + 1] : null;
      Widget presetTile(ScenePreset p) {
        final selected = _preset == p;
        return Expanded(
          child: InkWell(
            borderRadius: BorderRadius.circular(10),
            onTap: () => _applyPreset(p),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
              decoration: BoxDecoration(
                color: selected ? const Color(0xFF1E3A8A) : const Color(0xFF141D2B),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(
                  color: selected ? const Color(0xFF60A5FA) : const Color(0xFF263346),
                ),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    p.label,
                    style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: Colors.white),
                  ),
                  const SizedBox(height: 1),
                  Text(
                    _shortPresetSpec(p),
                    style: const TextStyle(fontSize: 10, color: Color(0xFF94A3B8)),
                  ),
                ],
              ),
            ),
          ),
        );
      }

      rows.add(
        Padding(
          padding: const EdgeInsets.only(bottom: 6),
          child: Row(
            children: [
              presetTile(left),
              const SizedBox(width: 6),
              if (right != null) presetTile(right) else const Spacer(),
            ],
          ),
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('画质与流量预设', style: TextStyle(fontSize: 11.5, color: Color(0xFF94A3B8))),
        const SizedBox(height: 6),
        ...rows,
        const SizedBox(height: 6),
        _buildResolutionAdapterSection(),
        if (widget.session.displays.length > 1) ...[
          const SizedBox(height: 8),
          const Text('切换电脑显示器', style: TextStyle(fontSize: 11.5, color: Color(0xFF94A3B8))),
          const SizedBox(height: 5),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: widget.session.displays
                .map(
                  (d) => ChoiceChip(
                    label: Text(d.label, style: const TextStyle(fontSize: 11)),
                    selected: widget.session.activeDisplayId == d.id,
                    onSelected: (_) => widget.session.switchDisplay(d.id),
                  ),
                )
                .toList(),
          ),
        ],
      ],
    );
  }

  Widget _buildDrawerControlTab() {
    Widget modeCard(InputControlMode m, String desc) {
      final selected = _inputMode == m;
      return Expanded(
        child: InkWell(
          borderRadius: BorderRadius.circular(10),
          onTap: () async {
            await widget.storage.setInputControlMode(m);
            setState(() => _inputMode = m);
          },
          child: Container(
            padding: const EdgeInsets.all(9),
            decoration: BoxDecoration(
              color: selected ? const Color(0xFF1E3A8A) : const Color(0xFF141D2B),
              borderRadius: BorderRadius.circular(10),
              border: Border.all(
                color: selected ? const Color(0xFF60A5FA) : const Color(0xFF263346),
              ),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  m.label,
                  style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: Colors.white),
                ),
                const SizedBox(height: 2),
                Text(desc, style: const TextStyle(fontSize: 10, color: Color(0xFF94A3B8))),
              ],
            ),
          ),
        ),
      );
    }

    final hints = [('auto', '自动硬编'), ('detail', '锐利硬编'), ('motion', '低延迟')];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('触控操作方式', style: TextStyle(fontSize: 11.5, color: Color(0xFF94A3B8))),
        const SizedBox(height: 6),
        Row(
          children: [
            modeCard(InputControlMode.direct, '指哪点哪 · 长按右键'),
            const SizedBox(width: 6),
            modeCard(InputControlMode.touchpad, '双指滚轮 · 相对移动'),
          ],
        ),
        const SizedBox(height: 10),
        const Text('PC 编码策略', style: TextStyle(fontSize: 11.5, color: Color(0xFF94A3B8))),
        const SizedBox(height: 6),
        Row(
          children: hints.map((pair) {
            final selected = _contentHint == pair.$1;
            return Expanded(
              child: Padding(
                padding: EdgeInsets.only(right: pair == hints.last ? 0 : 6),
                child: InkWell(
                  borderRadius: BorderRadius.circular(8),
                  onTap: () {
                    setState(() => _contentHint = pair.$1);
                    widget.session.sendPolicy(
                      preset: _preset.id,
                      resolution: _preset.resolution,
                      fps: _preset.fps,
                      maxBitrateKbps: _preset.bitrateKbps,
                      contentHint: pair.$1,
                    );
                  },
                  child: Container(
                    padding: const EdgeInsets.symmetric(vertical: 7),
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: selected ? const Color(0xFF1E3A8A) : const Color(0xFF141D2B),
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(
                        color: selected ? const Color(0xFF60A5FA) : const Color(0xFF263346),
                      ),
                    ),
                    child: Text(
                      pair.$2,
                      style: TextStyle(
                        fontSize: 11,
                        fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
                        color: Colors.white,
                      ),
                    ),
                  ),
                ),
              ),
            );
          }).toList(),
        ),
        const SizedBox(height: 10),
        const Text('快捷输入与剪贴板', style: TextStyle(fontSize: 11.5, color: Color(0xFF94A3B8))),
        const SizedBox(height: 6),
        SizedBox(
          width: double.infinity,
          child: OutlinedButton.icon(
            onPressed: () {
              setState(() {
                _showVkb = !_showVkb;
                _drawerOpen = false;
              });
              _syncPointerCaptureWithUi();
            },
            icon: const Icon(Icons.keyboard_rounded, size: 16),
            label: Text(_showVkb ? '隐藏虚拟键盘' : '打开虚拟键盘 / 中文输入'),
          ),
        ),
        const SizedBox(height: 6),
        Row(
          children: [
            Expanded(
              child: OutlinedButton(
                onPressed: () => widget.session.sendReliable({'t': 'clip:pull'}),
                child: const Text('拉电脑剪贴板', style: TextStyle(fontSize: 11.5)),
              ),
            ),
            const SizedBox(width: 6),
            Expanded(
              child: OutlinedButton(
                onPressed: () async {
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
                child: const Text('发手机剪贴板', style: TextStyle(fontSize: 11.5)),
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        const Text('视频编码格式偏好（重连后生效）', style: TextStyle(fontSize: 11.5, color: Color(0xFF94A3B8))),
        const SizedBox(height: 6),
        Row(
          children: [
            Expanded(
              child: InkWell(
                borderRadius: BorderRadius.circular(8),
                onTap: () async {
                  await widget.storage.setPreferHevc(false);
                  if (mounted) setState(() => _preferHevc = false);
                  _showToast('已设为 H.264 通用硬解（点工具页「重连会话」生效）');
                },
                child: Container(
                  padding: const EdgeInsets.symmetric(vertical: 7),
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: !_preferHevc ? const Color(0xFF1E3A8A) : const Color(0xFF141D2B),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(
                      color: !_preferHevc ? const Color(0xFF60A5FA) : const Color(0xFF263346),
                    ),
                  ),
                  child: Text(
                    'H.264 通用硬解',
                    style: TextStyle(
                      fontSize: 11,
                      fontWeight: !_preferHevc ? FontWeight.w600 : FontWeight.w400,
                      color: Colors.white,
                    ),
                  ),
                ),
              ),
            ),
            const SizedBox(width: 6),
            Expanded(
              child: InkWell(
                borderRadius: BorderRadius.circular(8),
                onTap: () async {
                  await widget.storage.setPreferHevc(true);
                  if (mounted) setState(() => _preferHevc = true);
                  _showToast('已设为优先 H.265 (HEVC)（点工具页「重连会话」生效）');
                },
                child: Container(
                  padding: const EdgeInsets.symmetric(vertical: 7),
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: _preferHevc ? const Color(0xFF1E3A8A) : const Color(0xFF141D2B),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(
                      color: _preferHevc ? const Color(0xFF60A5FA) : const Color(0xFF263346),
                    ),
                  ),
                  child: Text(
                    'H.265 (HEVC)',
                    style: TextStyle(
                      fontSize: 11,
                      fontWeight: _preferHevc ? FontWeight.w600 : FontWeight.w400,
                      color: Colors.white,
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 8),
        SwitchListTile.adaptive(
          contentPadding: EdgeInsets.zero,
          dense: true,
          title: const Text(
            '外接鼠标无限边界捕获 (Pointer Capture)',
            style: TextStyle(fontSize: 11.5, color: Color(0xFFE2E8F0)),
          ),
          subtitle: const Text(
            '外接实体鼠标全屏零边界相对移动；打开抽屉或键盘时自动暂释',
            style: TextStyle(fontSize: 10, color: Color(0xFF94A3B8)),
          ),
          value: _pointerCaptureEnabled,
          onChanged: (v) async {
            await widget.storage.setPointerCaptureEnabled(v);
            if (!mounted) return;
            setState(() => _pointerCaptureEnabled = v);
            _syncPointerCaptureWithUi();
            _showToast(v ? '已开启外接鼠标 Pointer Capture（收起抽屉后生效）' : '已关闭 Pointer Capture');
          },
        ),
        SwitchListTile.adaptive(
          contentPadding: EdgeInsets.zero,
          dense: true,
          title: const Text(
            '切回前台自动同步剪贴板',
            style: TextStyle(fontSize: 11.5, color: Color(0xFFE2E8F0)),
          ),
          subtitle: const Text(
            '切回 App 且允许操控时，自动把手机新复制的文本发往电脑',
            style: TextStyle(fontSize: 10, color: Color(0xFF94A3B8)),
          ),
          value: _autoSyncClipboard,
          onChanged: (v) async {
            await widget.storage.setAutoSyncClipboard(v);
            if (!mounted) return;
            setState(() => _autoSyncClipboard = v);
          },
        ),
      ],
    );
  }

  String _formatFileBytes(int bytes) {
    if (bytes < 1024) return '$bytes B';
    if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
    return '${(bytes / (1024 * 1024)).toStringAsFixed(2)} MB';
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

  Widget _buildDrawerToolsTab() {
    Widget toolTile({
      required IconData icon,
      required String title,
      required String subtitle,
      required VoidCallback onTap,
      bool active = false,
    }) {
      return Expanded(
        child: InkWell(
          borderRadius: BorderRadius.circular(10),
          onTap: onTap,
          child: Container(
            padding: const EdgeInsets.all(9),
            decoration: BoxDecoration(
              color: active ? const Color(0xFF172554) : const Color(0xFF141D2B),
              borderRadius: BorderRadius.circular(10),
              border: Border.all(
                color: active ? const Color(0xFF60A5FA) : const Color(0xFF263346),
              ),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(icon, size: 17, color: active ? const Color(0xFF60A5FA) : const Color(0xFFCBD5E1)),
                const SizedBox(height: 4),
                Text(
                  title,
                  style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: Colors.white),
                ),
                Text(subtitle, style: const TextStyle(fontSize: 10, color: Color(0xFF94A3B8))),
              ],
            ),
          ),
        ),
      );
    }

    final hasAudio = widget.session.hostAudioEnabled;
    final audioLabel = !hasAudio
        ? '点此一键开启'
        : (widget.session.audioMuted ? '已静音 · 点此恢复' : '同步中 · 点此关闭');

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            toolTile(
              icon: (!hasAudio || widget.session.audioMuted) ? Icons.volume_off : Icons.volume_up,
              title: '电脑声音',
              subtitle: audioLabel,
              active: hasAudio && !widget.session.audioMuted,
              onTap: _toggleAudioFromUi,
            ),
            const SizedBox(width: 6),
            toolTile(
              icon: Icons.speed_rounded,
              title: '诊断 HUD',
              subtitle: _showHud ? '已开启悬浮层' : '已隐藏',
              active: _showHud,
              onTap: _toggleHudFromUi,
            ),
          ],
        ),
        const SizedBox(height: 6),
        Row(
          children: [
            toolTile(
              icon: Icons.picture_in_picture_alt_rounded,
              title: '画中画小窗',
              subtitle: '挂起悬浮看屏',
              onTap: () async {
                setState(() => _drawerOpen = false);
                final ok = await NativeBridge.enterPipMode();
                if (!ok) _showToast('当前系统或桌面模式不支持画中画');
              },
            ),
            const SizedBox(width: 6),
            toolTile(
              icon: Icons.refresh_rounded,
              title: '重连会话',
              subtitle: '刷新视频链路',
              onTap: () {
                setState(() => _drawerOpen = false);
                widget.session.reconnectSaved();
              },
            ),
          ],
        ),
        const SizedBox(height: 10),
        const Text('双向文件互传 (独立通道)', style: TextStyle(fontSize: 11.5, color: Color(0xFF94A3B8))),
        const SizedBox(height: 5),
        ListenableBuilder(
          listenable: widget.session,
          builder: (_, _) {
            final ready = widget.session.fileChannelReady;
            final active = widget.session.activeFileTransfer;
            final history = widget.session.recentTransfers;
            return Container(
              width: double.infinity,
              padding: const EdgeInsets.all(9),
              decoration: BoxDecoration(
                color: const Color(0x99070B11),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: const Color(0xFF243041)),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: double.infinity,
                    child: FilledButton.tonalIcon(
                      onPressed: (!ready || active != null) ? null : _pickAndSendFile,
                      icon: const Icon(Icons.upload_file_rounded, size: 16),
                      label: Text(
                        ready ? '选择文件发送给电脑' : '文件通道等待就绪...',
                        style: const TextStyle(fontSize: 12),
                      ),
                    ),
                  ),
                  if (active != null) ...[
                    const SizedBox(height: 7),
                    Text(
                      '${active.isOutgoing ? "↑ 发送" : "↓ 接收"} ${active.name} (${_formatFileBytes(active.transferredBytes)} / ${_formatFileBytes(active.totalBytes)})',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 10.5, color: Color(0xFF93C5FD)),
                    ),
                    const SizedBox(height: 4),
                    LinearProgressIndicator(
                      value: active.progress,
                      minHeight: 4,
                      borderRadius: BorderRadius.circular(4),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      active.message,
                      style: const TextStyle(fontSize: 10, color: Color(0xFF94A3B8)),
                    ),
                  ] else if (history.isEmpty) ...[
                    const SizedBox(height: 5),
                    const Text(
                      '电脑发来的文件将自动保存至 Download/AirDesk',
                      style: TextStyle(fontSize: 10, color: Color(0xFF94A3B8)),
                    ),
                  ],
                  for (final item in history.take(3)) ...[
                    const SizedBox(height: 4),
                    Text(
                      '${item.state == FileTransferState.completed ? "✓" : "✕"} ${item.isOutgoing ? "发出" : "收到"} ${item.name}${item.savedPath != null ? " (${item.savedPath})" : ""}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 10,
                        color: item.state == FileTransferState.completed
                            ? const Color(0xFF34D399)
                            : const Color(0xFFF87171),
                      ),
                    ),
                  ],
                ],
              ),
            );
          },
        ),
        const SizedBox(height: 10),
        const Text('实时链路状态', style: TextStyle(fontSize: 11.5, color: Color(0xFF94A3B8))),
        const SizedBox(height: 5),
        ListenableBuilder(
          listenable: widget.session,
          builder: (_, _) {
            final t = widget.session.telemetry;
            final rttStr = t.rttMs != null ? '${t.rttMs}ms' : '--';
            final encHw = t.txHw == null ? '' : (t.txHw! ? '硬编' : '软编');
            final decHw = t.rxHw == null ? '' : (t.rxHw! ? '硬解' : '软解');
            return Container(
              width: double.infinity,
              padding: const EdgeInsets.all(9),
              decoration: BoxDecoration(
                color: const Color(0x99070B11),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: const Color(0xFF243041)),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '编码 ${t.txW ?? "--"}×${t.txH ?? "--"} @ ${t.txFps ?? "--"}fps · $encHw ${t.encodeMs ?? "--"}ms · RTT $rttStr',
                    style: const TextStyle(fontSize: 10.5, fontFamily: 'monospace', color: Color(0xFF34D399)),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    '解码 ${t.rxFps ?? "--"}fps · $decHw ${t.decodeMs ?? "--"}ms · 缓冲 ${t.jbMs ?? "--"}ms · 掉帧 ${t.dropped ?? 0}',
                    style: const TextStyle(fontSize: 10.5, fontFamily: 'monospace', color: Color(0xFF93C5FD)),
                  ),
                ],
              ),
            );
          },
        ),
      ],
    );
  }

  Widget _buildControlDrawer() {
    final tabLabels = ['画面', '操控', '工具'];
    final ctrlEnabled = widget.session.controlEnabled;
    final hasAudio = widget.session.hostAudioEnabled && !widget.session.audioMuted;

    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(
        color: const Color(0xE20B111A),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFF334155)),
        boxShadow: const [BoxShadow(color: Colors.black87, blurRadius: 20)],
      ),
      child: Column(
        children: [
          // Fixed Header
          Row(
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                decoration: BoxDecoration(
                  color: ctrlEnabled ? const Color(0x2234D399) : const Color(0x22FBBF24),
                  borderRadius: BorderRadius.circular(99),
                  border: Border.all(
                    color: ctrlEnabled ? const Color(0xFF34D399) : const Color(0xFFFBBF24),
                  ),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Container(
                      width: 7,
                      height: 7,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: ctrlEnabled ? const Color(0xFF34D399) : const Color(0xFFFBBF24),
                      ),
                    ),
                    const SizedBox(width: 5),
                    Text(
                      ctrlEnabled ? '允许操控' : '仅观看',
                      style: TextStyle(
                        fontSize: 11.5,
                        fontWeight: FontWeight.w600,
                        color: ctrlEnabled ? const Color(0xFF34D399) : const Color(0xFFFBBF24),
                      ),
                    ),
                  ],
                ),
              ),
              const Spacer(),
              IconButton(
                tooltip: '声音开关',
                visualDensity: VisualDensity.compact,
                onPressed: _toggleAudioFromUi,
                icon: Icon(
                  hasAudio ? Icons.volume_up_rounded : Icons.volume_off_rounded,
                  size: 18,
                  color: hasAudio ? const Color(0xFF60A5FA) : const Color(0xFF94A3B8),
                ),
              ),
              IconButton(
                tooltip: '诊断 HUD',
                visualDensity: VisualDensity.compact,
                onPressed: _toggleHudFromUi,
                icon: Icon(
                  Icons.speed_rounded,
                  size: 18,
                  color: _showHud ? const Color(0xFF34D399) : const Color(0xFF94A3B8),
                ),
              ),
              IconButton(
                tooltip: '收起',
                visualDensity: VisualDensity.compact,
                onPressed: () {
                  setState(() => _drawerOpen = false);
                  _syncPointerCaptureWithUi();
                },
                icon: const Icon(Icons.close_rounded, size: 18),
              ),
            ],
          ),
          const SizedBox(height: 6),
          // Segmented 3-tab Switcher
          Container(
            padding: const EdgeInsets.all(3),
            decoration: BoxDecoration(
              color: const Color(0xFF070B11),
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: const Color(0xFF1E293B)),
            ),
            child: Row(
              children: List.generate(tabLabels.length, (i) {
                final selected = _drawerTab == i;
                return Expanded(
                  child: GestureDetector(
                    onTap: () => setState(() => _drawerTab = i),
                    child: Container(
                      padding: const EdgeInsets.symmetric(vertical: 5),
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        color: selected ? const Color(0xFF2563EB) : Colors.transparent,
                        borderRadius: BorderRadius.circular(7),
                      ),
                      child: Text(
                        tabLabels[i],
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
                          color: selected ? Colors.white : const Color(0xFF94A3B8),
                        ),
                      ),
                    ),
                  ),
                );
              }),
            ),
          ),
          const SizedBox(height: 8),
          // Scrollable Active Tab Content
          Expanded(
            child: SingleChildScrollView(
              child: switch (_drawerTab) {
                0 => _buildDrawerVideoTab(),
                1 => _buildDrawerControlTab(),
                _ => _buildDrawerToolsTab(),
              },
            ),
          ),
          const SizedBox(height: 8),
          // Fixed Bottom Disconnect Button
          SizedBox(
            width: double.infinity,
            height: 36,
            child: FilledButton.icon(
              style: FilledButton.styleFrom(
                backgroundColor: const Color(0xFFDC2626),
                padding: const EdgeInsets.symmetric(horizontal: 12),
              ),
              onPressed: _exitStage,
              icon: const Icon(Icons.power_settings_new_rounded, size: 16),
              label: const Text('断开连接并返回', style: TextStyle(fontSize: 12.5)),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildVirtualKeyboard() {
    Widget keyBtn(String label, {String? code, String? mod, VoidCallback? onTap}) {
      final isModActive = mod != null && _lockedMods.contains(mod);
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: 2),
        child: InkWell(
          onTap: onTap ??
              () {
                if (mod != null) {
                  _toggleMod(mod);
                } else if (code != null) {
                  _sendKeyTap(code);
                }
              },
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
            decoration: BoxDecoration(
              color: isModActive ? const Color(0xFF2563EB) : const Color(0xFF1E293B),
              borderRadius: BorderRadius.circular(7),
              border: Border.all(color: const Color(0xFF475569)),
            ),
            child: Text(label, style: const TextStyle(fontSize: 12, fontFamily: 'monospace')),
          ),
        ),
      );
    }

    return Container(
      padding: const EdgeInsets.fromLTRB(10, 8, 10, 10),
      decoration: const BoxDecoration(
        color: Color(0xEB090D14),
        border: Border(top: BorderSide(color: Color(0x4494A3B8))),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _imeCtrl,
                  decoration: const InputDecoration(
                    hintText: '输入中文或任意文本后点右侧发送...',
                    isDense: true,
                    contentPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                    border: OutlineInputBorder(),
                  ),
                ),
              ),
              const SizedBox(width: 6),
              FilledButton(
                onPressed: () {
                  final txt = _imeCtrl.text;
                  if (txt.isEmpty) return;
                  widget.session.sendReliable({'t': 'text:unicode', 'text': txt});
                  _imeCtrl.clear();
                },
                child: const Text('发送文本'),
              ),
              IconButton(
                onPressed: () {
                  setState(() => _showVkb = false);
                  _syncPointerCaptureWithUi();
                },
                icon: const Icon(Icons.keyboard_hide_rounded),
              ),
            ],
          ),
          const SizedBox(height: 6),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                keyBtn('Esc', code: 'Escape'),
                keyBtn('Tab', code: 'Tab'),
                keyBtn('Ctrl', mod: 'ControlLeft'),
                keyBtn('Alt', mod: 'AltLeft'),
                keyBtn('Shift', mod: 'ShiftLeft'),
                keyBtn('Win', mod: 'MetaLeft'),
                keyBtn('Bksp', code: 'Backspace'),
                keyBtn('Del', code: 'Delete'),
                keyBtn('Enter', code: 'Enter'),
                keyBtn('←', code: 'ArrowLeft'),
                keyBtn('↑', code: 'ArrowUp'),
                keyBtn('↓', code: 'ArrowDown'),
                keyBtn('→', code: 'ArrowRight'),
                keyBtn('Ctrl+C', onTap: () => _sendCombo(['ControlLeft', 'KeyC'])),
                keyBtn('Ctrl+V', onTap: () => _sendCombo(['ControlLeft', 'KeyV'])),
                keyBtn('Ctrl+Z', onTap: () => _sendCombo(['ControlLeft', 'KeyZ'])),
                keyBtn('Alt+Tab', onTap: () => _sendCombo(['AltLeft', 'Tab'])),
                keyBtn('Win+D', onTap: () => _sendCombo(['MetaLeft', 'KeyD'])),
                keyBtn(
                  'Ctrl+Alt+Del',
                  onTap: () {
                    if (!widget.session.controlEnabled) return;
                    widget.session.sendReliable({'t': 'sys:sas'});
                  },
                ),
                keyBtn('F4', code: 'F4'),
                keyBtn('F5', code: 'F5'),
                keyBtn('F11', code: 'F11'),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
