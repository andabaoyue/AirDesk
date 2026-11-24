import 'package:flutter/material.dart';
import '../../services/webrtc_session_service.dart';

class StageTelemetryHud extends StatelessWidget {
  final WebRtcSessionService session;

  const StageTelemetryHud({super.key, required this.session});

  @override
  Widget build(BuildContext context) {
    return RepaintBoundary(
      child: IgnorePointer(
        child: ListenableBuilder(
          listenable: session,
          builder: (_, _) {
            final t = session.telemetry;
            final txHw = t.txHw == null ? '' : (t.txHw! ? '·硬编' : '·软编');
            final rxHw = t.rxHw == null ? '' : (t.rxHw! ? '·硬解' : '·软解');
            final rttStr = t.rttMs != null ? '${t.rttMs}ms' : '--';
            final codecStr = t.codec.isEmpty
                ? '--'
                : (t.codecProfile.isEmpty ? t.codec : '${t.codec}(${t.codecProfile})');
            final rateStr = t.txKbps != null
                ? (t.txKbps! < 1000
                    ? '${t.txKbps}kbps'
                    : '${(t.txKbps! / 1000).toStringAsFixed(1)}Mbps')
                : (t.txMbps != null ? '${t.txMbps!.toStringAsFixed(1)}Mbps' : '--');
            final abrTag = t.abrState == 'throttled' ? ' · ABR' : '';
            final line1 =
                'PC: $codecStr [${t.encoder}$txHw ${t.encodeMs ?? "--"}ms] '
                '${t.txW ?? "--"}x${t.txH ?? "--"} @ ${t.txFps ?? "--"}fps · $rateStr$abrTag · RTT:$rttStr';
            final line2 =
                '手机: ${t.rxFps ?? "--"}fps [${t.decoder}$rxHw ${t.decodeMs ?? "--"}ms] · '
                '缓冲:${t.jbMs ?? "--"}/${t.jbTargetMs ?? "--"}ms · 掉帧:${t.dropped ?? 0}';

            return Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              decoration: BoxDecoration(
                color: const Color(0x990B0F14),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: const Color(0x4494A3B8)),
              ),
              child: DefaultTextStyle(
                style: const TextStyle(
                  fontSize: 10.5,
                  fontFamily: 'monospace',
                  color: Color(0xFF34D399),
                  height: 1.35,
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(line1),
                    Text(line2, style: const TextStyle(color: Color(0xFF93C5FD))),
                  ],
                ),
              ),
            );
          },
        ),
      ),
    );
  }
}
