import 'dart:async';
import 'dart:convert';
import 'dart:io';
import '../models/airdesk_models.dart';
import 'storage_service.dart';
import 'webrtc_session_service.dart';

class DiscoveryService {
  static const int defaultPort = 47820;
  final StorageService _storage;

  DiscoveryService(this._storage);

  /// Discovers running AirDesk v0.5.3+ hosts via:
  /// 1) UDP broadcast ("AIRDESK_DISCOVER") to 255.255.255.255 & local /24 subnet broadcasts
  /// 2) HTTP /api/discover probes to recent hosts & likely hotspot gateway neighbors
  Future<List<AirDeskHostInfo>> discoverHosts({
    Duration timeout = const Duration(milliseconds: 1400),
  }) async {
    final Map<String, AirDeskHostInfo> found = {};
    final localAddrs = await _getLocalIpv4Addresses();

    // Run UDP broadcast discovery in parallel with HTTP probes to recent hosts and USB/ADB loopback
    await Future.wait([
      _udpDiscover(localAddrs, timeout, found),
      _probeRecentHostsHttp(found),
      _probeUsbAndLocalbackHttp(localAddrs, found),
    ]);

    final results = found.values.toList();
    results.sort((a, b) {
      if (a.hasTrustedToken != b.hasTrustedToken) {
        return a.hasTrustedToken ? -1 : 1;
      }
      return a.hostname.compareTo(b.hostname);
    });
    return results;
  }

  Future<AirDeskHostInfo?> probeSingleHttpHost(
    String ip, {
    int port = defaultPort,
    Duration timeout = const Duration(milliseconds: 900),
  }) async {
    final client = HttpClient()..connectionTimeout = timeout;
    try {
      final req = await client.getUrl(Uri.parse('http://$ip:$port/api/discover'));
      final res = await req.close().timeout(timeout);
      if (res.statusCode != 200) return null;
      final body = await utf8.decoder.bind(res).join();
      final json = jsonDecode(body) as Map<String, dynamic>;
      if (json['ok'] != true) return null;
      final tok = await _storage.getTokenForHost(ip, port);
      return AirDeskHostInfo(
        hostId: (json['hostId'] ?? '').toString().trim(),
        hostname: (json['hostname'] ?? ip).toString(),
        ip: ip,
        port: (json['port'] as num?)?.toInt() ?? port,
        version: (json['version'] ?? '').toString(),
        allAddresses: (json['addresses'] as List<dynamic>?)
                ?.map((e) => e.toString())
                .toList() ??
            [ip],
        hasTrustedToken: tok != null && tok.isNotEmpty,
      );
    } catch (_) {
      return null;
    } finally {
      client.close(force: true);
    }
  }

  Future<List<String>> _getLocalIpv4Addresses() async {
    final list = <String>[];
    try {
      final ifaces = await NetworkInterface.list(
        type: InternetAddressType.IPv4,
        includeLinkLocal: false,
        includeLoopback: false,
      );
      for (final iface in ifaces) {
        for (final addr in iface.addresses) {
          final ip = addr.address;
          // Skip Clash TUN / Tailscale ranges when computing LAN broadcast targets
          if (ip.startsWith('198.18.') || ip.startsWith('198.19.')) continue;
          list.add(ip);
        }
      }
    } catch (_) {}
    return list;
  }

