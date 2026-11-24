import 'package:flutter/foundation.dart';
// ignore: deprecated_member_use
import 'package:flutter/material.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import '../../models/airdesk_models.dart';

Size effectiveStageVideoSize({
  required RTCVideoRenderer renderer,
  int? fallbackTxW,
  int? fallbackTxH,
  double? videoW,
  double? videoH,
  int rotation = 0,
}) {
  double vw = (videoW != null && videoW > 0)
      ? videoW
      : (renderer.videoWidth > 0
          ? renderer.videoWidth.toDouble()
          : (fallbackTxW ?? 1920).toDouble());
  double vh = (videoH != null && videoH > 0)
      ? videoH
      : (renderer.videoHeight > 0
          ? renderer.videoHeight.toDouble()
          : (fallbackTxH ?? 1080).toDouble());
  if (vw <= 0) vw = 1920;
  if (vh <= 0) vh = 1080;
  if ((rotation ~/ 90).isOdd) {
    final tmp = vw;
    vw = vh;
    vh = tmp;
  }
  return Size(vw, vh);
}

/// Single source of truth for video layout rectangle and touch inverse-mapping.
/// Guarantees zero cropping in all modes while dynamically adapting to any phone/PC aspect ratio.
Rect computeStageVideoRect({
  required Size stageSize,
  required RTCVideoRenderer renderer,
  required ViewScaleMode scaleMode,
  required double fillRatio,
  int? fallbackTxW,
  int? fallbackTxH,
  double? videoW,
  double? videoH,
  int rotation = 0,
}) {
  if (stageSize.width <= 0 || stageSize.height <= 0) {
    return Rect.zero;
  }
  final eff = effectiveStageVideoSize(
    renderer: renderer,
    fallbackTxW: fallbackTxW,
    fallbackTxH: fallbackTxH,
    videoW: videoW,
    videoH: videoH,
    rotation: rotation,
  );
  final va = eff.width / eff.height;
  final ba = stageSize.width / stageSize.height;

  double containW = stageSize.width;
  double containH = stageSize.height;
  if (ba > va) {
    containW = stageSize.height * va;
  } else {
    containH = stageSize.width / va;
  }

  double drawW = containW;
  double drawH = containH;
  if (scaleMode == ViewScaleMode.adaptiveFill) {
    final t = fillRatio.clamp(0.0, 1.0);
    drawW = containW + (stageSize.width - containW) * t;
    drawH = containH + (stageSize.height - containH) * t;
  }

  final drawLeft = (stageSize.width - drawW) / 2;
  final drawTop = (stageSize.height - drawH) / 2;
  return Rect.fromLTWH(drawLeft, drawTop, drawW, drawH);
}

class StageVideoLayer extends StatelessWidget {
  final Size stageSize;
  final RTCVideoRenderer renderer;
  final ViewScaleMode scaleMode;
  final double fillRatio;
  final int? fallbackTxW;
  final int? fallbackTxH;
  final ValueListenable<Offset?> localCursorNorm;
  final InputControlMode inputMode;

  const StageVideoLayer({
    super.key,
    required this.stageSize,
    required this.renderer,
    required this.scaleMode,
    required this.fillRatio,
    required this.fallbackTxW,
    required this.fallbackTxH,
    required this.localCursorNorm,
    required this.inputMode,
  });

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<RTCVideoValue>(
      valueListenable: renderer,
      builder: (context, value, _) {
        final texId = renderer.textureId;
        if (!renderer.renderVideo || texId == null) {
          return const ColoredBox(color: Colors.black);
        }
        final rect = computeStageVideoRect(
          stageSize: stageSize,
          renderer: renderer,
          scaleMode: scaleMode,
          fillRatio: fillRatio,
          fallbackTxW: fallbackTxW,
          fallbackTxH: fallbackTxH,
          videoW: value.width > 0 ? value.width : null,
          videoH: value.height > 0 ? value.height : null,
          rotation: value.rotation,
        );
        Widget tex = Texture(
          textureId: texId,
          filterQuality: FilterQuality.medium,
        );
        final quarterTurns = (value.rotation ~/ 90) % 4;
        if (quarterTurns != 0) {
          tex = RotatedBox(quarterTurns: quarterTurns, child: tex);
        }
        return ColoredBox(
          color: Colors.black,
          child: Stack(
            children: [
              Positioned(
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
                child: RepaintBoundary(child: tex),
              ),
              ValueListenableBuilder<Offset?>(
                valueListenable: localCursorNorm,
                builder: (_, norm, _) {
                  if (inputMode != InputControlMode.touchpad || norm == null) {
                    return const SizedBox.shrink();
                  }
                  final cx = rect.left + norm.dx * rect.width;
                  final cy = rect.top + norm.dy * rect.height;
                  return Positioned(
                    left: cx - 12,
                    top: cy - 12,
                    width: 24,
                    height: 24,
                    child: RepaintBoundary(
                      child: IgnorePointer(
                        child: Container(
                          decoration: BoxDecoration(
                            shape: BoxShape.circle,
                            border: Border.all(color: const Color(0xCC22D3EE), width: 1.6),
                            color: const Color(0x2222D3EE),
                          ),
                          child: Center(
                            child: Container(
                              width: 4,
                              height: 4,
                              decoration: const BoxDecoration(
                                shape: BoxShape.circle,
                                color: Color(0xEE22D3EE),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  );
                },
              ),
            ],
          ),
        );
      },
    );
  }
}
