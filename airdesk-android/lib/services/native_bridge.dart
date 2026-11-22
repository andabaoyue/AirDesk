import 'dart:async';
import 'package:flutter/services.dart';

class NativeInputEvent {
  final String kind; // 'k:down' | 'k:up' | 'm:btn' | 'm:rel' | 'm:whl'
  final String? code;
  final String? button;
  final String? state;
  final double? dx;
  final double? dy;

  const NativeInputEvent({
    required this.kind,
    this.code,
    this.button,
    this.state,
    this.dx,
    this.dy,
  });

  factory NativeInputEvent.fromMap(Map<dynamic, dynamic> m) {
    return NativeInputEvent(
      kind: (m['t'] ?? '').toString(),
      code: m['code']?.toString(),
      button: m['button']?.toString(),
      state: m['state']?.toString(),
      dx: (m['dx'] as num?)?.toDouble(),
      dy: (m['dy'] as num?)?.toDouble(),
    );
  }
}

class PickedLocalFile {
  final String path;
  final String name;
  final int size;
  final String mime;

  const PickedLocalFile({
    required this.path,
    required this.name,
    required this.size,
    required this.mime,
  });
}

class NativeBridge {
  static const _method = MethodChannel('dev.airdesk.app/native');
  static const _events = EventChannel('dev.airdesk.app/input_events');

  static Stream<NativeInputEvent>? _cachedStream;

  static Stream<NativeInputEvent> get hardwareInputEvents {
    _cachedStream ??= _events
        .receiveBroadcastStream()
        .where((e) => e is Map)
        .map((e) => NativeInputEvent.fromMap(e as Map<dynamic, dynamic>));
    return _cachedStream!;
  }

  static Future<String> getDeviceModelName() async {
    try {
      final res = await _method.invokeMethod<String>('getDeviceModel');
      if (res != null && res.trim().isNotEmpty) return res.trim();
    } catch (_) {}
    return 'Android 设备';
  }

  static Future<void> enterStreamFullscreen() async {
    try {
      await _method.invokeMethod('enterStreamFullscreen');
    } catch (_) {}
  }

  static Future<void> exitStreamFullscreen() async {
    try {
      await _method.invokeMethod('exitStreamFullscreen');
    } catch (_) {}
  }

  static Future<void> setLowLatencyLocks(bool enabled) async {
    try {
      await _method.invokeMethod('setLowLatencyLocks', {'enabled': enabled});
    } catch (_) {}
  }

  static Future<void> setCaptureExternalInput(bool enabled) async {
    try {
      await _method.invokeMethod('setCaptureExternalInput', {'enabled': enabled});
    } catch (_) {}
  }

  static Future<void> setPointerCapture(bool enabled) async {
    try {
      await _method.invokeMethod('setPointerCapture', {'enabled': enabled});
    } catch (_) {}
  }

  static Future<bool> enterPipMode({int width = 16, int height = 9}) async {
    try {
      final ok = await _method.invokeMethod<bool>('enterPipMode', {
        'width': width,
        'height': height,
      });
      return ok ?? false;
    } catch (_) {
      return false;
    }
  }

  static Future<bool> isIgnoringBatteryOptimizations() async {
    try {
      final ok = await _method.invokeMethod<bool>('isIgnoringBatteryOptimizations');
      return ok ?? false;
    } catch (_) {
      return false;
    }
  }

  static Future<void> requestIgnoreBatteryOptimizations() async {
    try {
      await _method.invokeMethod('requestIgnoreBatteryOptimizations');
    } catch (_) {}
  }

  static Future<void> setAllowOverlayTun(bool enabled) async {
    try {
      await _method.invokeMethod('setAllowOverlayTun', {'enabled': enabled});
    } catch (_) {}
  }

  static Future<void> setLanOnlyNetFilter(bool enabled) async {
    try {
      await _method.invokeMethod('setLanOnlyNetFilter', {'enabled': enabled});
    } catch (_) {}
  }

  static Future<({bool hasTailscale, String? tailscaleIp, List<String> overlayIps})>
      getOverlayNetworkInfo() async {
    try {
      final raw = await _method.invokeMethod<dynamic>('getOverlayNetworkInfo');
      if (raw is Map) {
        final tsIp = raw['tailscaleIp']?.toString();
        final ipsRaw = raw['overlayIps'];
        final ips = ipsRaw is List
            ? ipsRaw.map((e) => e.toString()).where((s) => s.isNotEmpty).toList()
            : <String>[];
        return (
          hasTailscale: raw['hasTailscale'] == true,
          tailscaleIp: (tsIp != null && tsIp.isNotEmpty) ? tsIp : null,
          overlayIps: ips,
        );
      }
    } catch (_) {}
    return (hasTailscale: false, tailscaleIp: null, overlayIps: <String>[]);
  }

  static Future<PickedLocalFile?> pickFileForTransfer() async {
    try {
      final raw = await _method.invokeMethod<dynamic>('pickFileForTransfer');
      if (raw is Map) {
        final path = (raw['path'] ?? '').toString();
        final name = (raw['name'] ?? '').toString();
        final size = (raw['size'] as num?)?.toInt() ?? 0;
        final mime = (raw['mime'] ?? 'application/octet-stream').toString();
        if (path.isNotEmpty && name.isNotEmpty) {
          return PickedLocalFile(path: path, name: name, size: size, mime: mime);
        }
      }
    } catch (_) {}
    return null;
  }

  static Future<({bool ok, String savedName, String displayPath, String? error})>
      saveFileToDownloads({
    required String tempPath,
    required String fileName,
    String mimeType = 'application/octet-stream',
  }) async {
    try {
      final raw = await _method.invokeMethod<dynamic>('saveFileToDownloads', {
        'tempPath': tempPath,
        'fileName': fileName,
        'mimeType': mimeType,
      });
      if (raw is Map) {
        return (
          ok: raw['ok'] == true,
          savedName: (raw['savedName'] ?? fileName).toString(),
          displayPath: (raw['displayPath'] ?? '').toString(),
          error: raw['error']?.toString(),
        );
      }
    } catch (e) {
      return (ok: false, savedName: fileName, displayPath: '', error: e.toString());
    }
    return (ok: false, savedName: fileName, displayPath: '', error: 'Unknown save error');
  }

  static Future<String?> scanQrCode() async {
    try {
      final raw = await _method.invokeMethod<String>('scanQrCode');
      if (raw != null && raw.trim().isNotEmpty) {
        return raw.trim();
      }
    } catch (_) {}
    return null;
  }
}
