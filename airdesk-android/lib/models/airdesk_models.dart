class SavedRemoteHost {
  final String label;
  final String ip;
  final int port;
  final int lastUsedMs;

  const SavedRemoteHost({
    required this.label,
    required this.ip,
    this.port = 47820,
    required this.lastUsedMs,
  });

  Map<String, dynamic> toJson() => {
        'label': label,
        'ip': ip,
        'port': port,
        'lastUsedMs': lastUsedMs,
      };

  factory SavedRemoteHost.fromJson(Map<String, dynamic> j) => SavedRemoteHost(
        label: (j['label'] ?? '').toString(),
        ip: (j['ip'] ?? '').toString(),
        port: (j['port'] as num?)?.toInt() ?? 47820,
        lastUsedMs: (j['lastUsedMs'] as num?)?.toInt() ?? 0,
      );
}

class AirDeskHostInfo {
  final String hostname;
  final String ip;
  final int port;
  final String version;
  final List<String> allAddresses;
  final bool hasTrustedToken;

  const AirDeskHostInfo({
    required this.hostname,
    required this.ip,
    this.port = 47820,
    this.version = '',
    this.allAddresses = const [],
    this.hasTrustedToken = false,
  });

  String get httpBaseUrl => 'http://$ip:$port';
  String get wsUrl => 'ws://$ip:$port/ws/signaling';
  String get hostKey => '$hostname@$ip:$port';
}

enum ScenePreset {
  officeClear('office_clear', '清晰办公', '1080p@30 · 12Mbps · 锐利稳帧', '1080p', 30, 12000, 'auto'),
  ultraFast('ultra_fast', '极速跟手', '900p@60 · 10Mbps · 零卡顿', '900p', 60, 10000, 'motion'),
  highFps('high_fps', '高刷流畅', '900p@60 · 20Mbps · 高清高刷', '900p', 60, 20000, 'auto'),
  nativeUltra('native_ultra', '极清原生', '原生@30 · 30Mbps · 点对点', 'native', 30, 30000, 'detail'),
  remoteNet('remote_net', '异地省流', '900p@30 · 5Mbps · 跨网稳连', '900p', 30, 5000, 'auto'),
  powerSaver('power_saver', '省电伴随', '720p@20 · 4Mbps · 续航', '720p', 20, 4000, 'motion');

  final String id;
  final String label;
  final String subtitle;
  final String resolution;
  final int fps;
  final int bitrateKbps;
  final String contentHint;

  const ScenePreset(
    this.id,
    this.label,
    this.subtitle,
    this.resolution,
    this.fps,
    this.bitrateKbps,
    this.contentHint,
  );

  static ScenePreset fromId(String? id) {
    return ScenePreset.values.firstWhere(
      (e) => e.id == id,
      orElse: () => ScenePreset.officeClear,
    );
  }
}

enum ViewScaleMode {
  adaptiveFill('adaptive_fill', '自适应铺满'),
  contain('contain', '原比例完整'),
  freeZoom('free_zoom', '自由缩放漫游');

  final String id;
  final String label;

  const ViewScaleMode(this.id, this.label);

  static ViewScaleMode fromId(String? id) {
    if (id == 'cover' || id == 'adaptive_fill') {
      return ViewScaleMode.adaptiveFill;
    }
    return ViewScaleMode.values.firstWhere(
      (e) => e.id == id,
      orElse: () => ViewScaleMode.adaptiveFill,
    );
  }
}

enum InputControlMode {
  touchpad('touchpad', '笔记本触控板'),
  direct('direct', '屏幕直接触控');

  final String id;
  final String label;

  const InputControlMode(this.id, this.label);

  static InputControlMode fromId(String? id) {
    return InputControlMode.values.firstWhere(
      (e) => e.id == id,
      orElse: () => InputControlMode.direct,
    );
  }
}

class RemoteDisplayInfo {
  final String id;
  final String label;
  final int width;
  final int height;
  final double scaleFactor;
  final bool isPrimary;

  const RemoteDisplayInfo({
    required this.id,
    required this.label,
    required this.width,
    required this.height,
    required this.scaleFactor,
    required this.isPrimary,
  });

  factory RemoteDisplayInfo.fromJson(Map<String, dynamic> json) {
    return RemoteDisplayInfo(
      id: (json['id'] ?? '').toString(),
      label: (json['label'] ?? '显示器').toString(),
      width: (json['width'] as num?)?.toInt() ?? 1920,
      height: (json['height'] as num?)?.toInt() ?? 1080,
      scaleFactor: (json['scaleFactor'] as num?)?.toDouble() ?? 1.0,
      isPrimary: json['isPrimary'] == true,
    );
  }
}

