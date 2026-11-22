import 'package:airdesk_app/main.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('AirDeskApp renders home connect title', (WidgetTester tester) async {
    await tester.pumpWidget(const AirDeskApp());
    expect(find.text('AirDesk'), findsOneWidget);
    expect(find.text('v0.7.5'), findsOneWidget);
  });
}
