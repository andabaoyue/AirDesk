import 'package:airdesk_app/main.dart';
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
}
