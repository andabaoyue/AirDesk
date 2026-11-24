import 'package:flutter/material.dart';

class StageSecureDesktopBanner extends StatelessWidget {
  final bool elevatedConnected;
  final bool controlEnabled;
  final VoidCallback onSendEsc;
  final VoidCallback onSendAltY;

  const StageSecureDesktopBanner({
    super.key,
    required this.elevatedConnected,
    required this.controlEnabled,
    required this.onSendEsc,
    required this.onSendAltY,
  });

  @override
  Widget build(BuildContext context) {
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 520),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: const Color(0xEB0F172A),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: const Color(0xCCF59E0B), width: 1.2),
          boxShadow: const [BoxShadow(color: Colors.black54, blurRadius: 12)],
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Row(
              children: [
                Icon(Icons.shield_outlined, color: Color(0xFFFBBF24), size: 18),
                SizedBox(width: 8),
                Expanded(
                  child: Text(
                    '电脑弹出管理员确认(UAC)或已锁屏，画面暂时冻结',
                    style: TextStyle(
                      color: Color(0xFFFEF3C7),
                      fontSize: 12.5,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 6),
            if (elevatedConnected && controlEnabled)
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  OutlinedButton(
                    style: OutlinedButton.styleFrom(
                      visualDensity: VisualDensity.compact,
                      side: const BorderSide(color: Color(0xFF64748B)),
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                    ),
                    onPressed: onSendEsc,
                    child: const Text('Esc 取消', style: TextStyle(fontSize: 12, color: Colors.white)),
                  ),
                  const SizedBox(width: 8),
                  FilledButton(
                    style: FilledButton.styleFrom(
                      backgroundColor: const Color(0xFF059669),
                      visualDensity: VisualDensity.compact,
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                    ),
                    onPressed: onSendAltY,
                    child: const Text('Alt+Y 允许', style: TextStyle(fontSize: 12)),
                  ),
                ],
              )
            else
              Text(
                elevatedConnected
                    ? '当前为只读模式，请在电脑端确认或按 Ctrl+Alt+L 开启操控'
                    : '请在电脑端确认，或安装提权服务 / 将 UAC 调至不降低桌面亮度档位',
                style: const TextStyle(color: Color(0xFFCBD5E1), fontSize: 11.5, height: 1.35),
              ),
          ],
        ),
      ),
    );
  }
}
