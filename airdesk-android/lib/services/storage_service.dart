import 'dart:convert';
import 'package:shared_preferences/shared_preferences.dart';
import '../models/airdesk_models.dart';

class RecentHostEntry {
  final String ip;
  final int port;
  final String hostname;
  final int lastUsedMs;

  const RecentHostEntry({
    required this.ip,
    required this.port,
    required this.hostname,
    required this.lastUsedMs,
  });

  Map<String, dynamic> toJson() => {
        'ip': ip,
        'port': port,
        'hostname': hostname,
        'lastUsedMs': lastUsedMs,
      };

  factory RecentHostEntry.fromJson(Map<String, dynamic> j) => RecentHostEntry(
        ip: (j['ip'] ?? '').toString(),
        port: (j['port'] as num?)?.toInt() ?? 47820,
        hostname: (j['hostname'] ?? '').toString(),
        lastUsedMs: (j['lastUsedMs'] as num?)?.toInt() ?? 0,
      );
}

class StorageService {
  static const _kTokensMap = 'airdesk_trusted_tokens_v1';
  static const _kRelayHostIdsMap = 'airdesk_relay_host_ids_v1';
  static const _kRecentHosts = 'airdesk_recent_hosts_v1';
  static const _kRemoteHosts = 'airdesk_remote_hosts_v1';
  static const _kAllowOverlayTun = 'airdesk_allow_overlay_tun_v1';
  static const _kRemoteRelayUrl = 'airdesk_remote_relay_url_v1';
  static const _kCustomIceUrl = 'airdesk_custom_ice_url_v1';
  static const _kForceTurnRelay = 'airdesk_force_turn_relay_v1';
  static const _kPreset = 'airdesk_scene_preset_v1';
  static const _kScaleMode = 'airdesk_scale_mode_v1';
  static const _kFillRatio = 'airdesk_fill_ratio_v1';
  static const _kInputMode = 'airdesk_input_mode_v1';
  static const _kJitterMs = 'airdesk_jitter_ms_v1';
  static const _kShowHud = 'airdesk_show_hud_v2';
  static const _kDeviceLabel = 'airdesk_device_label_v1';
  static const _kPreferHevc = 'airdesk_prefer_hevc_v1';
  static const _kPointerCapture = 'airdesk_pointer_capture_v1';
  static const _kAutoClipboard = 'airdesk_auto_clipboard_v1';

