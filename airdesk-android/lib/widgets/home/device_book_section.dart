// ignore: deprecated_member_use
import 'package:flutter/material.dart';
import '../../models/airdesk_models.dart';

class DeviceBookSection extends StatelessWidget {
  final List<SavedHostProfile> profiles;
  final List<AirDeskHostInfo> discoveredHosts;
  final Map<String, RelayHostProbeStatus> relayProbeStatus;
  final Map<String, bool> profileHasToken;
  final bool busy;
  final bool scanning;
  final VoidCallback onRefresh;
  final ValueChanged<SavedHostProfile> onConnect;
  final ValueChanged<SavedHostProfile> onDelete;
  final void Function(AirDeskHostInfo lanHost)? onQuickFile;

  const DeviceBookSection({
    super.key,
    required this.profiles,
    required this.discoveredHosts,
    required this.relayProbeStatus,
    required this.profileHasToken,
    required this.busy,
    required this.scanning,
    required this.onRefresh,
    required this.onConnect,
    required this.onDelete,
    this.onQuickFile,
  });

  AirDeskHostInfo? _findUsbHost(String hostId) {
    for (final h in discoveredHosts) {
      if (h.isUsb && h.hostId == hostId) return h;
    }
    return null;
  }

  AirDeskHostInfo? _findLanHost(String hostId) {
    for (final h in discoveredHosts) {
      if (!h.isUsb && h.hostId == hostId) return h;
    }
    return null;
  }

  Color _badgeColor(SmartRouteChannel channel, bool isBusy) {
    switch (channel) {
      case SmartRouteChannel.usb:
        return const Color(0xFF10B981);
      case SmartRouteChannel.lan:
        return const Color(0xFF34D399);
      case SmartRouteChannel.relay:
        return isBusy ? const Color(0xFFFBBF24) : const Color(0xFF60A5FA);
      case SmartRouteChannel.offline:
        return const Color(0xFF64748B);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (profiles.isEmpty) return const SizedBox.shrink();
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
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
              const Icon(Icons.devices_rounded, size: 16, color: Color(0xFF60A5FA)),
              const SizedBox(width: 6),
              const Expanded(
                child: Text(
                  '我的电脑设备簿 · 智能择优直连',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 13.5,
                    fontWeight: FontWeight.w600,
                    color: Color(0xFFE2E8F0),
                  ),
                ),
              ),
              IconButton(
                tooltip: '刷新设备在线状态',
                constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
                padding: EdgeInsets.zero,
                visualDensity: VisualDensity.compact,
                onPressed: scanning ? null : onRefresh,
                icon: scanning
                    ? const SizedBox(
                        width: 15,
                        height: 15,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.refresh_rounded, size: 18),
              ),
            ],
          ),
          const SizedBox(height: 4),
          for (final profile in profiles) _buildProfileTile(profile),
        ],
      ),
    );
  }

  Widget _buildProfileTile(SavedHostProfile profile) {
    final usb = _findUsbHost(profile.hostId);
    final lan = _findLanHost(profile.hostId);
    final relay = relayProbeStatus[profile.hostId];
    final route = resolveSmartRoutePriority(
      profile: profile,
      discoveredUsb: usb,
      discoveredLan: lan,
      relayStatus: relay,
    );
    final badgeColor = _badgeColor(route.channel, route.isBusy);
    final hasToken = profileHasToken[profile.hostId] == true;
    final quickFileTarget = usb ?? lan;
    final endpointParts = <String>[];
    if (lan != null) {
      endpointParts.add('LAN ${lan.ip}:${lan.port}');
    } else if (profile.lastLanIp.isNotEmpty) {
      endpointParts.add('上次局域网 ${profile.lastLanIp}');
    }
    if (profile.relayUrl.isNotEmpty) {
      endpointParts.add('Relay ${profile.relayUrl}');
    }

    return Container(
      margin: const EdgeInsets.only(top: 8),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: const Color(0xFF090E16),
        borderRadius: BorderRadius.circular(11),
        border: Border.all(
          color: route.isOnline ? const Color(0xFF1D4ED8) : const Color(0xFF1F2C3F),
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
              color: badgeColor,
            ),
          ),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Flexible(
                      child: Text(
                        profile.hostLabel.isNotEmpty ? profile.hostLabel : profile.hostId,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13.5),
                      ),
                    ),
                    const SizedBox(width: 6),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1.5),
                      decoration: BoxDecoration(
                        color: const Color(0xFF141E30),
                        borderRadius: BorderRadius.circular(6),
                        border: Border.all(color: badgeColor),
                      ),
                      child: Text(
                        route.badgeText,
                        style: TextStyle(
                          fontSize: 10,
                          fontWeight: FontWeight.w600,
                          color: badgeColor,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 3),
                Text(
                  'ID: ${profile.hostId}${endpointParts.isNotEmpty ? " · ${endpointParts.join(" · ")}" : ""}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 11,
                    color: Color(0xFF94A3B8),
                    fontFamily: 'monospace',
                  ),
                ),
              ],
            ),
          ),
          if (quickFileTarget != null && onQuickFile != null)
            IconButton(
              tooltip: '局域网快传',
              constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
              padding: EdgeInsets.zero,
              visualDensity: VisualDensity.compact,
              onPressed: busy ? null : () => onQuickFile!(quickFileTarget),
              icon: const Icon(Icons.swap_horiz_rounded, size: 18, color: Color(0xFF60A5FA)),
            ),
          IconButton(
            tooltip: '移出设备簿',
            constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
            padding: EdgeInsets.zero,
            visualDensity: VisualDensity.compact,
            onPressed: busy ? null : () => onDelete(profile),
            icon: const Icon(Icons.delete_outline_rounded, size: 17, color: Color(0xFF94A3B8)),
          ),
          const SizedBox(width: 4),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: route.channel == SmartRouteChannel.usb || route.channel == SmartRouteChannel.lan
                  ? const Color(0xFF059669)
                  : (hasToken ? const Color(0xFF2563EB) : const Color(0xFF1E293B)),
              padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 8),
              minimumSize: const Size(0, 34),
            ),
            onPressed: busy ? null : () => onConnect(profile),
            child: Text(
              route.channel == SmartRouteChannel.usb || route.channel == SmartRouteChannel.lan
                  ? '局域网直连'
                  : (hasToken ? '一键直连' : '连接'),
              style: const TextStyle(fontSize: 12),
            ),
          ),
        ],
      ),
    );
  }
}
