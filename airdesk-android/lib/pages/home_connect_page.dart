// ignore: deprecated_member_use
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../models/airdesk_models.dart';
import '../services/discovery_service.dart';
import '../services/lan_file_service.dart';
import '../services/native_bridge.dart';
import '../services/storage_service.dart';
import '../services/webrtc_session_service.dart';
import 'remote_stage_page.dart';

class HomeConnectPage extends StatefulWidget {
  final StorageService storage;
  final DiscoveryService discovery;
  final WebRtcSessionService session;

  const HomeConnectPage({
    super.key,
    required this.storage,
    required this.discovery,
    required this.session,
  });

  @override
  State<HomeConnectPage> createState() => _HomeConnectPageState();
}

class _HomeConnectPageState extends State<HomeConnectPage> {
  final _ipCtrl = TextEditingController();
  final _pinCtrl = TextEditingController();
  final _relayUrlCtrl = TextEditingController();
  final _relayPinCtrl = TextEditingController();
  final _customIceCtrl = TextEditingController();

  List<AirDeskHostInfo> _discovered = [];
  List<RecentHostEntry> _recent = [];
  List<SavedRemoteHost> _remoteHosts = [];
  Map<String, bool> _remoteHasToken = {};
  bool _scanning = false;
  bool _batteryExempt = true;
  bool _navigatedToStage = false;
  bool _allowOverlayTun = false;
  bool _preferHevc = false;
  bool _relayHasToken = false;
  bool _showRelayIceAdvanced = false;
  String? _localTailscaleIp;
  List<String> _overlayIps = [];
  int _manualPort = DiscoveryService.defaultPort;
  int _homeTab = 0; // 0: 局域网/热点, 1: Tailscale异地, 2: 公网中继
  ScenePreset _selectedPreset = ScenePreset.officeClear;

  @override
  void initState() {
    super.initState();
    widget.session.addListener(_onSessionChange);
    _initData();
  }

  @override
  void dispose() {
    widget.session.removeListener(_onSessionChange);
    _ipCtrl.dispose();
    _pinCtrl.dispose();
    _relayUrlCtrl.dispose();
    _relayPinCtrl.dispose();
    _customIceCtrl.dispose();
    super.dispose();
  }

  Future<void> _initData() async {
    final recent = await widget.storage.getRecentHosts();
    final remotes = await widget.storage.getRemoteHosts();
    final allowOverlay = await widget.storage.getAllowOverlayTun();
    await NativeBridge.setAllowOverlayTun(allowOverlay);
    final overlayInfo = await NativeBridge.getOverlayNetworkInfo();
    final preset = await widget.storage.getScenePreset();
    final preferHevc = await widget.storage.getPreferHevc();
    final exempt = await NativeBridge.isIgnoringBatteryOptimizations();
    final savedRelay = await widget.storage.getRemoteRelayUrl();
    final savedCustomIce = await widget.storage.getCustomIceUrl();
    final tokMap = <String, bool>{};
    for (final r in remotes) {
      final t = await widget.storage.getTokenForHost(r.ip, r.port);
      tokMap['${r.ip}:${r.port}'] = t != null && t.isNotEmpty;
    }
    var relayTok = false;
    if (savedRelay.isNotEmpty) {
      final rk = WebRtcSessionService.tokenKeyForEndpoint(signalingUrl: savedRelay);
      final rt = await widget.storage.getTokenForKey(rk);
      relayTok = rt != null && rt.isNotEmpty;
    }
    if (!mounted) return;
    setState(() {
      _recent = recent;
      _remoteHosts = remotes;
      _remoteHasToken = tokMap;
      _allowOverlayTun = allowOverlay;
      _localTailscaleIp = overlayInfo.tailscaleIp;
      _overlayIps = overlayInfo.overlayIps;
      _selectedPreset = preset;
      _preferHevc = preferHevc;
      _batteryExempt = exempt;
      _relayHasToken = relayTok;
      if (savedRelay.isNotEmpty && _relayUrlCtrl.text.isEmpty) {
        _relayUrlCtrl.text = savedRelay;
      }
      if (savedCustomIce.isNotEmpty && _customIceCtrl.text.isEmpty) {
        _customIceCtrl.text = savedCustomIce;
      }
      if (recent.isNotEmpty && _ipCtrl.text.isEmpty) {
        _ipCtrl.text = recent.first.ip;
      }
    });
    _scanLan();
  }

  Future<void> _refreshOverlayStatus() async {
    final overlayInfo = await NativeBridge.getOverlayNetworkInfo();
    if (!mounted) return;
    setState(() {
      _localTailscaleIp = overlayInfo.tailscaleIp;
      _overlayIps = overlayInfo.overlayIps;
    });
  }

  void _onSessionChange() {
    if (!mounted) return;
    final p = widget.session.phase;
    if ((p == SessionPhase.negotiatingRtc || p == SessionPhase.connected) &&
        !_navigatedToStage) {
      _navigatedToStage = true;
      Navigator.of(context)
          .push(
        MaterialPageRoute(
          builder: (_) => RemoteStagePage(
            storage: widget.storage,
            session: widget.session,
          ),
        ),
      )
          .then((_) {
        _navigatedToStage = false;
        _initData();
      });
      return;
    }
    if (_navigatedToStage) return;
    setState(() {});
  }

  Future<void> _scanLan() async {
    if (_scanning) return;
    setState(() => _scanning = true);
    final hosts = await widget.discovery.discoverHosts();
    if (!mounted) return;
    setState(() {
      _discovered = hosts;
      _scanning = false;
      if (hosts.isNotEmpty && _ipCtrl.text.trim().isEmpty) {
        _ipCtrl.text = hosts.first.ip;
      }
    });
  }

