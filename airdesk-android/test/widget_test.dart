import 'dart:convert';
import 'dart:typed_data';
import 'package:airdesk_app/main.dart';
import 'package:airdesk_app/services/scrypt_helper.dart';
import 'package:airdesk_app/services/sdp_helper.dart';
import 'package:airdesk_app/services/storage_service.dart';
import 'package:airdesk_app/services/webrtc_session_service.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  testWidgets('AirDeskApp renders home connect title', (WidgetTester tester) async {
    await tester.pumpWidget(const AirDeskApp());
    expect(find.text('AirDesk'), findsOneWidget);
    expect(find.text('v0.7.5'), findsOneWidget);
  });

  test('StorageService persists and clears relay hostId per endpoint', () async {
    SharedPreferences.setMockInitialValues({});
    final storage = StorageService();
    final key = WebRtcSessionService.tokenKeyForEndpoint(
      signalingUrl: 'https://relay.example.com',
    );
    expect(await storage.getHostIdForKey(key), isNull);

    await storage.saveHostIdForKey(key, '482910537');
    expect(await storage.getHostIdForKey(key), '482910537');

    await storage.removeHostIdForKey(key);
    expect(await storage.getHostIdForKey(key), isNull);
  });

  test('WebRtcSessionService builds v2 join payload and preserves tokens on HOST_OFFLINE', () {
    final joinWithHost = WebRtcSessionService.buildClientJoinPayload(
      deviceLabel: 'Xiaomi 13',
      sessionToken: '0123456789abcdef',
      hostId: '482910537',
    );
    expect(joinWithHost['protoVersion'], 2);
    expect(joinWithHost['hostId'], '482910537');
    expect(joinWithHost['sessionToken'], '0123456789abcdef');

    expect(
      WebRtcSessionService.shouldClearSavedTokenOnError(
        'error',
        {'code': 'HOST_OFFLINE', 'retryable': true, 'message': '目标电脑暂不在线（等待恢复）'},
        hadToken: true,
      ),
      isFalse,
    );
    expect(
      WebRtcSessionService.shouldClearSavedTokenOnError(
        'error',
        {'message': '尝试次数过多，请 1 分钟后再试'},
        hadToken: true,
      ),
      isFalse,
    );
    expect(
      WebRtcSessionService.shouldClearSavedTokenOnError(
        'error',
        {'code': 'TOKEN_INVALID', 'message': '自动重连凭证已失效'},
        hadToken: true,
      ),
      isTrue,
    );
    expect(
      WebRtcSessionService.shouldClearSavedTokenOnError(
        'client:rejected',
        {'reason': '电脑端已拒绝本次连接请求'},
        hadToken: true,
      ),
      isTrue,
    );
  });

  test('ScryptHelper matches Node crypto.scryptSync UTF-8 and RFC 7914 vectors', () async {
    // RFC 7914 vector verified against Node crypto.scryptSync
    final rfcDk = ScryptHelper.scrypt(
      Uint8List.fromList(utf8.encode('pleaseletmein')),
      Uint8List.fromList(utf8.encode('SodiumChloride')),
      n: 16384,
      r: 8,
      p: 1,
      dkLen: 64,
    );
    expect(
      ScryptHelper.bytesToHex(rfcDk),
      '7023bdcb3afd7348461c06cd81fd38ebfda8fbba904f8e3ea9b543f6545da1f2'
      'd5432955613f0fcf62d49705242a9af9e61e85dc0d651e40dfcf017b45575887',
    );

    // UTF-8 special characters + emoji challenge proof cross-checked with Node crypto.scryptSync
    final proof = await ScryptHelper.computeChallengeProofAsync(
      password: 'AirDesk@2026!中文🔑',
      saltHex: '00112233445566778899aabbccddeeff',
      hostId: 'k7m2p9x4q1w8',
      challengeId: 'chal-1',
      nonce: 'nonce-xyz',
    );
    expect(proof, '53061866856777db645ca681a64a5b6d20720060b0ca79d56d54d5a777b8961c');
  });

  test('WebRtcSessionService password auth join payload & error preservation', () {
    final pwJoin = WebRtcSessionService.buildClientJoinPayload(
      deviceLabel: 'Xiaomi 13',
      hostId: 'k7m2p9x4q1w8',
      authMode: 'password',
    );
    expect(pwJoin['protoVersion'], 2);
    expect(pwJoin['authMode'], 'password');
    expect(pwJoin['hostId'], 'k7m2p9x4q1w8');
    expect(pwJoin.containsKey('sessionToken'), isFalse);
    expect(pwJoin.containsKey('code'), isFalse);

    expect(
      WebRtcSessionService.shouldClearSavedTokenOnError(
        'error',
        {'code': 'PASSWORD_INVALID', 'message': '访问密码错误（还剩 4 次机会）'},
        hadToken: false,
      ),
      isFalse,
    );
    expect(
      WebRtcSessionService.shouldClearSavedTokenOnError(
        'error',
        {'code': 'HOST_OFFLINE', 'retryable': true, 'message': '目标电脑暂不在线（等待恢复）'},
        hadToken: true,
      ),
      isFalse,
    );
  });

  test('ScryptHelper rejects out-of-bounds KDF parameters before allocation', () async {
    // Valid boundary combinations
    expect(
      () => ScryptHelper.validateScryptParams(n: 1024, r: 1, p: 1, dkLen: 16),
      returnsNormally,
    );
    expect(
      () => ScryptHelper.validateScryptParams(n: 65536, r: 8, p: 1, dkLen: 64),
      returnsNormally,
    );
    expect(
      () => ScryptHelper.validateScryptParams(n: 16384, r: 8, p: 4, dkLen: 64),
      returnsNormally,
    );

    final pw = Uint8List.fromList(utf8.encode('secret'));
    final salt = Uint8List.fromList(utf8.encode('0123456789abcdef'));

    final invalidCases = <({int n, int r, int p, int dkLen})>[
      // n out of bounds or not power of 2
      (n: 512, r: 8, p: 1, dkLen: 32),
      (n: 0, r: 8, p: 1, dkLen: 32),
      (n: -16384, r: 8, p: 1, dkLen: 32),
      (n: 131072, r: 1, p: 1, dkLen: 32),
      (n: 1 << 24, r: 8, p: 1, dkLen: 32),
      (n: 3000, r: 8, p: 1, dkLen: 32),
      (n: 16385, r: 8, p: 1, dkLen: 32),
      // r out of bounds
      (n: 16384, r: 0, p: 1, dkLen: 32),
      (n: 1024, r: 17, p: 1, dkLen: 32),
      (n: 1024, r: 1024, p: 1, dkLen: 32),
      // p out of bounds
      (n: 16384, r: 8, p: 0, dkLen: 32),
      (n: 16384, r: 8, p: 5, dkLen: 32),
      // dkLen out of bounds
      (n: 16384, r: 8, p: 1, dkLen: 15),
      (n: 16384, r: 8, p: 1, dkLen: 0),
      (n: 16384, r: 8, p: 1, dkLen: 65),
      (n: 16384, r: 8, p: 1, dkLen: 1 << 20),
      // n * r * p exceeds maxCost (65536 * 8)
      (n: 65536, r: 16, p: 1, dkLen: 32),
      (n: 65536, r: 8, p: 4, dkLen: 32),
    ];

    for (final c in invalidCases) {
      expect(
        () => ScryptHelper.validateScryptParams(n: c.n, r: c.r, p: c.p, dkLen: c.dkLen),
        throwsArgumentError,
      );
      expect(
        () => ScryptHelper.scrypt(pw, salt, n: c.n, r: c.r, p: c.p, dkLen: c.dkLen),
        throwsArgumentError,
      );
      expect(
        () => ScryptHelper.computeChallengeProofSync(
          password: 'secret',
          saltHex: '00112233445566778899aabbccddeeff',
          hostId: 'host-1',
          challengeId: 'chal-1',
          nonce: 'nonce-1',
          n: c.n,
          r: c.r,
          p: c.p,
          dkLen: c.dkLen,
        ),
        throwsArgumentError,
      );
      await expectLater(
        ScryptHelper.computeChallengeProofAsync(
          password: 'secret',
          saltHex: '00112233445566778899aabbccddeeff',
          hostId: 'host-1',
          challengeId: 'chal-1',
          nonce: 'nonce-1',
          n: c.n,
          r: c.r,
          p: c.p,
          dkLen: c.dkLen,
        ),
        throwsArgumentError,
      );
    }
  });

  test('WebRtcSessionService validates relay password_challenge KDF parameters', () {
    expect(
      WebRtcSessionService.parseAndValidateChallengeKdfParams({}),
      (n: 16384, r: 8, p: 1, dkLen: 32),
    );
    expect(
      WebRtcSessionService.parseAndValidateChallengeKdfParams({
        'kdf': 'scrypt',
        'n': 32768.0,
        'r': 8,
        'p': 2,
        'dkLen': 64,
      }),
      (n: 32768, r: 8, p: 2, dkLen: 64),
    );

    final badMsgs = <Map<String, dynamic>>[
      {'kdf': 'argon2'},
      {'n': 131072, 'r': 8, 'p': 1, 'dkLen': 32},
      {'n': 3000, 'r': 8, 'p': 1, 'dkLen': 32},
      {'n': 16384, 'r': 17, 'p': 1, 'dkLen': 32},
      {'n': 16384, 'r': 8, 'p': 5, 'dkLen': 32},
      {'n': 16384, 'r': 8, 'p': 1, 'dkLen': 15},
      {'n': 16384, 'r': 8, 'p': 1, 'dkLen': 65},
      {'n': 65536, 'r': 16, 'p': 1, 'dkLen': 32},
      {'n': 65536, 'r': 8, 'p': 4, 'dkLen': 32},
      {'n': '16384'},
      {'n': 16384.5},
    ];

    for (final msg in badMsgs) {
      expect(
        () => WebRtcSessionService.parseAndValidateChallengeKdfParams(msg),
        throwsArgumentError,
      );
    }
  });

  test('PR 1 tokenKeyForEndpoint isolates multiple hosts on same relay and preserves legacy fallback', () async {
    SharedPreferences.setMockInitialValues({});
    final storage = StorageService();

    const relayUrl = 'https://relay.example.com';
    final baseKey = WebRtcSessionService.tokenKeyForEndpoint(signalingUrl: relayUrl);
    final hostAKey = WebRtcSessionService.tokenKeyForEndpoint(
      signalingUrl: relayUrl,
      hostId: 'hostA1234567',
    );
    final hostBKey = WebRtcSessionService.tokenKeyForEndpoint(
      signalingUrl: relayUrl,
      hostId: 'hostB7654321',
    );
    expect(baseKey, 'relay:relay.example.com:443');
    expect(hostAKey, 'relay:relay.example.com:443:hostA1234567');
    expect(hostBKey, 'relay:relay.example.com:443:hostB7654321');
    expect(
      WebRtcSessionService.tokenKeyForEndpoint(hostIp: '192.168.1.10', port: 47820, hostId: 'ignored'),
      '192.168.1.10:47820',
    );

    // Unmapped legacy token must NOT be returned or deleted when a specific hostId is requested
    await storage.saveTokenForKey(baseKey, 'unmapped-legacy');
    expect(await storage.getTokenForRelay(baseKey), 'unmapped-legacy');
    expect(await storage.getTokenForRelay(baseKey, hostId: 'hostB7654321'), isNull);
    await storage.removeTokenForRelay(baseKey, hostId: 'hostB7654321');
    expect(await storage.getTokenForRelay(baseKey), 'unmapped-legacy');

    // Legacy token under baseKey works only for matching hostId, and does NOT leak to another hostId
    await storage.saveTokenForKey(baseKey, 'legacy-tok-A');
    await storage.saveHostIdForKey(baseKey, 'hostA1234567');
    expect(await storage.getTokenForRelay(baseKey, hostId: 'hostA1234567'), 'legacy-tok-A');
    expect(await storage.getTokenForRelay(baseKey, hostId: 'hostB7654321'), isNull);

    // Scoped tokens for hostA and hostB stay isolated
    await storage.saveTokenForKey(hostAKey, 'scoped-tok-A');
    await storage.saveTokenForKey(hostBKey, 'scoped-tok-B');
    expect(await storage.getTokenForRelay(baseKey, hostId: 'hostA1234567'), 'scoped-tok-A');
    expect(await storage.getTokenForRelay(baseKey, hostId: 'hostB7654321'), 'scoped-tok-B');

    await storage.removeTokenForRelay(baseKey, hostId: 'hostB7654321');
    expect(await storage.getTokenForRelay(baseKey, hostId: 'hostB7654321'), isNull);
    expect(await storage.getTokenForRelay(baseKey, hostId: 'hostA1234567'), 'scoped-tok-A');
  });

  test('PR 1 StorageService forceTurnRelay & WebRtcSessionService.buildRtcConfig', () async {
    SharedPreferences.setMockInitialValues({});
    final storage = StorageService();
    expect(await storage.getForceTurnRelay(), isFalse);
    await storage.setForceTurnRelay(true);
    expect(await storage.getForceTurnRelay(), isTrue);

    final noIceCfg = WebRtcSessionService.buildRtcConfig(const [], forceTurnRelay: true);
    expect(noIceCfg['iceCandidatePoolSize'], 0);
    expect(noIceCfg.containsKey('iceTransportPolicy'), isFalse);

    final stunOnlyCfg = WebRtcSessionService.buildRtcConfig(
      const [
        {'urls': 'stun:stun.example.com:3478'},
      ],
      forceTurnRelay: true,
    );
    expect(stunOnlyCfg['iceCandidatePoolSize'], 2);
    expect(stunOnlyCfg.containsKey('iceTransportPolicy'), isFalse);

    final turnCfgOff = WebRtcSessionService.buildRtcConfig(
      const [
        {'urls': 'turn:turn.example.com:3478', 'username': 'u', 'credential': 'p'},
      ],
      forceTurnRelay: false,
    );
    expect(turnCfgOff['iceCandidatePoolSize'], 2);
    expect(turnCfgOff.containsKey('iceTransportPolicy'), isFalse);

    final turnCfgOn = WebRtcSessionService.buildRtcConfig(
      const [
        {'urls': 'turns:turn.example.com:5349', 'username': 'u', 'credential': 'p'},
      ],
      forceTurnRelay: true,
    );
    expect(turnCfgOn['iceCandidatePoolSize'], 2);
    expect(turnCfgOn['iceTransportPolicy'], 'relay');
  });

  test('PR 2 SdpHelper, attachExisting payload & shouldSkipRtcRebuildOnApproved', () {
    expect(SdpHelper.isVirtualCandidate('candidate:1 1 UDP 2122 198.18.0.1 5000 typ host'), isTrue);
    expect(SdpHelper.isVirtualCandidate('candidate:1 1 UDP 2122 172.19.0.1 5000 typ host'), isTrue);
    expect(SdpHelper.isVirtualCandidate('candidate:1 1 UDP 2122 192.168.1.5 5000 typ host'), isFalse);

    const rawOffer = [
      'v=0',
      'm=video 9 UDP/TLS/RTP/SAVPF 96 97 98 99 100',
      'a=rtpmap:96 VP8/90000',
      'a=rtpmap:97 H264/90000',
      'a=fmtp:97 profile-level-id=42001f',
      'a=rtpmap:98 H264/90000',
      'a=fmtp:98 profile-level-id=42e01f',
      'a=rtpmap:99 rtx/90000',
      'a=fmtp:99 apt=98',
      'a=rtpmap:100 H265/90000',
    ].join('\r\n');

    final h264Sdp = SdpHelper.prioritizeVideoCodecs(rawOffer, preferHevc: false);
    final h264MLine = h264Sdp.split('\r\n').firstWhere((l) => l.startsWith('m=video '));
    expect(h264MLine, 'm=video 9 UDP/TLS/RTP/SAVPF 98 99 97 96 100');
    expect(h264Sdp.contains(SdpHelper.playoutDelayExtUri), isTrue);

    final hevcSdp = SdpHelper.prioritizeVideoCodecs(rawOffer, preferHevc: true);
    final hevcMLine = hevcSdp.split('\r\n').firstWhere((l) => l.startsWith('m=video '));
    expect(hevcMLine, 'm=video 9 UDP/TLS/RTP/SAVPF 100 98 99 97 96');

    final attachPayload = WebRtcSessionService.buildClientJoinPayload(
      deviceLabel: 'Xiaomi 13',
      sessionToken: '0123456789abcdef',
      hostId: 'host12345678',
      attachExisting: true,
    );
    expect(attachPayload['attachExisting'], isTrue);

    expect(
      WebRtcSessionService.shouldSkipRtcRebuildOnApproved({'reattached': true}, hasLivePc: true),
      isTrue,
    );
    expect(
      WebRtcSessionService.shouldSkipRtcRebuildOnApproved({'reattached': false}, hasLivePc: true),
      isFalse,
    );
    expect(
      WebRtcSessionService.shouldSkipRtcRebuildOnApproved({'reattached': true}, hasLivePc: false),
      isFalse,
    );
  });
}