class TelemetrySnapshot {
  // PC TX (diag:tx)
  final num? txFps;
  final num? encodeMs;
  final String encoder;
  final bool? txHw;
  final String codec;
  final int? txW;
  final int? txH;
  final String limitReason;
  final int? rttMs;
  final String contentHint;

  // Phone RX (inbound-rtp)
  final num? rxFps;
  final num? decodeMs;
  final String decoder;
  final bool? rxHw;
  final int? jbMs;
  final int? jbTargetMs;
  final int? jbMinMs;
  final int? jbSettingMs;
  final int? dropped;
  final int? freezes;
  final int? rxW;
  final int? rxH;

  const TelemetrySnapshot({
    this.txFps,
    this.encodeMs,
    this.encoder = '',
    this.txHw,
    this.codec = '',
    this.txW,
    this.txH,
    this.limitReason = 'none',
    this.rttMs,
    this.contentHint = '',
    this.rxFps,
    this.decodeMs,
    this.decoder = '',
    this.rxHw,
    this.jbMs,
    this.jbTargetMs,
    this.jbMinMs,
    this.jbSettingMs,
    this.dropped,
    this.freezes,
    this.rxW,
    this.rxH,
  });

  TelemetrySnapshot copyWithTx(Map<String, dynamic> d) {
    return TelemetrySnapshot(
      txFps: d['txFps'] as num?,
      encodeMs: d['encodeMs'] as num?,
      encoder: (d['encoder'] ?? '').toString(),
      txHw: d['hw'] is bool ? d['hw'] as bool : null,
      codec: (d['codec'] ?? '').toString(),
      txW: (d['w'] as num?)?.toInt(),
      txH: (d['h'] as num?)?.toInt(),
      limitReason: (d['limit'] ?? 'none').toString(),
      rttMs: (d['rttMs'] as num?)?.toInt() ?? rttMs,
      contentHint: (d['contentHint'] ?? '').toString(),
      rxFps: rxFps,
      decodeMs: decodeMs,
      decoder: decoder,
      rxHw: rxHw,
      jbMs: jbMs,
      jbTargetMs: jbTargetMs,
      jbMinMs: jbMinMs,
      jbSettingMs: jbSettingMs,
      dropped: dropped,
      freezes: freezes,
      rxW: rxW,
      rxH: rxH,
    );
  }

  TelemetrySnapshot copyWithRx({
    num? rxFps,
    num? decodeMs,
    String? decoder,
    bool? rxHw,
    int? jbMs,
    int? jbTargetMs,
    int? jbMinMs,
    int? jbSettingMs,
    int? dropped,
    int? freezes,
    int? rxW,
    int? rxH,
    int? rttMs,
  }) {
    return TelemetrySnapshot(
      txFps: txFps,
      encodeMs: encodeMs,
      encoder: encoder,
      txHw: txHw,
      codec: codec,
      txW: txW,
      txH: txH,
      limitReason: limitReason,
      rttMs: rttMs ?? this.rttMs,
      contentHint: contentHint,
      rxFps: rxFps ?? this.rxFps,
      decodeMs: decodeMs ?? this.decodeMs,
      decoder: decoder ?? this.decoder,
      rxHw: rxHw ?? this.rxHw,
      jbMs: jbMs ?? this.jbMs,
      jbTargetMs: jbTargetMs ?? this.jbTargetMs,
      jbMinMs: jbMinMs ?? this.jbMinMs,
      jbSettingMs: jbSettingMs ?? this.jbSettingMs,
      dropped: dropped ?? this.dropped,
      freezes: freezes ?? this.freezes,
      rxW: rxW ?? this.rxW,
      rxH: rxH ?? this.rxH,
    );
  }
}

enum FileTransferState {
  negotiating,
  transferring,
  finalizing,
  completed,
  failed,
}

class FileTransferProgress {
  final String id;
  final String name;
  final int totalBytes;
  final int transferredBytes;
  final bool isOutgoing;
  final FileTransferState state;
  final String message;
  final String? savedPath;

  const FileTransferProgress({
    required this.id,
    required this.name,
    required this.totalBytes,
    required this.transferredBytes,
    required this.isOutgoing,
    required this.state,
    this.message = '',
    this.savedPath,
  });

  double get progress =>
      totalBytes > 0 ? (transferredBytes / totalBytes).clamp(0.0, 1.0) : 1.0;

  FileTransferProgress copyWith({
    int? transferredBytes,
    FileTransferState? state,
    String? message,
    String? savedPath,
  }) {
    return FileTransferProgress(
      id: id,
      name: name,
      totalBytes: totalBytes,
      transferredBytes: transferredBytes ?? this.transferredBytes,
      isOutgoing: isOutgoing,
      state: state ?? this.state,
      message: message ?? this.message,
      savedPath: savedPath ?? this.savedPath,
    );
  }
}