  Future<void> _udpDiscover(
    List<String> localAddrs,
    Duration timeout,
    Map<String, AirDeskHostInfo> found,
  ) async {
    RawDatagramSocket? sock;
    try {
      sock = await RawDatagramSocket.bind(InternetAddress.anyIPv4, 0);
      sock.broadcastEnabled = true;

      final completer = Completer<void>();
      final sub = sock.listen((event) async {
        if (event != RawSocketEvent.read) return;
        final dg = sock?.receive();
        if (dg == null) return;
        try {
          final text = utf8.decode(dg.data);
          final json = jsonDecode(text) as Map<String, dynamic>;
          if (json['t'] != 'airdesk:here') return;
          final ip = dg.address.address;
          final port = (json['port'] as num?)?.toInt() ?? defaultPort;
          final tok = await _storage.getTokenForHost(ip, port);
          found['$ip:$port'] = AirDeskHostInfo(
            hostId: (json['hostId'] ?? '').toString().trim(),
            hostname: (json['hostname'] ?? ip).toString(),
            ip: ip,
            port: port,
            version: (json['version'] ?? '').toString(),
            allAddresses: (json['addresses'] as List<dynamic>?)
                    ?.map((e) => e.toString())
                    .toList() ??
                [ip],
            hasTrustedToken: tok != null && tok.isNotEmpty,
          );
        } catch (_) {}
      });

      final targets = <String>{'255.255.255.255'};
      for (final ip in localAddrs) {
        final parts = ip.split('.');
        if (parts.length == 4) {
          targets.add('${parts[0]}.${parts[1]}.${parts[2]}.255');
        }
      }

      final payload = utf8.encode('AIRDESK_DISCOVER');
      void sendBurst() {
        for (final target in targets) {
          try {
            sock?.send(payload, InternetAddress(target), defaultPort);
          } catch (_) {}
        }
      }

      sendBurst();
      Timer(const Duration(milliseconds: 280), sendBurst);
      Timer(const Duration(milliseconds: 650), sendBurst);
      Timer(timeout, () {
        if (!completer.isCompleted) completer.complete();
      });

      await completer.future;
      await sub.cancel();
    } catch (_) {
    } finally {
      sock?.close();
    }
  }

  Future<void> _probeRecentHostsHttp(Map<String, AirDeskHostInfo> found) async {
    final recent = await _storage.getRecentHosts();
    final profiles = await _storage.getSavedHostProfiles();
    final targets = <({String ip, int port})>[];
    final seen = <String>{};
    for (final entry in recent.take(4)) {
      final k = '${entry.ip}:${entry.port}';
      if (seen.add(k)) targets.add((ip: entry.ip, port: entry.port));
    }
    for (final profile in profiles) {
      if (profile.lastLanIp.isEmpty) continue;
      final k = '${profile.lastLanIp}:${profile.lastLanPort}';
      if (seen.add(k)) targets.add((ip: profile.lastLanIp, port: profile.lastLanPort));
      if (targets.length >= 8) break;
    }
    if (targets.isEmpty) return;
    await Future.wait(targets.map((entry) async {
      final info = await probeSingleHttpHost(entry.ip, port: entry.port);
      if (info != null) {
        found['${info.ip}:${info.port}'] = info;
      }
    }));
  }

  String? _matchSameSubnetIp(List<String> localAddrs, List<String> hostAddrs) {
    final localPrefixes = <String>{};
    for (final ip in localAddrs) {
      final parts = ip.split('.');
      if (parts.length == 4) {
        localPrefixes.add('${parts[0]}.${parts[1]}.${parts[2]}.');
      }
    }
    for (final candidate in hostAddrs) {
      if (localPrefixes.any((p) => candidate.startsWith(p))) {
        return candidate;
      }
    }
    return null;
  }

