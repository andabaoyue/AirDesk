import 'dart:math' as math;
// ignore: deprecated_member_use
import 'package:flutter/material.dart';
import '../../models/airdesk_models.dart';
import '../../services/webrtc_session_service.dart';
import 'stage_video_layer.dart';

class StageTouchpadQuickButtons extends StatelessWidget {
  final bool controlEnabled;
  final void Function(String button, String state) onMouseButton;

  const StageTouchpadQuickButtons({
    super.key,
    required this.controlEnabled,
    required this.onMouseButton,
  });

  Widget _quickMouseBtn(String label, String button) {
    return GestureDetector(
      onTapDown: (_) {
        if (controlEnabled) {
          onMouseButton(button, 'down');
        }
      },
      onTapUp: (_) {
        if (controlEnabled) {
          onMouseButton(button, 'up');
        }
      },
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        decoration: BoxDecoration(
          color: const Color(0xAA0F172A),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: const Color(0xFF334155)),
        ),
        child: Text(label, style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600)),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        _quickMouseBtn('左键', 'left'),
        const SizedBox(width: 8),
        _quickMouseBtn('右键', 'right'),
      ],
    );
  }
}

class StageVirtualKeyboard extends StatelessWidget {
  final TextEditingController imeController;
  final Set<String> lockedMods;
  final bool controlEnabled;
  final ValueChanged<String> onKeyTap;
  final ValueChanged<String> onToggleMod;
  final ValueChanged<List<String>> onCombo;
  final VoidCallback onSendText;
  final VoidCallback onSendSas;
  final VoidCallback onHide;

  const StageVirtualKeyboard({
    super.key,
    required this.imeController,
    required this.lockedMods,
    required this.controlEnabled,
    required this.onKeyTap,
    required this.onToggleMod,
    required this.onCombo,
    required this.onSendText,
    required this.onSendSas,
    required this.onHide,
  });