  Future<Map<String, String>> _getTokensMap() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_kTokensMap);
    if (raw == null || raw.isEmpty) return {};
    try {
      final decoded = jsonDecode(raw) as Map<String, dynamic>;
      return decoded.map((k, v) => MapEntry(k, v.toString()));
    } catch (_) {
      return {};
    }
  }

  Future<String?> getTokenForKey(String key) async {
    final map = await _getTokensMap();
    return map[key];
  }

  Future<void> saveTokenForKey(String key, String token) async {
    final prefs = await SharedPreferences.getInstance();
    final map = await _getTokensMap();
    map[key] = token;
    await prefs.setString(_kTokensMap, jsonEncode(map));
  }

  Future<void> removeTokenForKey(String key) async {
    final prefs = await SharedPreferences.getInstance();
    final map = await _getTokensMap();
    map.remove(key);
    await prefs.setString(_kTokensMap, jsonEncode(map));
  }

  Future<String?> getTokenForRelay(String baseKey, {String? hostId}) async {
    final cleanHostId = hostId?.trim() ?? '';
    final tokensMap = await _getTokensMap();
    if (cleanHostId.isNotEmpty) {
      final scoped = tokensMap['$baseKey:$cleanHostId'];
      if (scoped != null && scoped.isNotEmpty) return scoped;
    }
    final legacy = tokensMap[baseKey];
    if (legacy == null || legacy.isEmpty) return null;
    if (cleanHostId.isEmpty) return legacy;
    final savedLegacyHostId = await getHostIdForKey(baseKey);
    if (savedLegacyHostId != null &&
        savedLegacyHostId.isNotEmpty &&
        savedLegacyHostId == cleanHostId) {
      return legacy;
    }
    return null;
  }

  Future<void> removeTokenForRelay(String baseKey, {String? hostId}) async {
    final cleanHostId = hostId?.trim() ?? '';
    final prefs = await SharedPreferences.getInstance();
    final tokensMap = await _getTokensMap();
    var changed = false;
    if (cleanHostId.isNotEmpty && tokensMap.remove('$baseKey:$cleanHostId') != null) {
      changed = true;
    }
    if (cleanHostId.isEmpty) {
      if (tokensMap.remove(baseKey) != null) changed = true;
    } else {
      final savedLegacyHostId = await getHostIdForKey(baseKey);
      if (savedLegacyHostId != null &&
          savedLegacyHostId.isNotEmpty &&
          savedLegacyHostId == cleanHostId) {
        if (tokensMap.remove(baseKey) != null) changed = true;
      }
    }
    if (changed) {
      await prefs.setString(_kTokensMap, jsonEncode(tokensMap));
    }
  }

  Future<String?> getTokenForHost(String ip, int port) =>
      getTokenForKey('$ip:$port');

  Future<void> saveTokenForHost(String ip, int port, String token) =>
      saveTokenForKey('$ip:$port', token);

  Future<void> removeTokenForHost(String ip, int port) =>
      removeTokenForKey('$ip:$port');

  Future<Map<String, String>> _getHostIdsMap() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_kRelayHostIdsMap);
    if (raw == null || raw.isEmpty) return {};
    try {
      final decoded = jsonDecode(raw) as Map<String, dynamic>;
      return decoded.map((k, v) => MapEntry(k, v.toString()));
    } catch (_) {
      return {};
    }
  }

  Future<String?> getHostIdForKey(String key) async {
    final map = await _getHostIdsMap();
    final val = map[key]?.trim();
    return (val != null && val.isNotEmpty) ? val : null;
  }

  Future<void> saveHostIdForKey(String key, String hostId) async {
    final clean = hostId.trim();
    if (clean.isEmpty) return;
    final prefs = await SharedPreferences.getInstance();
    final map = await _getHostIdsMap();
    map[key] = clean;
    await prefs.setString(_kRelayHostIdsMap, jsonEncode(map));
  }

  Future<void> removeHostIdForKey(String key) async {
    final prefs = await SharedPreferences.getInstance();
    final map = await _getHostIdsMap();
    map.remove(key);
    await prefs.setString(_kRelayHostIdsMap, jsonEncode(map));
  }

  Future<List<RecentHostEntry>> getRecentHosts() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_kRecentHosts);
    if (raw == null || raw.isEmpty) return [];
    try {
      final arr = jsonDecode(raw) as List<dynamic>;
      return arr
          .whereType<Map<String, dynamic>>()
          .map(RecentHostEntry.fromJson)
          .where((e) => e.ip.isNotEmpty)
          .toList()
        ..sort((a, b) => b.lastUsedMs.compareTo(a.lastUsedMs));
    } catch (_) {
      return [];
    }
  }

  Future<void> saveRecentHost(String ip, int port, String hostname) async {
    final prefs = await SharedPreferences.getInstance();
    final current = await getRecentHosts();
    current.removeWhere((e) => e.ip == ip && e.port == port);
    current.insert(
      0,
      RecentHostEntry(
        ip: ip,
        port: port,
        hostname: hostname,
        lastUsedMs: DateTime.now().millisecondsSinceEpoch,
      ),
    );
    if (current.length > 6) current.removeRange(6, current.length);
    await prefs.setString(
      _kRecentHosts,
      jsonEncode(current.map((e) => e.toJson()).toList()),
    );
  }

  Future<ScenePreset> getScenePreset() async {
    final prefs = await SharedPreferences.getInstance();
    return ScenePreset.fromId(prefs.getString(_kPreset));
  }

  Future<void> setScenePreset(ScenePreset preset) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kPreset, preset.id);
  }

  Future<ViewScaleMode> getViewScaleMode() async {
    final prefs = await SharedPreferences.getInstance();
    return ViewScaleMode.fromId(prefs.getString(_kScaleMode));
  }

  Future<void> setViewScaleMode(ViewScaleMode mode) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kScaleMode, mode.id);
  }

  Future<double> getFillRatio() async {
    final prefs = await SharedPreferences.getInstance();
    final val = prefs.getDouble(_kFillRatio);
    return (val ?? 1.0).clamp(0.0, 1.0);
  }

  Future<void> setFillRatio(double ratio) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setDouble(_kFillRatio, ratio.clamp(0.0, 1.0));
  }

  Future<InputControlMode> getInputControlMode() async {
    final prefs = await SharedPreferences.getInstance();
    return InputControlMode.fromId(prefs.getString(_kInputMode));
  }

  Future<void> setInputControlMode(InputControlMode mode) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kInputMode, mode.id);
  }

  Future<int> getJitterMs() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getInt(_kJitterMs) ?? 0;
  }

  Future<void> setJitterMs(int ms) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setInt(_kJitterMs, ms);
  }

  Future<bool> getShowHud() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getBool(_kShowHud) ?? false;
  }

  Future<void> setShowHud(bool show) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_kShowHud, show);
  }

  Future<String> getDeviceLabel(String defaultLabel) async {
    final prefs = await SharedPreferences.getInstance();
    final val = prefs.getString(_kDeviceLabel);
    if (val != null && val.trim().isNotEmpty) return val.trim();
    return defaultLabel;
  }

  Future<void> setDeviceLabel(String label) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kDeviceLabel, label.trim());
  }

  Future<List<SavedRemoteHost>> getRemoteHosts() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_kRemoteHosts);
    if (raw == null || raw.isEmpty) return [];
    try {
      final arr = jsonDecode(raw) as List<dynamic>;
      return arr
          .whereType<Map<String, dynamic>>()
          .map(SavedRemoteHost.fromJson)
          .where((e) => e.ip.isNotEmpty)
          .toList()
        ..sort((a, b) => b.lastUsedMs.compareTo(a.lastUsedMs));
    } catch (_) {
      return [];
    }
  }

  Future<void> saveRemoteHost(SavedRemoteHost entry) async {
    final prefs = await SharedPreferences.getInstance();
    final current = await getRemoteHosts();
    current.removeWhere((e) => e.ip == entry.ip && e.port == entry.port);
    current.insert(0, entry);
    if (current.length > 12) current.removeRange(12, current.length);
    await prefs.setString(
      _kRemoteHosts,
      jsonEncode(current.map((e) => e.toJson()).toList()),
    );
  }

  Future<void> removeRemoteHost(String ip, int port) async {
    final prefs = await SharedPreferences.getInstance();
    final current = await getRemoteHosts();
    current.removeWhere((e) => e.ip == ip && e.port == port);
    await prefs.setString(
      _kRemoteHosts,
      jsonEncode(current.map((e) => e.toJson()).toList()),
    );
  }

  Future<bool> getAllowOverlayTun() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getBool(_kAllowOverlayTun) ?? false;
  }

  Future<void> setAllowOverlayTun(bool allow) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_kAllowOverlayTun, allow);
  }

  Future<String> getRemoteRelayUrl() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_kRemoteRelayUrl) ?? '';
  }

  Future<void> setRemoteRelayUrl(String url) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kRemoteRelayUrl, url.trim());
  }

  Future<String> getCustomIceUrl() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_kCustomIceUrl) ?? '';
  }

  Future<void> setCustomIceUrl(String url) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kCustomIceUrl, url.trim());
  }

  Future<bool> getForceTurnRelay() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getBool(_kForceTurnRelay) ?? false;
  }

  Future<void> setForceTurnRelay(bool force) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_kForceTurnRelay, force);
  }

  Future<bool> getPreferHevc() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getBool(_kPreferHevc) ?? false;
  }

  Future<void> setPreferHevc(bool prefer) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_kPreferHevc, prefer);
  }

  Future<bool> getPointerCaptureEnabled() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getBool(_kPointerCapture) ?? false;
  }

  Future<void> setPointerCaptureEnabled(bool enabled) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_kPointerCapture, enabled);
  }

  Future<bool> getAutoSyncClipboard() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getBool(_kAutoClipboard) ?? false;
  }

  Future<void> setAutoSyncClipboard(bool enabled) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_kAutoClipboard, enabled);
  }
}
