class SdpHelper {
  static const String playoutDelayExtUri =
      'http://www.webrtc.org/experiments/rtp-hdrext/playout-delay';

  static bool isVirtualCandidate(String candStr) {
    final parts = candStr.split(' ');
    if (parts.length < 5) return false;
    final addr = parts[4];
    if (RegExp(r'^198\.1[89]\.').hasMatch(addr)) return true;
    if (RegExp(r'^172\.19\.').hasMatch(addr)) return true;
    return false;
  }

  /// Reorders the m=video SDP payload types so H.265/HEVC (when [preferHevc] is enabled)
  /// or H.264 (preferring Constrained Baseline 42e01f > 42001f) is listed first,
  /// ensuring Android MediaCodec hardware decoding engages consistently.
  static String prioritizeVideoCodecs(String sdp, {bool preferHevc = false}) {
    if (sdp.isEmpty) return sdp;
    final eol = sdp.contains('\r\n') ? '\r\n' : '\n';
    final lines = sdp.split(RegExp(r'\r?\n'));
    var inVideo = false;
    var mLineIdx = -1;
    final Map<String, String> rtpmap = {};
    final Map<String, String> fmtp = {};
    final Map<String, String> rtxApt = {};

    for (var i = 0; i < lines.length; i++) {
      final line = lines[i];
      if (line.startsWith('m=')) {
        inVideo = line.startsWith('m=video ');
        if (inVideo) mLineIdx = i;
        continue;
      }
      if (!inVideo) continue;
      final rm = RegExp(r'^a=rtpmap:(\d+)\s+([^\s]+)').firstMatch(line);
      if (rm != null) {
        rtpmap[rm.group(1)!] = rm.group(2)!.toLowerCase();
        continue;
      }
      final fm = RegExp(r'^a=fmtp:(\d+)\s+(.+)$').firstMatch(line);
      if (fm != null) {
        final pt = fm.group(1)!;
        final val = fm.group(2)!.toLowerCase();
        fmtp[pt] = val;
        final aptMatch = RegExp(r'apt=(\d+)').firstMatch(val);
        if (aptMatch != null) {
          rtxApt[aptMatch.group(1)!] = pt;
        }
      }
    }

    if (mLineIdx < 0) return sdp;
    final parts = lines[mLineIdx].trim().split(RegExp(r'\s+'));
    if (parts.length <= 4) return sdp;
    final header = parts.take(3).toList();
    final pts = parts.skip(3).toList();

    final hevcPts = <String>[];
    final h264Pts = <String>[];
    final otherPts = <String>[];
    final associatedRtx = <String>{};

    for (final pt in pts) {
      final codec = rtpmap[pt] ?? '';
      if (codec.startsWith('h265/') || codec.startsWith('hevc/')) {
        hevcPts.add(pt);
        if (rtxApt.containsKey(pt)) associatedRtx.add(rtxApt[pt]!);
      } else if (codec.startsWith('h264/')) {
        h264Pts.add(pt);
        if (rtxApt.containsKey(pt)) associatedRtx.add(rtxApt[pt]!);
      }
    }
    if (h264Pts.isEmpty && (!preferHevc || hevcPts.isEmpty)) return sdp;

    int scorePt(String pt) {
      final f = fmtp[pt] ?? '';
      if (f.contains('640c')) return 0;
      if (f.contains('42e01f')) return 1;
      if (f.contains('42e0')) return 2;
      if (f.contains('42001f')) return 3;
      if (f.contains('4200')) return 4;
      if (f.contains('6400')) return 5;
      return 6;
    }

    h264Pts.sort((a, b) => scorePt(a).compareTo(scorePt(b)));

    final orderedHevcWithRtx = <String>[];
    if (preferHevc) {
      for (final pt in hevcPts) {
        orderedHevcWithRtx.add(pt);
        if (rtxApt.containsKey(pt)) orderedHevcWithRtx.add(rtxApt[pt]!);
      }
    }

    final orderedH264WithRtx = <String>[];
    for (final pt in h264Pts) {
      orderedH264WithRtx.add(pt);
      if (rtxApt.containsKey(pt)) orderedH264WithRtx.add(rtxApt[pt]!);
    }

    for (final pt in pts) {
      final isIncludedHevc = preferHevc && hevcPts.contains(pt);
      final isIncludedH264 = h264Pts.contains(pt);
      final isIncludedRtx = associatedRtx.contains(pt) &&
          (preferHevc || !hevcPts.any((hp) => rtxApt[hp] == pt));
      if (!isIncludedHevc && !isIncludedH264 && !isIncludedRtx) {
        otherPts.add(pt);
      }
    }

    lines[mLineIdx] = [
      ...header,
      ...orderedHevcWithRtx,
      ...orderedH264WithRtx,
      ...otherPts,
    ].join(' ');
    return ensurePlayoutDelayExt(lines.join(eol));
  }

  static String ensurePlayoutDelayExt(String sdp) {
    if (sdp.isEmpty) return sdp;
    final eol = sdp.contains('\r\n') ? '\r\n' : '\n';
    final lines = sdp.split(RegExp(r'\r?\n'));
    final usedIds = <int>{};
    var inVideo = false;
    var videoStartIdx = -1;
    var videoEndIdx = lines.length;
    var lastVideoExtIdx = -1;
    var firstVideoRtpmapIdx = -1;

    for (var i = 0; i < lines.length; i++) {
      final line = lines[i];
      final em = RegExp(r'^a=extmap:(\d+)(?:/[^\s]+)?\s+(\S+)', caseSensitive: false)
          .firstMatch(line);
      if (em != null) {
        final id = int.tryParse(em.group(1)!);
        if (id != null) usedIds.add(id);
        if (inVideo) {
          lastVideoExtIdx = i;
          if (em.group(2)!.toLowerCase() == playoutDelayExtUri) {
            return sdp;
          }
        }
        continue;
      }
      if (line.startsWith('m=')) {
        if (inVideo && videoEndIdx == lines.length) {
          videoEndIdx = i;
        }
        inVideo = line.startsWith('m=video ');
        if (inVideo) videoStartIdx = i;
        continue;
      }
      if (inVideo && firstVideoRtpmapIdx < 0 && line.startsWith('a=rtpmap:')) {
        firstVideoRtpmapIdx = i;
      }
    }

    if (videoStartIdx < 0) return sdp;
    int? chosenId;
    for (var id = 1; id <= 14; id++) {
      if (!usedIds.contains(id)) {
        chosenId = id;
        break;
      }
    }
    if (chosenId == null) return sdp;

    final insertAt = lastVideoExtIdx >= 0
        ? lastVideoExtIdx + 1
        : (firstVideoRtpmapIdx >= 0 ? firstVideoRtpmapIdx : videoEndIdx);
    lines.insert(insertAt, 'a=extmap:$chosenId $playoutDelayExtUri');
    return lines.join(eol);
  }
}