  Future<AirDeskHostInfo?> probeUsbDirectHost({int port = defaultPort}) async {
    final localAddrs = await _getLocalIpv4Addresses();
    final loopbackInfo = await probeSingleHttpHost('127.0.0.1', port: port);
    if (loopbackInfo != null) {
      final matchedIp = _matchSameSubnetIp(localAddrs, loopbackInfo.allAddresses);
      if (matchedIp != null && matchedIp.isNotEmpty) {
        final tok = await _storage.getTokenForHost(matchedIp, loopbackInfo.port);
        return AirDeskHostInfo(
          hostId: loopbackInfo.hostId,
          hostname: '${loopbackInfo.hostname} (USB)',
          ip: matchedIp,
          port: loopbackInfo.port,
          version: loopbackInfo.version,
          allAddresses: loopbackInfo.allAddresses,
          hasTrustedToken: tok != null && tok.isNotEmpty,
          isUsb: true,
        );
      }
      return AirDeskHostInfo(
        hostId: loopbackInfo.hostId,
        hostname: '${loopbackInfo.hostname} (USB ADB)',
        ip: '127.0.0.1',
        port: loopbackInfo.port,
        version: loopbackInfo.version,
        allAddresses: loopbackInfo.allAddresses,
        hasTrustedToken: loopbackInfo.hasTrustedToken,
        isUsb: true,
      );
    }

    // Fallback: probe common USB RNDIS gateway neighbors (.1 / .129 / .42) if local IP is 192.168.42.x
    for (final ip in localAddrs) {
      final parts = ip.split('.');
      if (parts.length == 4 && parts[0] == '192' && parts[1] == '168' && parts[2] == '42') {
        for (final last in ['129', '1', '2']) {
          final gw = '192.168.42.$last';
          if (gw == ip) continue;
          final info = await probeSingleHttpHost(gw, port: port);
          if (info != null) {
            return AirDeskHostInfo(
              hostId: info.hostId,
              hostname: '${info.hostname} (USB)',
              ip: gw,
              port: info.port,
              version: info.version,
              allAddresses: info.allAddresses,
              hasTrustedToken: info.hasTrustedToken,
              isUsb: true,
            );
          }
        }
      }
    }
    return null;
  }

  Future<Map<String, RelayHostProbeStatus>> probeRelayHosts(
    String relayUrl,
    List<String> hostIds, {
    Duration timeout = const Duration(milliseconds: 3000),
  }) async {
    final cleanUrl = relayUrl.trim();
    if (cleanUrl.isEmpty) return {};
    final uniqueIds = <String>[];
    final seen = <String>{};
    for (final rawId in hostIds) {
      final id = rawId.trim();
      if (id.isNotEmpty && seen.add(id)) {
        uniqueIds.add(id);
        if (uniqueIds.length >= 16) break;
      }
    }
    if (uniqueIds.isEmpty) return {};

    WebSocket? sock;
    try {
      final wsUrl = WebRtcSessionService.normalizeRelayWsUrl(cleanUrl);
      sock = await WebSocket.connect(wsUrl).timeout(timeout);
      final completer = Completer<Map<String, RelayHostProbeStatus>>();
      final timer = Timer(timeout, () {
        if (!completer.isCompleted) completer.complete({});
      });
      final sub = sock.listen(
        (raw) {
          try {
            final msg = jsonDecode(raw.toString()) as Map<String, dynamic>;
            if (msg['type'] == 'client:hosts_status' && msg['hosts'] is Map) {
              final rawHosts = msg['hosts'] as Map;
              final parsed = <String, RelayHostProbeStatus>{};
              rawHosts.forEach((key, value) {
                if (value is Map) {
                  parsed[key.toString()] =
                      RelayHostProbeStatus.fromJson(Map<String, dynamic>.from(value));
                }
              });
              if (!completer.isCompleted) completer.complete(parsed);
            } else if (msg['type'] == 'error') {
              if (!completer.isCompleted) completer.complete({});
            }
          } catch (_) {}
        },
        onError: (_) {
          if (!completer.isCompleted) completer.complete({});
        },
        onDone: () {
          if (!completer.isCompleted) completer.complete({});
        },
      );
      sock.add(jsonEncode({
        'type': 'client:probe_hosts',
        'hostIds': uniqueIds,
      }));
      final result = await completer.future;
      timer.cancel();
      await sub.cancel();
      return result;
    } catch (_) {
      return {};
    } finally {
      try {
        await sock?.close();
      } catch (_) {}
    }
  }

  Future<void> _probeUsbAndLocalbackHttp(
    List<String> localAddrs,
    Map<String, AirDeskHostInfo> found,
  ) async {
    final usbInfo = await probeUsbDirectHost();
    if (usbInfo != null) {
      found.putIfAbsent('${usbInfo.ip}:${usbInfo.port}', () => usbInfo);
    }
  }
}