  Widget _keyBtn(String label, {String? code, String? mod, VoidCallback? onTap}) {
    final isModActive = mod != null && lockedMods.contains(mod);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 2),
      child: InkWell(
        onTap: onTap ??
            () {
              if (mod != null) {
                onToggleMod(mod);
              } else if (code != null) {
                onKeyTap(code);
              }
            },
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          decoration: BoxDecoration(
            color: isModActive ? const Color(0xFF2563EB) : const Color(0xFF1E293B),
            borderRadius: BorderRadius.circular(7),
            border: Border.all(color: const Color(0xFF475569)),
          ),
          child: Text(label, style: const TextStyle(fontSize: 12, fontFamily: 'monospace')),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(10, 8, 10, 10),
      decoration: const BoxDecoration(
        color: Color(0xEB090D14),
        border: Border(top: BorderSide(color: Color(0x4494A3B8))),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: imeController,
                  decoration: const InputDecoration(
                    hintText: '输入中文或任意文本后点右侧发送...',
                    isDense: true,
                    contentPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                    border: OutlineInputBorder(),
                  ),
                ),
              ),
              const SizedBox(width: 6),
              FilledButton(
                onPressed: onSendText,
                child: const Text('发送文本'),
              ),
              IconButton(
                onPressed: onHide,
                icon: const Icon(Icons.keyboard_hide_rounded),
              ),
            ],
          ),
          const SizedBox(height: 6),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                _keyBtn('Esc', code: 'Escape'),
                _keyBtn('Tab', code: 'Tab'),
                _keyBtn('Ctrl', mod: 'ControlLeft'),
                _keyBtn('Alt', mod: 'AltLeft'),
                _keyBtn('Shift', mod: 'ShiftLeft'),
                _keyBtn('Win', mod: 'MetaLeft'),
                _keyBtn('Bksp', code: 'Backspace'),
                _keyBtn('Del', code: 'Delete'),
                _keyBtn('Enter', code: 'Enter'),
                _keyBtn('←', code: 'ArrowLeft'),
                _keyBtn('↑', code: 'ArrowUp'),
                _keyBtn('↓', code: 'ArrowDown'),
                _keyBtn('→', code: 'ArrowRight'),
                _keyBtn('Ctrl+C', onTap: () => onCombo(['ControlLeft', 'KeyC'])),
                _keyBtn('Ctrl+V', onTap: () => onCombo(['ControlLeft', 'KeyV'])),
                _keyBtn('Ctrl+Z', onTap: () => onCombo(['ControlLeft', 'KeyZ'])),
                _keyBtn('Alt+Tab', onTap: () => onCombo(['AltLeft', 'Tab'])),
                _keyBtn('Win+D', onTap: () => onCombo(['MetaLeft', 'KeyD'])),
                _keyBtn(
                  'Ctrl+Alt+Del',
                  onTap: () {
                    if (!controlEnabled) return;
                    onSendSas();
                  },
                ),
                _keyBtn('F4', code: 'F4'),
                _keyBtn('F5', code: 'F5'),
                _keyBtn('F11', code: 'F11'),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class StageControlDrawer extends StatelessWidget {
  final WebRtcSessionService session;
  final int activeTab;
  final ScenePreset preset;
  final ViewScaleMode scaleMode;
  final double fillRatio;
  final InputControlMode inputMode;
  final String contentHint;
  final bool preferHevc;
  final bool pointerCaptureEnabled;
  final bool autoSyncClipboard;
  final bool showHud;
  final bool showVkb;
  final ValueChanged<int> onTabChanged;
  final ValueChanged<ScenePreset> onApplyPreset;
  final ValueChanged<ViewScaleMode> onChangeScaleMode;
  final ValueChanged<double> onPreviewFillRatio;
  final ValueChanged<double> onCommitFillRatio;
  final ValueChanged<InputControlMode> onChangeInputMode;
  final ValueChanged<String> onChangeContentHint;
  final ValueChanged<bool> onChangePreferHevc;
  final ValueChanged<bool> onChangePointerCapture;
  final ValueChanged<bool> onChangeAutoClipboard;
  final VoidCallback onToggleAudio;
  final VoidCallback onToggleHud;
  final VoidCallback onToggleVkb;
  final VoidCallback onPullClipboard;
  final VoidCallback onPushClipboard;
  final VoidCallback onPickAndSendFile;
  final VoidCallback onEnterPip;
  final VoidCallback onReconnect;
  final VoidCallback onCloseDrawer;
  final VoidCallback onExitStage;

  const StageControlDrawer({
    super.key,
    required this.session,
    required this.activeTab,
    required this.preset,
    required this.scaleMode,
    required this.fillRatio,
    required this.inputMode,
    required this.contentHint,
    required this.preferHevc,
    required this.pointerCaptureEnabled,
    required this.autoSyncClipboard,
    required this.showHud,
    required this.showVkb,
    required this.onTabChanged,
    required this.onApplyPreset,
    required this.onChangeScaleMode,
    required this.onPreviewFillRatio,
    required this.onCommitFillRatio,
    required this.onChangeInputMode,
    required this.onChangeContentHint,
    required this.onChangePreferHevc,
    required this.onChangePointerCapture,
    required this.onChangeAutoClipboard,
    required this.onToggleAudio,
    required this.onToggleHud,
    required this.onToggleVkb,
    required this.onPullClipboard,
    required this.onPushClipboard,
    required this.onPickAndSendFile,
    required this.onEnterPip,
    required this.onReconnect,
    required this.onCloseDrawer,
    required this.onExitStage,
  });

  String _shortPresetSpec(ScenePreset p) {
    final bps = p.bitrateKbps >= 1000
        ? '${(p.bitrateKbps / 1000).round()}M'
        : '${p.bitrateKbps}K';
    final res = p.resolution == 'native' ? '原生' : p.resolution;
    return '$res·${p.fps}f·$bps';
  }

  String _formatFileBytes(int bytes) {
    if (bytes < 1024) return '$bytes B';
    if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
    return '${(bytes / (1024 * 1024)).toStringAsFixed(2)} MB';
  }

  Widget _buildResolutionAdapterSection(BuildContext context) {
    final mq = MediaQuery.of(context);
    final stageW = math.max(mq.size.width, mq.size.height);
    final stageH = math.min(mq.size.width, mq.size.height);
    final stageSize = Size(stageW, stageH);
    final physW = (stageW * mq.devicePixelRatio).round();
    final physH = (stageH * mq.devicePixelRatio).round();
    final phoneRatio9 = stageH > 0 ? (stageW / stageH * 9).toStringAsFixed(1) : '--';

    final eff = effectiveStageVideoSize(
      renderer: session.remoteRenderer,
      fallbackTxW: session.telemetry.txW,
      fallbackTxH: session.telemetry.txH,
      rotation: session.remoteRenderer.value.rotation,
    );
    final pcW = eff.width.round();
    final pcH = eff.height.round();
    final pcRatio9 = eff.height > 0 ? (eff.width / eff.height * 9).toStringAsFixed(1) : '--';

    final rect = computeStageVideoRect(
      stageSize: stageSize,
      renderer: session.remoteRenderer,
      scaleMode: scaleMode,
      fillRatio: fillRatio,
      fallbackTxW: session.telemetry.txW,
      fallbackTxH: session.telemetry.txH,
      rotation: session.remoteRenderer.value.rotation,
    );
    final pcAspect = eff.width / eff.height;
    final drawAspect = rect.height > 0 ? rect.width / rect.height : pcAspect;
    final stretchRatio = pcAspect > 0 ? (drawAspect / pcAspect) : 1.0;

    final pct = (fillRatio * 100).round();
    final summaryText = scaleMode == ViewScaleMode.adaptiveFill
        ? '填充 $pct% · 横向 ${stretchRatio.toStringAsFixed(2)}× · 零裁切'
        : (scaleMode == ViewScaleMode.freeZoom
            ? '双指缩放漫游 · 原比例 1.00×'
            : '原比例完整 · 1.00×');

    Widget quickPresetBtn(String label, double ratio) {
      final selected = (fillRatio - ratio).abs() < 0.025;
      return Expanded(
        child: InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: () => onCommitFillRatio(ratio),
          child: Container(
            padding: const EdgeInsets.symmetric(vertical: 5),
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: selected ? const Color(0xFF1D4ED8) : const Color(0xFF16202F),
              borderRadius: BorderRadius.circular(8),
              border: Border.all(
                color: selected ? const Color(0xFF60A5FA) : const Color(0xFF2B3A4E),
              ),
            ),
            child: Text(
              label,
              style: TextStyle(
                fontSize: 11,
                fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
                color: Colors.white,
              ),
            ),
          ),
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('屏幕与分辨率适配', style: TextStyle(fontSize: 11.5, color: Color(0xFF94A3B8))),
        const SizedBox(height: 5),
        Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
          decoration: BoxDecoration(
            color: const Color(0x99070B11),
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: const Color(0xFF243041)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '手机 $physW×$physH ($phoneRatio9:9)  ·  电脑 $pcW×$pcH ($pcRatio9:9)',
                style: const TextStyle(fontSize: 10.5, color: Color(0xFFCBD5E1)),
              ),
              const SizedBox(height: 2),
              Text(
                summaryText,
                style: const TextStyle(
                  fontSize: 11,
                  color: Color(0xFF34D399),
                  fontWeight: FontWeight.w500,
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 6),
        Row(
          children: ViewScaleMode.values.map((m) {
            final selected = scaleMode == m;
            final shortLabel = switch (m) {
              ViewScaleMode.adaptiveFill => '自适应铺满',
              ViewScaleMode.contain => '原比例',
              ViewScaleMode.freeZoom => '自由缩放',
            };
            return Expanded(
              child: Padding(
                padding: EdgeInsets.only(right: m == ViewScaleMode.values.last ? 0 : 6),
                child: InkWell(
                  borderRadius: BorderRadius.circular(8),
                  onTap: () => onChangeScaleMode(m),
                  child: Container(
                    padding: const EdgeInsets.symmetric(vertical: 6),
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: selected ? const Color(0xFF1E3A8A) : const Color(0xFF16202F),
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(
                        color: selected ? const Color(0xFF60A5FA) : const Color(0xFF2B3A4E),
                      ),
                    ),
                    child: Text(
                      shortLabel,
                      style: TextStyle(
                        fontSize: 11,
                        fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
                        color: Colors.white,
                      ),
                    ),
                  ),
                ),
              ),
            );
          }).toList(),
        ),
        if (scaleMode == ViewScaleMode.adaptiveFill) ...[
          const SizedBox(height: 7),
          Row(
            children: [
              const Text('黑边填充度', style: TextStyle(fontSize: 11, color: Color(0xFFCBD5E1))),
              const Spacer(),
              Text(
                '$pct%',
                style: const TextStyle(
                  fontSize: 11,
                  fontFamily: 'monospace',
                  color: Color(0xFF60A5FA),
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
          SliderTheme(
            data: SliderTheme.of(context).copyWith(
              trackHeight: 3,
              thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 7),
              overlayShape: const RoundSliderOverlayShape(overlayRadius: 12),
            ),
            child: Slider(
              value: fillRatio,
              min: 0.0,
              max: 1.0,
              divisions: 20,
              onChanged: onPreviewFillRatio,
              onChangeEnd: onCommitFillRatio,
            ),
          ),
          Row(
            children: [
              quickPresetBtn('50% 均衡', 0.5),
              const SizedBox(width: 6),
              quickPresetBtn('80% 避挖孔', 0.8),
              const SizedBox(width: 6),
              quickPresetBtn('100% 全满', 1.0),
            ],
          ),
        ],
      ],
    );
  }

  Widget _buildDrawerVideoTab(BuildContext context) {
    final presets = ScenePreset.values;
    final rows = <Widget>[];
    for (var i = 0; i < presets.length; i += 2) {
      final left = presets[i];
      final right = i + 1 < presets.length ? presets[i + 1] : null;
      Widget presetTile(ScenePreset p) {
        final selected = preset == p;
        return Expanded(
          child: InkWell(
            borderRadius: BorderRadius.circular(10),
            onTap: () => onApplyPreset(p),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
              decoration: BoxDecoration(
                color: selected ? const Color(0xFF1E3A8A) : const Color(0xFF141D2B),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(
                  color: selected ? const Color(0xFF60A5FA) : const Color(0xFF263346),
                ),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    p.label,
                    style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: Colors.white),
                  ),
                  const SizedBox(height: 1),
                  Text(
                    _shortPresetSpec(p),
                    style: const TextStyle(fontSize: 10, color: Color(0xFF94A3B8)),
                  ),
                ],
              ),
            ),
          ),
        );
      }

      rows.add(
        Padding(
          padding: const EdgeInsets.only(bottom: 6),
          child: Row(
            children: [
              presetTile(left),
              const SizedBox(width: 6),
              if (right != null) presetTile(right) else const Spacer(),
            ],
          ),
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('画质与流量预设', style: TextStyle(fontSize: 11.5, color: Color(0xFF94A3B8))),
        const SizedBox(height: 6),
        ...rows,
        const SizedBox(height: 6),
        _buildResolutionAdapterSection(context),
        if (session.displays.length > 1) ...[
          const SizedBox(height: 8),
          const Text('切换电脑显示器', style: TextStyle(fontSize: 11.5, color: Color(0xFF94A3B8))),
          const SizedBox(height: 5),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: session.displays
                .map(
                  (d) => ChoiceChip(
                    label: Text(d.label, style: const TextStyle(fontSize: 11)),
                    selected: session.activeDisplayId == d.id,
                    onSelected: (_) => session.switchDisplay(d.id),
                  ),
                )
                .toList(),
          ),
        ],
      ],
    );
  }

  Widget _buildDrawerControlTab() {
    Widget modeCard(InputControlMode m, String desc) {
      final selected = inputMode == m;
      return Expanded(
        child: InkWell(
          borderRadius: BorderRadius.circular(10),
          onTap: () => onChangeInputMode(m),
          child: Container(
            padding: const EdgeInsets.all(9),
            decoration: BoxDecoration(
              color: selected ? const Color(0xFF1E3A8A) : const Color(0xFF141D2B),
              borderRadius: BorderRadius.circular(10),
              border: Border.all(
                color: selected ? const Color(0xFF60A5FA) : const Color(0xFF263346),
              ),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  m.label,
                  style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: Colors.white),
                ),
                const SizedBox(height: 2),
                Text(desc, style: const TextStyle(fontSize: 10, color: Color(0xFF94A3B8))),
              ],
            ),
          ),
        ),
      );
    }

    final hints = [('auto', '自动硬编'), ('detail', '锐利硬编'), ('motion', '低延迟')];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('触控操作方式', style: TextStyle(fontSize: 11.5, color: Color(0xFF94A3B8))),
        const SizedBox(height: 6),
        Row(
          children: [
            modeCard(InputControlMode.direct, '指哪点哪 · 长按右键'),
            const SizedBox(width: 6),
            modeCard(InputControlMode.touchpad, '双指滚轮 · 相对移动'),
          ],
        ),
        const SizedBox(height: 10),
        const Text('PC 编码策略', style: TextStyle(fontSize: 11.5, color: Color(0xFF94A3B8))),
        const SizedBox(height: 6),
        Row(
          children: hints.map((pair) {
            final selected = contentHint == pair.$1;
            return Expanded(
              child: Padding(
                padding: EdgeInsets.only(right: pair == hints.last ? 0 : 6),
                child: InkWell(
                  borderRadius: BorderRadius.circular(8),
                  onTap: () => onChangeContentHint(pair.$1),
                  child: Container(
                    padding: const EdgeInsets.symmetric(vertical: 7),
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: selected ? const Color(0xFF1E3A8A) : const Color(0xFF141D2B),
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(
                        color: selected ? const Color(0xFF60A5FA) : const Color(0xFF263346),
                      ),
                    ),
                    child: Text(
                      pair.$2,
                      style: TextStyle(
                        fontSize: 11,
                        fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
                        color: Colors.white,
                      ),
                    ),
                  ),
                ),
              ),
            );
          }).toList(),
        ),
        const SizedBox(height: 10),
        const Text('快捷输入与剪贴板', style: TextStyle(fontSize: 11.5, color: Color(0xFF94A3B8))),
        const SizedBox(height: 6),
        SizedBox(
          width: double.infinity,
          child: OutlinedButton.icon(
            onPressed: onToggleVkb,
            icon: const Icon(Icons.keyboard_rounded, size: 16),
            label: Text(showVkb ? '隐藏虚拟键盘' : '打开虚拟键盘 / 中文输入'),
          ),
        ),
        const SizedBox(height: 6),
        Row(
          children: [
            Expanded(
              child: OutlinedButton(
                onPressed: onPullClipboard,
                child: const Text('拉电脑剪贴板', style: TextStyle(fontSize: 11.5)),
              ),
            ),
            const SizedBox(width: 6),
            Expanded(
              child: OutlinedButton(
                onPressed: onPushClipboard,
                child: const Text('发手机剪贴板', style: TextStyle(fontSize: 11.5)),
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        const Text('视频编码格式偏好（重连后生效）', style: TextStyle(fontSize: 11.5, color: Color(0xFF94A3B8))),
        const SizedBox(height: 6),
        Row(
          children: [
            Expanded(
              child: InkWell(
                borderRadius: BorderRadius.circular(8),
                onTap: () => onChangePreferHevc(false),
                child: Container(
                  padding: const EdgeInsets.symmetric(vertical: 7),
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: !preferHevc ? const Color(0xFF1E3A8A) : const Color(0xFF141D2B),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(
                      color: !preferHevc ? const Color(0xFF60A5FA) : const Color(0xFF263346),
                    ),
                  ),
                  child: Text(
                    'H.264 通用硬解',
                    style: TextStyle(
                      fontSize: 11,
                      fontWeight: !preferHevc ? FontWeight.w600 : FontWeight.w400,
                      color: Colors.white,
                    ),
                  ),
                ),
              ),
            ),
            const SizedBox(width: 6),
            Expanded(
              child: InkWell(
                borderRadius: BorderRadius.circular(8),
                onTap: () => onChangePreferHevc(true),
                child: Container(
                  padding: const EdgeInsets.symmetric(vertical: 7),
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: preferHevc ? const Color(0xFF1E3A8A) : const Color(0xFF141D2B),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(
                      color: preferHevc ? const Color(0xFF60A5FA) : const Color(0xFF263346),
                    ),
                  ),
                  child: Text(
                    'H.265 (HEVC)',
                    style: TextStyle(
                      fontSize: 11,
                      fontWeight: preferHevc ? FontWeight.w600 : FontWeight.w400,
                      color: Colors.white,
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 8),
        SwitchListTile.adaptive(
          contentPadding: EdgeInsets.zero,
          dense: true,
          title: const Text(
            '外接鼠标无限边界捕获 (Pointer Capture)',
            style: TextStyle(fontSize: 11.5, color: Color(0xFFE2E8F0)),
          ),
          subtitle: const Text(
            '外接实体鼠标全屏零边界相对移动；打开抽屉或键盘时自动暂释',
            style: TextStyle(fontSize: 10, color: Color(0xFF94A3B8)),
          ),
          value: pointerCaptureEnabled,
          onChanged: onChangePointerCapture,
        ),
        SwitchListTile.adaptive(
          contentPadding: EdgeInsets.zero,
          dense: true,
          title: const Text(
            '切回前台自动同步剪贴板',
            style: TextStyle(fontSize: 11.5, color: Color(0xFFE2E8F0)),
          ),
          subtitle: const Text(
            '切回 App 且允许操控时，自动把手机新复制的文本发往电脑',
            style: TextStyle(fontSize: 10, color: Color(0xFF94A3B8)),
          ),
          value: autoSyncClipboard,
          onChanged: onChangeAutoClipboard,
        ),
      ],
    );
  }

  Widget _buildDrawerToolsTab() {
    Widget toolTile({
      required IconData icon,
      required String title,
      required String subtitle,
      required VoidCallback onTap,
      bool active = false,
    }) {
      return Expanded(
        child: InkWell(
          borderRadius: BorderRadius.circular(10),
          onTap: onTap,
          child: Container(
            padding: const EdgeInsets.all(9),
            decoration: BoxDecoration(
              color: active ? const Color(0xFF172554) : const Color(0xFF141D2B),
              borderRadius: BorderRadius.circular(10),
              border: Border.all(
                color: active ? const Color(0xFF60A5FA) : const Color(0xFF263346),
              ),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(icon, size: 17, color: active ? const Color(0xFF60A5FA) : const Color(0xFFCBD5E1)),
                const SizedBox(height: 4),
                Text(
                  title,
                  style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: Colors.white),
                ),
                Text(subtitle, style: const TextStyle(fontSize: 10, color: Color(0xFF94A3B8))),
              ],
            ),
          ),
        ),
      );
    }

    final hasAudio = session.hostAudioEnabled;
    final audioLabel = !hasAudio
        ? '点此一键开启'
        : (session.audioMuted ? '已静音 · 点此恢复' : '同步中 · 点此关闭');

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            toolTile(
              icon: (!hasAudio || session.audioMuted) ? Icons.volume_off : Icons.volume_up,
              title: '电脑声音',
              subtitle: audioLabel,
              active: hasAudio && !session.audioMuted,
              onTap: onToggleAudio,
            ),
            const SizedBox(width: 6),
            toolTile(
              icon: Icons.speed_rounded,
              title: '诊断 HUD',
              subtitle: showHud ? '已开启悬浮层' : '已隐藏',
              active: showHud,
              onTap: onToggleHud,
            ),
          ],
        ),
        const SizedBox(height: 6),
        Row(
          children: [
            toolTile(
              icon: Icons.picture_in_picture_alt_rounded,
              title: '画中画小窗',
              subtitle: '挂起悬浮看屏',
              onTap: onEnterPip,
            ),
            const SizedBox(width: 6),
            toolTile(
              icon: Icons.refresh_rounded,
              title: '重连会话',
              subtitle: '刷新视频链路',
              onTap: onReconnect,
            ),
          ],
        ),
        const SizedBox(height: 10),
        const Text('双向文件互传 (独立通道)', style: TextStyle(fontSize: 11.5, color: Color(0xFF94A3B8))),
        const SizedBox(height: 5),
        ListenableBuilder(
          listenable: session,
          builder: (_, _) {
            final ready = session.fileChannelReady;
            final active = session.activeFileTransfer;
            final history = session.recentTransfers;
            return Container(
              width: double.infinity,
              padding: const EdgeInsets.all(9),
              decoration: BoxDecoration(
                color: const Color(0x99070B11),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: const Color(0xFF243041)),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: double.infinity,
                    child: FilledButton.tonalIcon(
                      onPressed: (!ready || active != null) ? null : onPickAndSendFile,
                      icon: const Icon(Icons.upload_file_rounded, size: 16),
                      label: Text(
                        ready ? '选择文件发送给电脑' : '文件通道等待就绪...',
                        style: const TextStyle(fontSize: 12),
                      ),
                    ),
                  ),
                  if (active != null) ...[
                    const SizedBox(height: 7),
                    Text(
                      '${active.isOutgoing ? "↑ 发送" : "↓ 接收"} ${active.name} (${_formatFileBytes(active.transferredBytes)} / ${_formatFileBytes(active.totalBytes)})',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 10.5, color: Color(0xFF93C5FD)),
                    ),
                    const SizedBox(height: 4),
                    LinearProgressIndicator(
                      value: active.progress,
                      minHeight: 4,
                      borderRadius: BorderRadius.circular(4),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      active.message,
                      style: const TextStyle(fontSize: 10, color: Color(0xFF94A3B8)),
                    ),
                  ] else if (history.isEmpty) ...[
                    const SizedBox(height: 5),
                    const Text(
                      '电脑发来的文件将自动保存至 Download/AirDesk',
                      style: TextStyle(fontSize: 10, color: Color(0xFF94A3B8)),
                    ),
                  ],
                  for (final item in history.take(3)) ...[
                    const SizedBox(height: 4),
                    Text(
                      '${item.state == FileTransferState.completed ? "✓" : "✕"} ${item.isOutgoing ? "发出" : "收到"} ${item.name}${item.savedPath != null ? " (${item.savedPath})" : ""}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 10,
                        color: item.state == FileTransferState.completed
                            ? const Color(0xFF34D399)
                            : const Color(0xFFF87171),
                      ),
                    ),
                  ],
                ],
              ),
            );
          },
        ),
        const SizedBox(height: 10),
        const Text('实时链路状态', style: TextStyle(fontSize: 11.5, color: Color(0xFF94A3B8))),
        const SizedBox(height: 5),
        ListenableBuilder(
          listenable: session,
          builder: (_, _) {
            final t = session.telemetry;
            final rttStr = t.rttMs != null ? '${t.rttMs}ms' : '--';
            final encHw = t.txHw == null ? '' : (t.txHw! ? '硬编' : '软编');
            final decHw = t.rxHw == null ? '' : (t.rxHw! ? '硬解' : '软解');
            return Container(
              width: double.infinity,
              padding: const EdgeInsets.all(9),
              decoration: BoxDecoration(
                color: const Color(0x99070B11),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: const Color(0xFF243041)),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '编码 ${t.txW ?? "--"}×${t.txH ?? "--"} @ ${t.txFps ?? "--"}fps · $encHw ${t.encodeMs ?? "--"}ms · RTT $rttStr',
                    style: const TextStyle(fontSize: 10.5, fontFamily: 'monospace', color: Color(0xFF34D399)),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    '解码 ${t.rxFps ?? "--"}fps · $decHw ${t.decodeMs ?? "--"}ms · 缓冲 ${t.jbMs ?? "--"}ms · 掉帧 ${t.dropped ?? 0}',
                    style: const TextStyle(fontSize: 10.5, fontFamily: 'monospace', color: Color(0xFF93C5FD)),
                  ),
                ],
              ),
            );
          },
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final tabLabels = ['画面', '操控', '工具'];
    final ctrlEnabled = session.controlEnabled;
    final hasAudio = session.hostAudioEnabled && !session.audioMuted;

    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(
        color: const Color(0xE20B111A),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFF334155)),
        boxShadow: const [BoxShadow(color: Colors.black87, blurRadius: 20)],
      ),
      child: Column(
        children: [
          Row(
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                decoration: BoxDecoration(
                  color: ctrlEnabled ? const Color(0x2234D399) : const Color(0x22FBBF24),
                  borderRadius: BorderRadius.circular(99),
                  border: Border.all(
                    color: ctrlEnabled ? const Color(0xFF34D399) : const Color(0xFFFBBF24),
                  ),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Container(
                      width: 7,
                      height: 7,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: ctrlEnabled ? const Color(0xFF34D399) : const Color(0xFFFBBF24),
                      ),
                    ),
                    const SizedBox(width: 5),
                    Text(
                      ctrlEnabled ? '允许操控' : '仅观看',
                      style: TextStyle(
                        fontSize: 11.5,
                        fontWeight: FontWeight.w600,
                        color: ctrlEnabled ? const Color(0xFF34D399) : const Color(0xFFFBBF24),
                      ),
                    ),
                  ],
                ),
              ),
              const Spacer(),
              IconButton(
                tooltip: '声音开关',
                visualDensity: VisualDensity.compact,
                onPressed: onToggleAudio,
                icon: Icon(
                  hasAudio ? Icons.volume_up_rounded : Icons.volume_off_rounded,
                  size: 18,
                  color: hasAudio ? const Color(0xFF60A5FA) : const Color(0xFF94A3B8),
                ),
              ),
              IconButton(
                tooltip: '诊断 HUD',
                visualDensity: VisualDensity.compact,
                onPressed: onToggleHud,
                icon: Icon(
                  Icons.speed_rounded,
                  size: 18,
                  color: showHud ? const Color(0xFF34D399) : const Color(0xFF94A3B8),
                ),
              ),
              IconButton(
                tooltip: '收起',
                visualDensity: VisualDensity.compact,
                onPressed: onCloseDrawer,
                icon: const Icon(Icons.close_rounded, size: 18),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Container(
            padding: const EdgeInsets.all(3),
            decoration: BoxDecoration(
              color: const Color(0xFF070B11),
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: const Color(0xFF1E293B)),
            ),
            child: Row(
              children: List.generate(tabLabels.length, (i) {
                final selected = activeTab == i;
                return Expanded(
                  child: GestureDetector(
                    onTap: () => onTabChanged(i),
                    child: Container(
                      padding: const EdgeInsets.symmetric(vertical: 5),
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        color: selected ? const Color(0xFF2563EB) : Colors.transparent,
                        borderRadius: BorderRadius.circular(7),
                      ),
                      child: Text(
                        tabLabels[i],
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
                          color: selected ? Colors.white : const Color(0xFF94A3B8),
                        ),
                      ),
                    ),
                  ),
                );
              }),
            ),
          ),
          const SizedBox(height: 8),
          Expanded(
            child: SingleChildScrollView(
              child: switch (activeTab) {
                0 => _buildDrawerVideoTab(context),
                1 => _buildDrawerControlTab(),
                _ => _buildDrawerToolsTab(),
              },
            ),
          ),
          const SizedBox(height: 8),
          SizedBox(
            width: double.infinity,
            height: 36,
            child: FilledButton.icon(
              style: FilledButton.styleFrom(
                backgroundColor: const Color(0xFFDC2626),
                padding: const EdgeInsets.symmetric(horizontal: 12),
              ),
              onPressed: onExitStage,
              icon: const Icon(Icons.power_settings_new_rounded, size: 16),
              label: const Text('断开连接并返回', style: TextStyle(fontSize: 12.5)),
            ),
          ),
        ],
      ),
    );
  }
}
