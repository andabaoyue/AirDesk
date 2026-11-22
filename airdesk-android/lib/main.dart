// ignore: deprecated_member_use
import 'package:flutter/material.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'pages/home_connect_page.dart';
import 'services/discovery_service.dart';
import 'services/storage_service.dart';
import 'services/webrtc_session_service.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await WebRTC.initialize(
    options: {
      'zeroPlayoutDelay': true,
      'bypassVoiceProcessing': true,
      'androidAudioConfiguration': AndroidAudioConfiguration.media.toMap(),
      'networkIgnoreMask': ['adapterTypeVpn', 'adapterTypeLoopback'],
    },
  );
  runApp(const AirDeskApp());
}

class AirDeskApp extends StatefulWidget {
  const AirDeskApp({super.key});

  @override
  State<AirDeskApp> createState() => _AirDeskAppState();
}

class _AirDeskAppState extends State<AirDeskApp> {
  late final StorageService _storage;
  late final DiscoveryService _discovery;
  late final WebRtcSessionService _session;

  @override
  void initState() {
    super.initState();
    _storage = StorageService();
    _discovery = DiscoveryService(_storage);
    _session = WebRtcSessionService(_storage);
  }

  @override
  void dispose() {
    _session.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'AirDesk',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        brightness: Brightness.dark,
        scaffoldBackgroundColor: const Color(0xFF05070A),
        colorScheme: const ColorScheme.dark(
          primary: Color(0xFF2563EB),
          secondary: Color(0xFF34D399),
          surface: Color(0xFF131922),
        ),
        useMaterial3: true,
      ),
      home: HomeConnectPage(
        storage: _storage,
        discovery: _discovery,
        session: _session,
      ),
    );
  }
}
