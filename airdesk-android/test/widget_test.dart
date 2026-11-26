import 'dart:convert';
import 'dart:typed_data';
import 'package:airdesk_app/main.dart';
import 'package:airdesk_app/services/scrypt_helper.dart';
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
}