  void _showSnack(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(
        SnackBar(
          content: Text(text, style: const TextStyle(color: Colors.white, fontSize: 12.5)),
          backgroundColor: const Color(0xE60F172A),
          behavior: SnackBarBehavior.floating,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(12),
            side: const BorderSide(color: Color(0xFF334155)),
          ),
        ),
      );
  }

  bool _parseUrlAndFill(String raw) {
    final trimmed = raw.trim();
    if (trimmed.isEmpty) return false;
    try {
      final uri = Uri.parse(trimmed.contains('://') ? trimmed : 'http://$trimmed');
      if (uri.host.isEmpty) return false;
      _ipCtrl.text = uri.host;
      if (uri.hasPort && uri.port > 0 && uri.port <= 65535) {
        _manualPort = uri.port;
      }
      final join = uri.queryParameters['join'];
      if (join != null) {
        final cleanPin = join.replaceAll(RegExp(r'\D'), '');
        if (cleanPin.isNotEmpty) {
          _pinCtrl.text = cleanPin.substring(0, cleanPin.length.clamp(0, 6));
        }
      }
      setState(() {});
      return true;
    } catch (_) {
      return false;
    }
  }

  Future<void> _pasteClipboardToManual() async {
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    final txt = (data?.text ?? '').trim();
    if (txt.isEmpty) {
      _showSnack('剪贴板为空');
      return;
    }
    if (_parseUrlAndFill(txt)) {
      _showSnack('已识别连接地址：${_ipCtrl.text}:$_manualPort');
    } else {
      _ipCtrl.text = txt;
      setState(() {});
    }
  }

  Future<void> _pasteClipboardToRelay() async {
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    final txt = (data?.text ?? '').trim();
    if (txt.isEmpty) {
      _showSnack('剪贴板为空');
      return;
    }
    _relayUrlCtrl.text = txt;
    _parseRelayInput(txt);
    _showSnack('已填充中继地址');
  }

  ({String ip, int port}) _parseHostAndPort(String raw, int fallbackPort) {
    final s = raw.trim();
    if (s.isEmpty) return (ip: '', port: fallbackPort);
    try {
      final uri = Uri.parse(s.contains('://') ? s : 'http://$s');
      if (uri.host.isNotEmpty) {
        final p = (uri.hasPort && uri.port > 0 && uri.port <= 65535) ? uri.port : fallbackPort;
        return (ip: uri.host, port: p);
      }
    } catch (_) {}
    final colonIdx = s.lastIndexOf(':');
    if (colonIdx > 0 && !s.contains('[')) {
      final maybePort = int.tryParse(s.substring(colonIdx + 1));
      if (maybePort != null && maybePort > 0 && maybePort <= 65535) {
        return (ip: s.substring(0, colonIdx).trim(), port: maybePort);
      }
    }
    return (ip: s, port: fallbackPort);
  }

  void _showAddRemoteHostDialog() {
    final labelCtrl = TextEditingController();
    final ipCtrl = TextEditingController();
    final portCtrl = TextEditingController(text: '${DiscoveryService.defaultPort}');
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: const Color(0xFF111824),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: const BorderSide(color: Color(0xFF283548)),
        ),
        title: const Text('添加异地电脑（Tailscale / ZeroTier）', style: TextStyle(fontSize: 16)),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: labelCtrl,
              decoration: const InputDecoration(
                labelText: '备注名称（如 家里台式机）',
                border: OutlineInputBorder(),
                isDense: true,
              ),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: ipCtrl,
              decoration: const InputDecoration(
                labelText: '异地 IP（如 100.64.0.1 或粘贴直连地址）',
                border: OutlineInputBorder(),
                isDense: true,
              ),
              onChanged: (v) {
                final t = v.trim();
                if (t.contains('://') || t.contains(':')) {
                  final parsed = _parseHostAndPort(t, DiscoveryService.defaultPort);
                  if (parsed.port != DiscoveryService.defaultPort) {
                    portCtrl.text = '${parsed.port}';
                  }
                }
              },
            ),
            const SizedBox(height: 10),
            TextField(
              controller: portCtrl,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(
                labelText: '信令端口（默认 47820）',
                border: OutlineInputBorder(),
                isDense: true,
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () async {
              final parsed = _parseHostAndPort(
                ipCtrl.text,
                int.tryParse(portCtrl.text.trim()) ?? DiscoveryService.defaultPort,
              );
              if (parsed.ip.isEmpty) return;
              final port = int.tryParse(portCtrl.text.trim()) ?? parsed.port;
              final entry = SavedRemoteHost(
                label: labelCtrl.text.trim().isEmpty ? parsed.ip : labelCtrl.text.trim(),
                ip: parsed.ip,
                port: port.clamp(1, 65535),
                lastUsedMs: DateTime.now().millisecondsSinceEpoch,
              );
              await widget.storage.saveRemoteHost(entry);
              if (!ctx.mounted) return;
              Navigator.of(ctx).pop();
              await _initData();
            },
            child: const Text('保存主机'),
          ),
        ],
      ),
    );
  }

  Future<void> _tryUsbQuickConnect() async {
    _showSnack('正在探测 USB 有线 / ADB 通道...');
    final usbHost = await widget.discovery.probeUsbDirectHost();
    if (!mounted) return;
    if (usbHost != null) {
      _ipCtrl.text = usbHost.ip;
      _manualPort = usbHost.port;
      setState(() {});
      _showSnack('已命中 USB 直连：${usbHost.ip}:${usbHost.port}');
      await _connectHost(usbHost.ip, usbHost.port, tryToken: true);
      return;
    }
    _ipCtrl.text = '127.0.0.1';
    _manualPort = DiscoveryService.defaultPort;
    setState(() {});
    _showSnack('未检测到 ADB 转发或 USB RNDIS 网卡，请在电脑端点「USB 一键直连」或开启手机 USB 网络共享');
  }

  Future<void> _scanQrAndConnect() async {
    final raw = await NativeBridge.scanQrCode();
    if (!mounted || raw == null || raw.isEmpty) return;
    final trimmed = raw.trim();

    if (RegExp(r'^\d{6}$').hasMatch(trimmed)) {
      _pinCtrl.text = trimmed;
      _relayPinCtrl.text = trimmed;
      setState(() {});
      _showSnack('已识别 6 位配对码：$trimmed');
      return;
    }

    try {
      final uri = Uri.parse(trimmed.contains('://') ? trimmed : 'http://$trimmed');
      if (uri.host.isEmpty) {
        _showSnack('未识别到有效的 AirDesk 连接地址');
        return;
      }
      final rawPin = (uri.queryParameters['join'] ?? '').replaceAll(RegExp(r'\D'), '');
      final pin = rawPin.length >= 6 ? rawPin.substring(0, 6) : rawPin;
      final port = (uri.hasPort && uri.port > 0 && uri.port <= 65535)
          ? uri.port
          : DiscoveryService.defaultPort;
      final isPrivateIp = RegExp(
        r'^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|\d{1,3}(\.\d{1,3}){3}$)',
      ).hasMatch(uri.host);

      if (WebRtcSessionService.isOverlayHost(uri.host)) {
        await widget.storage.saveRemoteHost(
          SavedRemoteHost(
            label: uri.host,
            ip: uri.host,
            port: port,
            lastUsedMs: DateTime.now().millisecondsSinceEpoch,
          ),
        );
        await _initData();
        if (!mounted) return;
        setState(() {
          _homeTab = 1;
          if (pin.isNotEmpty) _pinCtrl.text = pin;
        });
        _showSnack('已识别 Tailscale 主机：${uri.host}:$port');
        await _connectHost(
          uri.host,
          port,
          tryToken: true,
          pinOverride: pin.length == 6 ? pin : null,
        );
      } else if (isPrivateIp || uri.scheme == 'http') {
        setState(() {
          _homeTab = 0;
          _ipCtrl.text = uri.host;
          _manualPort = port;
          if (pin.isNotEmpty) _pinCtrl.text = pin;
        });
        _showSnack('已识别扫码直连：${uri.host}:$port');
        await _connectHost(
          uri.host,
          port,
          tryToken: true,
          pinOverride: pin.length == 6 ? pin : null,
        );
      } else {
        final portPart = uri.hasPort ? ':${uri.port}' : '';
        final relayBase = '${uri.scheme}://${uri.host}$portPart';
        setState(() {
          _homeTab = 2;
          _relayUrlCtrl.text = relayBase;
          if (pin.isNotEmpty) _relayPinCtrl.text = pin;
        });
        _showSnack('已识别公网中继地址：$relayBase');
        await _connectRelay(
          tryToken: true,
          pinOverride: pin.length == 6 ? pin : null,
        );
      }
    } catch (_) {
      _showSnack('二维码格式无法识别：$trimmed');
    }
  }

  void _showPresetSheet() {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: const Color(0xFF0E1520),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
        side: BorderSide(color: Color(0xFF283548)),
      ),
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSheetState) => Padding(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const Text(
                    '选择默认清晰度与帧率预设',
                    style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700),
                  ),
                  const Spacer(),
                  IconButton(
                    visualDensity: VisualDensity.compact,
                    onPressed: () => Navigator.of(ctx).pop(),
                    icon: const Icon(Icons.close_rounded, size: 18),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              GridView.count(
                crossAxisCount: 2,
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                mainAxisSpacing: 8,
                crossAxisSpacing: 8,
                childAspectRatio: 2.35,
                children: ScenePreset.values.map((p) {
                  final selected = p == _selectedPreset;
                  return InkWell(
                    borderRadius: BorderRadius.circular(12),
                    onTap: () async {
                      await widget.storage.setScenePreset(p);
                      if (mounted) setState(() => _selectedPreset = p);
                      if (ctx.mounted) Navigator.of(ctx).pop();
                    },
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 8),
                      decoration: BoxDecoration(
                        color: selected ? const Color(0xFF1E3A8A) : const Color(0xFF141D2B),
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(
                          color: selected ? const Color(0xFF60A5FA) : const Color(0xFF263346),
                        ),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Text(
                            p.label,
                            style: const TextStyle(
                              fontSize: 13,
                              fontWeight: FontWeight.w600,
                              color: Colors.white,
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            p.subtitle,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontSize: 10.5, color: Color(0xFF94A3B8)),
                          ),
                        ],
                      ),
                    ),
                  );
                }).toList(),
              ),
              const SizedBox(height: 10),
              Container(
                decoration: BoxDecoration(
                  color: const Color(0xFF141D2B),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: const Color(0xFF263346)),
                ),
                child: SwitchListTile.adaptive(
                  dense: true,
                  contentPadding: const EdgeInsets.symmetric(horizontal: 12),
                  title: const Text(
                    '优先尝试 H.265 / HEVC 硬解协商',
                    style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600),
                  ),
                  subtitle: const Text(
                    '独显电脑与新旗舰机可用更高画质更低码率；不支持时自动回退 H.264',
                    style: TextStyle(fontSize: 10.5, color: Color(0xFF94A3B8)),
                  ),
                  value: _preferHevc,
                  onChanged: (v) async {
                    await widget.storage.setPreferHevc(v);
                    setSheetState(() {});
                    if (mounted) setState(() => _preferHevc = v);
                  },
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _connectHost(String ip, int port, {bool tryToken = true, String? pinOverride}) async {
    final cleanIp = ip.trim();
    if (cleanIp.isEmpty) {
      _showSnack('请先选择在线电脑，或输入电脑局域网 IP');
      return;
    }

    String? token;
    if (tryToken) {
      token = await widget.storage.getTokenForHost(cleanIp, port);
    }
    final pin = (pinOverride ?? _pinCtrl.text).replaceAll(RegExp(r'\D'), '');
    if ((token == null || token.isEmpty) && pin.length != 6) {
      if (!mounted) return;
      _showPinDialog(cleanIp, port);
      return;
    }

    await widget.session.connect(
      hostIp: cleanIp,
      port: port,
      pinCode: pin.length == 6 ? pin : null,
      sessionToken: token,
    );
  }

  void _showPinDialog(String ip, int port) {
    final ctrl = TextEditingController();
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: const Color(0xFF111824),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: const BorderSide(color: Color(0xFF283548)),
        ),
        title: Text('输入 $ip 的 6 位配对码', style: const TextStyle(fontSize: 16)),
        content: TextField(
          controller: ctrl,
          keyboardType: TextInputType.number,
          maxLength: 6,
          autofocus: true,
          style: const TextStyle(fontSize: 26, letterSpacing: 8, fontFamily: 'monospace'),
          textAlign: TextAlign.center,
          decoration: const InputDecoration(
            labelText: '6 位配对码',
            counterText: '',
            border: OutlineInputBorder(),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () {
              final p = ctrl.text.replaceAll(RegExp(r'\D'), '');
              if (p.length == 6) {
                _pinCtrl.text = p;
                Navigator.of(ctx).pop();
                _connectHost(ip, port, tryToken: false, pinOverride: p);
              }
            },
            child: const Text('发起连接'),
          ),
        ],
      ),
    );
  }

  Future<void> _refreshRelayTokenFlag(String rawUrl) async {
    final clean = rawUrl.trim();
    if (clean.isEmpty) {
      if (mounted && _relayHasToken) setState(() => _relayHasToken = false);
      return;
    }
    final rk = WebRtcSessionService.tokenKeyForEndpoint(signalingUrl: clean);
    final tok = await widget.storage.getTokenForKey(rk);
    if (mounted) {
      setState(() => _relayHasToken = tok != null && tok.isNotEmpty);
    }
  }

  void _parseRelayInput(String raw) {
    final trimmed = raw.trim();
    if (trimmed.isEmpty) {
      _refreshRelayTokenFlag('');
      return;
    }
    try {
      final uri = Uri.parse(trimmed.contains('://') ? trimmed : 'https://$trimmed');
      final join = uri.queryParameters['join'];
      if (join != null) {
        final cleanPin = join.replaceAll(RegExp(r'\D'), '');
        if (cleanPin.isNotEmpty) {
          _relayPinCtrl.text = cleanPin.substring(0, cleanPin.length.clamp(0, 6));
        }
        final portPart = uri.hasPort ? ':${uri.port}' : '';
        _relayUrlCtrl.text = '${uri.scheme}://${uri.host}$portPart';
        _relayUrlCtrl.selection = TextSelection.fromPosition(
          TextPosition(offset: _relayUrlCtrl.text.length),
        );
      }
    } catch (_) {}
    _refreshRelayTokenFlag(_relayUrlCtrl.text);
  }

  Future<void> _connectRelay({bool tryToken = true, String? pinOverride}) async {
    final relayUrl = _relayUrlCtrl.text.trim();
    if (relayUrl.isEmpty) {
      _showSnack('请先填写公网信令服务器地址（如 https://relay.example.com）');
      return;
    }
    final customIce = _customIceCtrl.text.trim();
    await widget.storage.setRemoteRelayUrl(relayUrl);
    await widget.storage.setCustomIceUrl(customIce);

    String? token;
    if (tryToken) {
      final rk = WebRtcSessionService.tokenKeyForEndpoint(signalingUrl: relayUrl);
      token = await widget.storage.getTokenForKey(rk);
    }
    final pin = (pinOverride ?? _relayPinCtrl.text).replaceAll(RegExp(r'\D'), '');
    if ((token == null || token.isEmpty) && pin.length != 6) {
      if (!mounted) return;
      _showRelayPinDialog();
      return;
    }

    await widget.session.connect(
      signalingUrl: relayUrl,
      customIceRaw: customIce.isEmpty ? null : customIce,
      pinCode: pin.length == 6 ? pin : null,
      sessionToken: token,
    );
  }

  void _showRelayPinDialog() {
    final ctrl = TextEditingController();
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: const Color(0xFF111824),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: const BorderSide(color: Color(0xFF283548)),
        ),
        title: const Text('输入远程电脑 6 位配对码', style: TextStyle(fontSize: 16)),
        content: TextField(
          controller: ctrl,
          keyboardType: TextInputType.number,
          maxLength: 6,
          autofocus: true,
          style: const TextStyle(fontSize: 26, letterSpacing: 8, fontFamily: 'monospace'),
          textAlign: TextAlign.center,
          decoration: const InputDecoration(
            labelText: '6 位配对码',
            counterText: '',
            border: OutlineInputBorder(),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () {
              final p = ctrl.text.replaceAll(RegExp(r'\D'), '');
              if (p.length == 6) {
                _relayPinCtrl.text = p;
                Navigator.of(ctx).pop();
                _connectRelay(tryToken: false, pinOverride: p);
              }
            },
            child: const Text('连接公网中继'),
          ),
        ],
      ),
    );
  }

  String _formatFileBytes(int bytes) {
    if (bytes < 1024) return '$bytes B';
    if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
    return '${(bytes / (1024 * 1024)).toStringAsFixed(2)} MB';
  }

  Future<void> _showLanFileTransferSheet(String ip, int port, String title) async {
    final savedToken = await widget.storage.getTokenForHost(ip, port);
    if (!mounted) return;
    final pinCtrl = TextEditingController(text: _pinCtrl.text.trim());
    var files = <LanRemoteFile>[];
    var loading = true;
    var busy = false;
    var authRequired = false;
    double? progress;
    var statusText = '正在连接 $ip:$port 读取电脑共享目录...';
    var initialized = false;

    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: const Color(0xFF0E1520),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
        side: BorderSide(color: Color(0xFF283548)),
      ),
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSheetState) {
          Future<void> refreshList() async {
            if (!ctx.mounted) return;
            setSheetState(() {
              loading = true;
              statusText = '正在刷新电脑「下载/AirDesk」文件列表...';
            });
            final res = await LanFileService.listHostFiles(
              ip: ip,
              port: port,
              token: savedToken,
              pin: pinCtrl.text.trim(),
            );
            if (!ctx.mounted) return;
            setSheetState(() {
              loading = false;
              authRequired = res.authRequired;
              if (res.ok) {
                files = res.files;
                statusText = files.isEmpty
                    ? '电脑「下载/AirDesk」目录暂无文件，可直接发文件给电脑'
                    : '已就绪 · 电脑「下载/AirDesk」共 ${files.length} 个文件';
              } else {
                statusText = res.error ?? '读取失败';
              }
            });
          }

          Future<void> pickAndUpload() async {
            final picked = await NativeBridge.pickFileForTransfer();
            if (!ctx.mounted || picked == null) return;
            setSheetState(() {
              busy = true;
              progress = 0.0;
              statusText = '正在发送：${picked.name}...';
            });
            final res = await LanFileService.uploadFile(
              ip: ip,
              port: port,
              file: picked,
              token: savedToken,
              pin: pinCtrl.text.trim(),
              deleteSourceOnFinish: true,
              onProgress: (sent, total) {
                if (!ctx.mounted) return;
                setSheetState(() {
                  progress = total > 0 ? (sent / total).clamp(0.0, 1.0) : 1.0;
                  statusText =
                      '发送中 ${picked.name} (${_formatFileBytes(sent)} / ${_formatFileBytes(total)})';
                });
              },
            );
            if (!ctx.mounted) return;
            setSheetState(() {
              busy = false;
              progress = null;
              authRequired = res.authRequired;
              statusText = res.ok
                  ? '已发送至电脑：${res.savedName}'
                  : '发送失败：${res.error ?? "未知错误"}';
            });
            if (res.ok) {
              _showSnack('已发送到电脑「下载/AirDesk」：${res.savedName}');
              await refreshList();
            }
          }

          Future<void> downloadRemote(LanRemoteFile item) async {
            if (!ctx.mounted) return;
            setSheetState(() {
              busy = true;
              progress = 0.0;
              statusText = '正在下载：${item.name}...';
            });
            final res = await LanFileService.downloadFile(
              ip: ip,
              port: port,
              fileName: item.name,
              token: savedToken,
              pin: pinCtrl.text.trim(),
              onProgress: (rx, total) {
                if (!ctx.mounted) return;
                final effTotal = total > 0 ? total : item.size;
                setSheetState(() {
                  progress = effTotal > 0 ? (rx / effTotal).clamp(0.0, 1.0) : null;
                  statusText =
                      '下载中 ${item.name} (${_formatFileBytes(rx)} / ${_formatFileBytes(effTotal)})';
                });
              },
            );
            if (!ctx.mounted) return;
            setSheetState(() {
              busy = false;
              progress = null;
              authRequired = res.authRequired;
              statusText = res.ok
                  ? '已保存至手机：${res.displayPath}'
                  : '下载失败：${res.error ?? "未知错误"}';
            });
            if (res.ok) {
              _showSnack('已下载至手机 ${res.displayPath}');
            }
          }

          if (!initialized) {
            initialized = true;
            Future.microtask(refreshList);
          }

          return Padding(
            padding: EdgeInsets.fromLTRB(
              16,
              14,
              16,
              18 + MediaQuery.of(ctx).viewInsets.bottom,
            ),
            child: ConstrainedBox(
              constraints: BoxConstraints(
                maxHeight: MediaQuery.of(ctx).size.height * 0.78,
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const Icon(Icons.swap_horiz_rounded, size: 19, color: Color(0xFF60A5FA)),
                      const SizedBox(width: 7),
                      Expanded(
                        child: Text(
                          '局域网免控屏快传 · $title',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700),
                        ),
                      ),
                      IconButton(
                        tooltip: '刷新文件列表',
                        visualDensity: VisualDensity.compact,
                        onPressed: (loading || busy) ? null : refreshList,
                        icon: const Icon(Icons.refresh_rounded, size: 18),
                      ),
                      IconButton(
                        visualDensity: VisualDensity.compact,
                        onPressed: () => Navigator.of(ctx).pop(),
                        icon: const Icon(Icons.close_rounded, size: 18),
                      ),
                    ],
                  ),
                  Text(
                    statusText,
                    style: TextStyle(
                      fontSize: 11.5,
                      color: authRequired ? const Color(0xFFFBBF24) : const Color(0xFF94A3B8),
                    ),
                  ),
                  if (progress != null) ...[
                    const SizedBox(height: 8),
                    LinearProgressIndicator(
                      value: progress,
                      minHeight: 5,
                      borderRadius: BorderRadius.circular(4),
                    ),
                  ],
                  if (authRequired) ...[
                    const SizedBox(height: 10),
                    Row(
                      children: [
                        Expanded(
                          child: TextField(
                            controller: pinCtrl,
                            keyboardType: TextInputType.number,
                            maxLength: 6,
                            decoration: const InputDecoration(
                              labelText: '输入电脑 6 位配对码解锁快传',
                              counterText: '',
                              isDense: true,
                              border: OutlineInputBorder(),
                            ),
                          ),
                        ),
                        const SizedBox(width: 8),
                        FilledButton(
                          onPressed: (loading || busy) ? null : refreshList,
                          child: const Text('验证'),
                        ),
                      ],
                    ),
                  ],
                  const SizedBox(height: 10),
                  SizedBox(
                    width: double.infinity,
                    height: 40,
                    child: FilledButton.icon(
                      onPressed: (busy || authRequired) ? null : pickAndUpload,
                      icon: const Icon(Icons.upload_file_rounded, size: 18),
                      label: const Text('选择手机文件发送到电脑'),
                    ),
                  ),
                  const SizedBox(height: 10),
                  const Text(
                    '电脑「下载/AirDesk」文件列表（点右侧下载到手机）',
                    style: TextStyle(fontSize: 11.5, color: Color(0xFF94A3B8)),
                  ),
                  const SizedBox(height: 6),
                  if (loading)
                    const Padding(
                      padding: EdgeInsets.symmetric(vertical: 18),
                      child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
                    )
                  else if (files.isEmpty)
                    const Padding(
                      padding: EdgeInsets.symmetric(vertical: 14),
                      child: Text(
                        '暂无可下载文件（电脑端收到或放入「下载/AirDesk」的文件会出现在这里）',
                        style: TextStyle(fontSize: 11.5, color: Color(0xFF64748B)),
                      ),
                    )
                  else
                    Flexible(
                      child: ListView.separated(
                        shrinkWrap: true,
                        itemCount: files.length,
                        separatorBuilder: (_, _) => const SizedBox(height: 6),
                        itemBuilder: (_, idx) {
                          final item = files[idx];
                          return Container(
                            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                            decoration: BoxDecoration(
                              color: const Color(0xFF090E16),
                              borderRadius: BorderRadius.circular(10),
                              border: Border.all(color: const Color(0xFF1E293B)),
                            ),
                            child: Row(
                              children: [
                                const Icon(Icons.insert_drive_file_outlined, size: 17, color: Color(0xFF60A5FA)),
                                const SizedBox(width: 8),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Text(
                                        item.name,
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                        style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w500),
                                      ),
                                      Text(
                                        _formatFileBytes(item.size),
                                        style: const TextStyle(fontSize: 10.5, color: Color(0xFF94A3B8)),
                                      ),
                                    ],
                                  ),
                                ),
                                IconButton(
                                  tooltip: '下载到手机',
                                  visualDensity: VisualDensity.compact,
                                  onPressed: busy ? null : () => downloadRemote(item),
                                  icon: const Icon(Icons.download_rounded, size: 19, color: Color(0xFF34D399)),
                                ),
                              ],
                            ),
                          );
                        },
                      ),
                    ),
                ],
              ),
            ),
          );
        },
      ),
    ).whenComplete(pinCtrl.dispose);
  }

  Widget _buildHeaderBar() {
    return Row(
      children: [
        Container(
          width: 38,
          height: 38,
          decoration: BoxDecoration(
            gradient: const LinearGradient(
              colors: [Color(0xFF2563EB), Color(0xFF1D4ED8)],
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
            ),
            borderRadius: BorderRadius.circular(11),
            boxShadow: const [BoxShadow(color: Color(0x442563EB), blurRadius: 10)],
          ),
          child: const Icon(Icons.desktop_windows_rounded, color: Colors.white, size: 20),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const Text(
                    'AirDesk',
                    style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700, letterSpacing: 0.2),
                  ),
                  const SizedBox(width: 6),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1.5),
                    decoration: BoxDecoration(
                      color: const Color(0xFF172554),
                      borderRadius: BorderRadius.circular(6),
                      border: Border.all(color: const Color(0xFF2563EB)),
                    ),
                    child: const Text(
                      'v0.7.5',
                      style: TextStyle(fontSize: 10, color: Color(0xFF93C5FD), fontWeight: FontWeight.w600),
                    ),
                  ),
                ],
              ),
              const Text(
                '低延迟无线串流 · 本地 / Tailscale / 公网',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 11, color: Color(0xFF94A3B8)),
              ),
            ],
          ),
        ),
        const SizedBox(width: 8),
        InkWell(
          borderRadius: BorderRadius.circular(10),
          onTap: _showPresetSheet,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
            decoration: BoxDecoration(
              color: const Color(0xFF111824),
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: const Color(0xFF263346)),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.tune_rounded, size: 14, color: Color(0xFF60A5FA)),
                const SizedBox(width: 5),
                Text(
                  _selectedPreset.label,
                  style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: Colors.white),
                ),
                const SizedBox(width: 2),
                const Icon(Icons.keyboard_arrow_down_rounded, size: 16, color: Color(0xFF94A3B8)),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildStatusBanner(SessionPhase phase, bool busy) {
    final isErr = phase == SessionPhase.error;
    final borderColor = isErr
        ? const Color(0xFFDC2626)
        : (busy ? const Color(0xFF2563EB) : const Color(0xFF334155));
    final textColor = isErr
        ? const Color(0xFFF87171)
        : (busy ? const Color(0xFF93C5FD) : const Color(0xFFFBBF24));

    return Container(
      margin: const EdgeInsets.only(top: 10),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
      decoration: BoxDecoration(
        color: const Color(0xFF0E1520),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: borderColor),
      ),
      child: Row(
        children: [
          if (busy)
            const Padding(
              padding: EdgeInsets.only(right: 8),
              child: SizedBox(
                width: 14,
                height: 14,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
            )
          else
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: Icon(
                isErr ? Icons.error_outline_rounded : Icons.info_outline_rounded,
                size: 16,
                color: textColor,
              ),
            ),
          Expanded(
            child: Text(
              widget.session.statusMessage,
              style: TextStyle(fontSize: 12, color: textColor),
            ),
          ),
          if (busy)
            TextButton(
              style: TextButton.styleFrom(
                padding: const EdgeInsets.symmetric(horizontal: 8),
                minimumSize: const Size(0, 28),
              ),
              onPressed: () => widget.session.disconnect(),
              child: const Text('取消', style: TextStyle(fontSize: 12, color: Color(0xFFF87171))),
            ),
        ],
      ),
    );
  }

  Widget _buildSegmentedTabs() {
    final tabs = [
      (Icons.wifi_rounded, '局域网/热点'),
      (Icons.hub_rounded, 'Tailscale'),
      (Icons.public_rounded, '公网中继'),
    ];
    return Container(
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        color: const Color(0xFF0C121B),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: const Color(0xFF1E293B)),
      ),
      child: Row(
        children: List.generate(tabs.length, (i) {
          final selected = _homeTab == i;
          final (icon, label) = tabs[i];
          return Expanded(
            child: GestureDetector(
              onTap: () => setState(() => _homeTab = i),
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 160),
                padding: const EdgeInsets.symmetric(vertical: 8),
                decoration: BoxDecoration(
                  color: selected ? const Color(0xFF2563EB) : Colors.transparent,
                  borderRadius: BorderRadius.circular(9),
                ),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(
                      icon,
                      size: 15,
                      color: selected ? Colors.white : const Color(0xFF94A3B8),
                    ),
                    const SizedBox(width: 5),
                    Flexible(
                      child: Text(
                        label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
                          color: selected ? Colors.white : const Color(0xFF94A3B8),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          );
        }),
      ),
    );
  }

  Widget _buildHostTile({
    required String title,
    required String subtitle,
    required bool hasToken,
    required bool busy,
    required VoidCallback onConnect,
    VoidCallback? onQuickFile,
    VoidCallback? onDelete,
  }) {
    return Container(
      margin: const EdgeInsets.only(top: 8),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: const Color(0xFF090E16),
        borderRadius: BorderRadius.circular(11),
        border: Border.all(
          color: hasToken ? const Color(0xFF059669) : const Color(0xFF1F2C3F),
        ),
      ),
      child: Row(
        children: [
          Container(
            width: 8,
            height: 8,
            margin: const EdgeInsets.only(right: 10),
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: hasToken ? const Color(0xFF34D399) : const Color(0xFF60A5FA),
            ),
          ),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14),
                ),
                const SizedBox(height: 2),
                Text(
                  subtitle,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 11.5,
                    color: Color(0xFF94A3B8),
                    fontFamily: 'monospace',
                  ),
                ),
              ],
            ),
          ),
          if (onQuickFile != null)
            IconButton(
              tooltip: '局域网快传',
              constraints: const BoxConstraints(minWidth: 34, minHeight: 34),
              padding: EdgeInsets.zero,
              visualDensity: VisualDensity.compact,
              onPressed: busy ? null : onQuickFile,
              icon: const Icon(Icons.swap_horiz_rounded, size: 19, color: Color(0xFF60A5FA)),
            ),
          if (onDelete != null)
            IconButton(
              tooltip: '移除',
              constraints: const BoxConstraints(minWidth: 34, minHeight: 34),
              padding: EdgeInsets.zero,
              visualDensity: VisualDensity.compact,
              onPressed: busy ? null : onDelete,
              icon: const Icon(Icons.delete_outline_rounded, size: 18, color: Color(0xFF94A3B8)),
            ),
          const SizedBox(width: 4),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: hasToken ? const Color(0xFF059669) : const Color(0xFF2563EB),
              padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 8),
              minimumSize: const Size(0, 34),
            ),
            onPressed: busy ? null : onConnect,
            child: Text(hasToken ? '免密秒连' : '连接', style: const TextStyle(fontSize: 12.5)),
          ),
        ],
      ),
    );
  }

  Widget _buildLanTab(bool busy) {
    return Column(
      children: [
        _buildCard(
          title: '局域网 / 热点自动发现',
          trailing: IconButton(
            visualDensity: VisualDensity.compact,
            onPressed: _scanning ? null : _scanLan,
            icon: _scanning
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.refresh_rounded, size: 19),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (_discovered.isEmpty)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: Text(
                    _scanning
                        ? '正在通过 UDP 广播检索同网段电脑...'
                        : '暂未扫描到在线电脑（请确认电脑端已点“启动串流与配对”且同处热点/Wi-Fi）',
                    style: const TextStyle(fontSize: 12, color: Color(0xFF94A3B8)),
                  ),
                ),
              for (final h in _discovered)
                _buildHostTile(
                  title: h.hostname,
                  subtitle: '${h.ip}:${h.port}${h.version.isNotEmpty ? " · v${h.version}" : ""}',
                  hasToken: h.hasTrustedToken,
                  busy: busy,
                  onQuickFile: () => _showLanFileTransferSheet(h.ip, h.port, h.hostname),
                  onConnect: () => _connectHost(h.ip, h.port, tryToken: true),
                ),
              if (_recent.isNotEmpty) ...[
                const SizedBox(height: 10),
                const Text('最近连接', style: TextStyle(fontSize: 11.5, color: Color(0xFF94A3B8))),
                const SizedBox(height: 6),
                Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: _recent
                      .map(
                        (r) => ActionChip(
                          visualDensity: VisualDensity.compact,
                          avatar: const Icon(Icons.history_rounded, size: 15),
                          label: Text('${r.hostname} (${r.ip})', style: const TextStyle(fontSize: 11.5)),
                          onPressed: busy ? null : () => _connectHost(r.ip, r.port),
                        ),
                      )
                      .toList(),
                ),
              ],
            ],
          ),
        ),
        const SizedBox(height: 10),
        _buildCard(
          title: '手动连接',
          child: Column(
            children: [
              Row(
                children: [
                  Expanded(
                    child: _buildQuickActionPill(
                      icon: Icons.qr_code_scanner_rounded,
                      label: '扫码连接',
                      bgColor: const Color(0xFF172554),
                      borderColor: const Color(0xFF2563EB),
                      fgColor: const Color(0xFF93C5FD),
                      onTap: busy ? null : _scanQrAndConnect,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: _buildQuickActionPill(
                      icon: Icons.usb_rounded,
                      label: 'USB 直连',
                      bgColor: const Color(0xFF06281E),
                      borderColor: const Color(0xFF059669),
                      fgColor: const Color(0xFF34D399),
                      onTap: busy ? null : _tryUsbQuickConnect,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: _buildQuickActionPill(
                      icon: Icons.content_paste_go_rounded,
                      label: '粘贴链接',
                      bgColor: const Color(0xFF111824),
                      borderColor: const Color(0xFF263346),
                      fgColor: const Color(0xFFCBD5E1),
                      onTap: _pasteClipboardToManual,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(
                    flex: 3,
                    child: TextField(
                      controller: _ipCtrl,
                      decoration: const InputDecoration(
                        labelText: '电脑 IP / IP:端口',
                        border: OutlineInputBorder(),
                        isDense: true,
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    flex: 2,
                    child: TextField(
                      controller: _pinCtrl,
                      keyboardType: TextInputType.number,
                      maxLength: 6,
                      decoration: const InputDecoration(
                        labelText: '6 位配对码',
                        counterText: '',
                        border: OutlineInputBorder(),
                        isDense: true,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              Row(
                children: [
                  Expanded(
                    flex: 3,
                    child: SizedBox(
                      height: 42,
                      child: FilledButton.icon(
                        style: FilledButton.styleFrom(
                          padding: const EdgeInsets.symmetric(horizontal: 12),
                        ),
                        onPressed: busy
                            ? null
                            : () {
                                final parsed = _parseHostAndPort(_ipCtrl.text, _manualPort);
                                _connectHost(parsed.ip, parsed.port);
                              },
                        icon: const Icon(Icons.bolt_rounded, size: 17),
                        label: const Text(
                          '直连电脑',
                          maxLines: 1,
                          softWrap: false,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    flex: 2,
                    child: SizedBox(
                      height: 42,
                      child: OutlinedButton.icon(
                        style: OutlinedButton.styleFrom(
                          padding: const EdgeInsets.symmetric(horizontal: 10),
                        ),
                        onPressed: busy
                            ? null
                            : () {
                                final parsed = _parseHostAndPort(_ipCtrl.text, _manualPort);
                                if (parsed.ip.isEmpty) {
                                  _showSnack('请先填写或扫描电脑 IP');
                                  return;
                                }
                                _showLanFileTransferSheet(parsed.ip, parsed.port, parsed.ip);
                              },
                        icon: const Icon(Icons.swap_horiz_rounded, size: 17),
                        label: const Text(
                          '文件快传',
                          maxLines: 1,
                          softWrap: false,
                          style: TextStyle(fontSize: 12.5),
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildTailscaleTab(bool busy) {
    final hasNet = _localTailscaleIp != null || _overlayIps.isNotEmpty;
    return Column(
      children: [
        _buildCard(
          title: 'Tailscale / 异地主机',
          trailing: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              IconButton(
                tooltip: '扫码连接',
                constraints: const BoxConstraints(minWidth: 34, minHeight: 34),
                padding: EdgeInsets.zero,
                visualDensity: VisualDensity.compact,
                onPressed: busy ? null : _scanQrAndConnect,
                icon: const Icon(Icons.qr_code_scanner_rounded, size: 18, color: Color(0xFF60A5FA)),
              ),
              IconButton(
                tooltip: '刷新网卡',
                constraints: const BoxConstraints(minWidth: 34, minHeight: 34),
                padding: EdgeInsets.zero,
                visualDensity: VisualDensity.compact,
                onPressed: _refreshOverlayStatus,
                icon: const Icon(Icons.refresh_rounded, size: 18),
              ),
              const SizedBox(width: 2),
              FilledButton.tonalIcon(
                style: FilledButton.styleFrom(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                  minimumSize: const Size(0, 32),
                ),
                onPressed: _showAddRemoteHostDialog,
                icon: const Icon(Icons.add_rounded, size: 16),
                label: const Text('添加主机', style: TextStyle(fontSize: 12)),
              ),
            ],
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                decoration: BoxDecoration(
                  color: const Color(0xFF090E16),
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(
                    color: hasNet ? const Color(0xFF059669) : const Color(0xFF1F2C3F),
                  ),
                ),
                child: Row(
                  children: [
                    Icon(
                      hasNet ? Icons.verified_user_rounded : Icons.wifi_tethering_off_rounded,
                      size: 16,
                      color: hasNet ? const Color(0xFF34D399) : const Color(0xFF94A3B8),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        _localTailscaleIp != null
                            ? '本机 Tailscale 已就绪：$_localTailscaleIp（已隔离代理 TUN）'
                            : (_overlayIps.isNotEmpty
                                ? '本机异地网卡：${_overlayIps.join(", ")}'
                                : '未检测到 Tailscale / ZeroTier（开启后点刷新）'),
                        style: TextStyle(
                          fontSize: 11.5,
                          color: hasNet ? const Color(0xFF34D399) : const Color(0xFF94A3B8),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              if (_remoteHosts.isEmpty)
                const Padding(
                  padding: EdgeInsets.only(top: 10, bottom: 4),
                  child: Text(
                    '暂无收藏的异地电脑。点右上角「添加主机」填入电脑 100.x.x.x 地址，5G 外出也能一键直连。',
                    style: TextStyle(fontSize: 12, color: Color(0xFF94A3B8)),
                  ),
                ),
              for (final r in _remoteHosts)
                _buildHostTile(
                  title: r.label,
                  subtitle: '${r.ip}:${r.port}',
                  hasToken: _remoteHasToken['${r.ip}:${r.port}'] ?? false,
                  busy: busy,
                  onDelete: () async {
                    await widget.storage.removeRemoteHost(r.ip, r.port);
                    await _initData();
                  },
                  onConnect: () => _connectHost(r.ip, r.port, tryToken: true),
                ),
            ],
          ),
        ),
        const SizedBox(height: 10),
        _buildCard(
          title: '高级兼容选项',
          child: SwitchListTile.adaptive(
            contentPadding: EdgeInsets.zero,
            dense: true,
            title: const Text(
              '兼容非 100.x 自定义 TUN 网段（ZeroTier / WireGuard）',
              style: TextStyle(fontSize: 12.5, color: Color(0xFFCBD5E1)),
            ),
            subtitle: const Text(
              'Tailscale 默认已精确放行；仅自定义私网 IP 段需要开启此项',
              style: TextStyle(fontSize: 11, color: Color(0xFF64748B)),
            ),
            value: _allowOverlayTun,
            onChanged: (v) async {
              await widget.storage.setAllowOverlayTun(v);
              await NativeBridge.setAllowOverlayTun(v);
              if (mounted) setState(() => _allowOverlayTun = v);
            },
          ),
        ),
      ],
    );
  }

  Widget _buildRelayTab(bool busy) {
    return _buildCard(
      title: '公网中继连接',
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          IconButton(
            tooltip: '扫码连接',
            constraints: const BoxConstraints(minWidth: 34, minHeight: 34),
            padding: EdgeInsets.zero,
            visualDensity: VisualDensity.compact,
            onPressed: busy ? null : _scanQrAndConnect,
            icon: const Icon(Icons.qr_code_scanner_rounded, size: 18, color: Color(0xFF60A5FA)),
          ),
          TextButton(
            style: TextButton.styleFrom(
              padding: const EdgeInsets.symmetric(horizontal: 6),
              minimumSize: const Size(0, 30),
            ),
            onPressed: _pasteClipboardToRelay,
            child: const Text('粘贴', style: TextStyle(fontSize: 12)),
          ),
          TextButton(
            style: TextButton.styleFrom(
              padding: const EdgeInsets.symmetric(horizontal: 6),
              minimumSize: const Size(0, 30),
            ),
            onPressed: () => setState(() => _showRelayIceAdvanced = !_showRelayIceAdvanced),
            child: Text(_showRelayIceAdvanced ? '收起 ICE' : 'ICE', style: const TextStyle(fontSize: 12)),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            '不依赖 Tailscale，通过自建 airDesk 信令与 STUN/TURN 端到端加密穿透。',
            style: TextStyle(fontSize: 11.5, color: Color(0xFF94A3B8)),
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                flex: 3,
                child: TextField(
                  controller: _relayUrlCtrl,
                  decoration: const InputDecoration(
                    labelText: '公网信令地址（https://...）',
                    border: OutlineInputBorder(),
                    isDense: true,
                  ),
                  onChanged: _parseRelayInput,
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                flex: 2,
                child: TextField(
                  controller: _relayPinCtrl,
                  keyboardType: TextInputType.number,
                  maxLength: 6,
                  decoration: const InputDecoration(
                    labelText: '6 位配对码',
                    counterText: '',
                    border: OutlineInputBorder(),
                    isDense: true,
                  ),
                ),
              ),
            ],
          ),
          if (_showRelayIceAdvanced) ...[
            const SizedBox(height: 10),
            TextField(
              controller: _customIceCtrl,
              decoration: const InputDecoration(
                labelText: '可选 STUN/TURN（支持 turn:user:pass@ip:3478）',
                border: OutlineInputBorder(),
                isDense: true,
              ),
            ),
          ],
          const SizedBox(height: 12),
          SizedBox(
            width: double.infinity,
            height: 44,
            child: FilledButton.icon(
              style: FilledButton.styleFrom(
                backgroundColor: _relayHasToken ? const Color(0xFF059669) : const Color(0xFF2563EB),
              ),
              onPressed: busy ? null : () => _connectRelay(tryToken: true),
              icon: const Icon(Icons.public_rounded, size: 18),
              label: Text(_relayHasToken ? '公网中继免密秒连' : '通过公网中继连接'),
            ),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final phase = widget.session.phase;
    final busy = phase == SessionPhase.connectingWs ||
        phase == SessionPhase.waitingApproval ||
        phase == SessionPhase.negotiatingRtc;

    return Scaffold(
      backgroundColor: const Color(0xFF05070A),
      body: SafeArea(
        child: RefreshIndicator(
          onRefresh: _scanLan,
          child: ListView(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 20),
            children: [
              _buildHeaderBar(),
              if (!_batteryExempt)
                Container(
                  margin: const EdgeInsets.only(top: 10),
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                  decoration: BoxDecoration(
                    color: const Color(0xFF1C1917),
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(color: const Color(0xFFB45309)),
                  ),
                  child: Row(
                    children: [
                      const Icon(Icons.bolt_rounded, color: Color(0xFFFBBF24), size: 17),
                      const SizedBox(width: 8),
                      const Expanded(
                        child: Text(
                          '建议关闭电池优化，防止 Wi-Fi 休眠引发卡顿',
                          style: TextStyle(fontSize: 12, color: Color(0xFFFDE68A)),
                        ),
                      ),
                      TextButton(
                        style: TextButton.styleFrom(
                          padding: const EdgeInsets.symmetric(horizontal: 8),
                          minimumSize: const Size(0, 28),
                        ),
                        onPressed: () async {
                          await NativeBridge.requestIgnoreBatteryOptimizations();
                          await Future.delayed(const Duration(seconds: 1));
                          final ok = await NativeBridge.isIgnoringBatteryOptimizations();
                          if (mounted) setState(() => _batteryExempt = ok);
                        },
                        child: const Text('去授权', style: TextStyle(fontSize: 12)),
                      ),
                    ],
                  ),
                ),
              if (widget.session.statusMessage.isNotEmpty && phase != SessionPhase.idle)
                _buildStatusBanner(phase, busy),
              const SizedBox(height: 12),
              _buildSegmentedTabs(),
              const SizedBox(height: 12),
              switch (_homeTab) {
                0 => _buildLanTab(busy),
                1 => _buildTailscaleTab(busy),
                _ => _buildRelayTab(busy),
              },
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildQuickActionPill({
    required IconData icon,
    required String label,
    required Color bgColor,
    required Color borderColor,
    required Color fgColor,
    required VoidCallback? onTap,
  }) {
    return InkWell(
      borderRadius: BorderRadius.circular(9),
      onTap: onTap,
      child: Container(
        height: 36,
        padding: const EdgeInsets.symmetric(horizontal: 8),
        decoration: BoxDecoration(
          color: bgColor,
          borderRadius: BorderRadius.circular(9),
          border: Border.all(color: borderColor),
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(icon, size: 15, color: fgColor),
            const SizedBox(width: 5),
            Flexible(
              child: Text(
                label,
                maxLines: 1,
                softWrap: false,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: fgColor,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildCard({required String title, Widget? trailing, required Widget child}) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: const Color(0xFF101622),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: const Color(0xFF1E293B)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600, color: Color(0xFFE2E8F0)),
                ),
              ),
              ?trailing,
            ],
          ),
          const SizedBox(height: 6),
          child,
        ],
      ),
    );
  }
}
