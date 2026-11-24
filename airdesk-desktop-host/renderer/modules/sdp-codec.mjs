export const PLAYOUT_DELAY_EXT_URI = 'http://www.webrtc.org/experiments/rtp-hdrext/playout-delay';

export function isLanLikeConnection({ isRelay, lanNoStun, activePeerIsOverlay }) {
  return Boolean(lanNoStun) && !activePeerIsOverlay && !isRelay;
}

export function computeTieredVideoBitrates({
  isRelay,
  lanNoStun,
  activePeerIsOverlay,
  fps,
  resolution,
}) {
  const isLan = isLanLikeConnection({ isRelay, lanNoStun, activePeerIsOverlay });
  const res = resolution || '1080p';

  if (isRelay) {
    return { minKbps: 600, startKbps: 2500, maxKbps: fps >= 60 ? 8000 : 6000 };
  }
  if (activePeerIsOverlay) {
    return { minKbps: 800, startKbps: 4000, maxKbps: fps >= 60 ? 14000 : 10000 };
  }
  if (isLan) {
    let maxKbps;
    if (res === 'native') {
      maxKbps = fps >= 60 ? 24000 : 18000;
    } else if (res === '1080p') {
      maxKbps = fps >= 60 ? 22000 : 12000;
    } else if (res === '900p') {
      maxKbps = fps >= 60 ? 18000 : 10000;
    } else {
      maxKbps = fps >= 60 ? 14000 : 8000;
    }
    return { minKbps: 2000, startKbps: fps >= 60 ? 8000 : 6000, maxKbps };
  }
  return { minKbps: 1200, startKbps: 5000, maxKbps: fps >= 60 ? 16000 : 10000 };
}

export function scoreH264Fmtp(sdpFmtpLine) {
  const f = String(sdpFmtpLine || '').toLowerCase();
  if (f.includes('640c')) return 0;
  if (f.includes('42e01f')) return 1;
  if (f.includes('42e0')) return 2;
  if (f.includes('42001f')) return 3;
  if (f.includes('4200')) return 4;
  if (f.includes('6400')) return 5;
  return 6;
}

export function sortPreferredVideoCodecs(codecs, preferHevc = false) {
  const list = Array.isArray(codecs) ? codecs : [];
  const h264 = list
    .filter((c) => c && c.mimeType && c.mimeType.toLowerCase() === 'video/h264')
    .sort((a, b) => scoreH264Fmtp(a.sdpFmtpLine) - scoreH264Fmtp(b.sdpFmtpLine));
  const hevc = list.filter((c) => {
    if (!c || !c.mimeType) return false;
    const mt = c.mimeType.toLowerCase();
    return mt === 'video/hevc' || mt === 'video/h265';
  });
  return preferHevc ? [...hevc, ...h264] : [...h264, ...hevc];
}

export function parseIceServerInput(raw) {
  const tokens = String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const token of tokens) {
    const schemeMatch = token.match(/^(turns?):(.*)$/i);
    if (schemeMatch) {
      const rest = schemeMatch[2];
      const atIdx = rest.lastIndexOf('@');
      if (atIdx > 0) {
        const creds = rest.slice(0, atIdx);
        const colonIdx = creds.indexOf(':');
        if (colonIdx > 0) {
          out.push({
            urls: schemeMatch[1].toLowerCase() + ':' + rest.slice(atIdx + 1),
            username: decodeURIComponent(creds.slice(0, colonIdx)),
            credential: decodeURIComponent(creds.slice(colonIdx + 1)),
          });
          continue;
        }
      }
    }
    out.push({ urls: token });
  }
  return out;
}

export function boostVideoSdpBitrate(sdp, minKbps = 1500, startKbps = 6000, maxKbps = 15000) {
  if (!sdp || typeof sdp !== 'string') return sdp;
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(/\r?\n/);

  let inVideo = false;
  let mLinePts = [];
  const skipPts = new Set();
  const existingFmtpPts = new Set();

  for (const line of lines) {
    if (line.startsWith('m=')) {
      inVideo = line.startsWith('m=video ');
      if (inVideo) {
        mLinePts = line.trim().split(/\s+/).slice(3);
      }
      continue;
    }
    if (!inVideo) continue;
    const rtpmapMatch = line.match(/^a=rtpmap:(\d+)\s+([^/\s]+)/i);
    if (rtpmapMatch) {
      const pt = rtpmapMatch[1];
      const codec = rtpmapMatch[2].toLowerCase();
      if (codec === 'rtx' || codec === 'red' || codec === 'ulpfec' || codec === 'flexfec-03') {
        skipPts.add(pt);
      }
      continue;
    }
    const fmtpMatch = line.match(/^a=fmtp:(\d+)\s+/i);
    if (fmtpMatch) {
      existingFmtpPts.add(fmtpMatch[1]);
    }
  }

  const targetPts = new Set(mLinePts.filter((pt) => !skipPts.has(pt)));
  if (targetPts.size === 0) return sdp;

  const bitrateParams =
    'x-google-min-bitrate=' +
    minKbps +
    ';x-google-start-bitrate=' +
    startKbps +
    ';x-google-max-bitrate=' +
    maxKbps;

  inVideo = false;
  let videoBInjected = false;
  const out = [];

  for (const line of lines) {
    if (line.startsWith('m=')) {
      inVideo = line.startsWith('m=video ');
      out.push(line);
      continue;
    }
    if (!inVideo) {
      out.push(line);
      continue;
    }
    if (/^b=(AS|TIAS):/i.test(line)) {
      continue;
    }
    if (line.startsWith('c=IN ')) {
      out.push(line);
      if (!videoBInjected) {
        out.push('b=AS:' + maxKbps);
        videoBInjected = true;
      }
      continue;
    }
    const fmtpMatch = line.match(/^a=fmtp:(\d+)\s+(.*)$/i);
    if (fmtpMatch && targetPts.has(fmtpMatch[1])) {
      const pt = fmtpMatch[1];
      const cleaned = fmtpMatch[2]
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s && !/^x-google-(min|start|max)-bitrate=/i.test(s));
      cleaned.push(bitrateParams);
      out.push('a=fmtp:' + pt + ' ' + cleaned.join(';'));
      continue;
    }
    out.push(line);
    const rtpmapMatch = line.match(/^a=rtpmap:(\d+)\s+/i);
    if (rtpmapMatch && targetPts.has(rtpmapMatch[1]) && !existingFmtpPts.has(rtpmapMatch[1])) {
      out.push('a=fmtp:' + rtpmapMatch[1] + ' ' + bitrateParams);
    }
  }

  if (!videoBInjected) {
    const mIdx = out.findIndex((l) => l.startsWith('m=video '));
    if (mIdx >= 0) {
      out.splice(mIdx + 1, 0, 'b=AS:' + maxKbps);
    }
  }

  return out.join(eol);
}

export function enhanceAudioOpusSdp(sdp) {
  if (!sdp || typeof sdp !== 'string') return sdp;
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(/\r?\n/);

  let inAudio = false;
  const opusPts = new Set();
  const existingFmtpPts = new Set();

  for (const line of lines) {
    if (line.startsWith('m=')) {
      inAudio = line.startsWith('m=audio ');
      continue;
    }
    if (!inAudio) continue;
    const rm = line.match(/^a=rtpmap:(\d+)\s+opus\//i);
    if (rm) {
      opusPts.add(rm[1]);
      continue;
    }
    const fm = line.match(/^a=fmtp:(\d+)\s+/i);
    if (fm) {
      existingFmtpPts.add(fm[1]);
    }
  }

  if (opusPts.size === 0) return sdp;

  const stereoParams = 'stereo=1;sprop-stereo=1;maxaveragebitrate=128000';
  inAudio = false;
  const out = [];

  for (const line of lines) {
    if (line.startsWith('m=')) {
      inAudio = line.startsWith('m=audio ');
      out.push(line);
      continue;
    }
    if (!inAudio) {
      out.push(line);
      continue;
    }
    const fm = line.match(/^a=fmtp:(\d+)\s+(.*)$/i);
    if (fm && opusPts.has(fm[1])) {
      const pt = fm[1];
      const cleaned = fm[2]
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s && !/^(stereo|sprop-stereo|maxaveragebitrate)=/i.test(s));
      cleaned.push(stereoParams);
      out.push('a=fmtp:' + pt + ' ' + cleaned.join(';'));
      continue;
    }
    out.push(line);
    const rm = line.match(/^a=rtpmap:(\d+)\s+opus\//i);
    if (rm && opusPts.has(rm[1]) && !existingFmtpPts.has(rm[1])) {
      out.push('a=fmtp:' + rm[1] + ' ' + stereoParams);
    }
  }

  return out.join(eol);
}

export function sdpPrefersHevc(sdp) {
  if (!sdp || typeof sdp !== 'string') return false;
  const lines = sdp.split(/\r?\n/);
  let inVideo = false;
  let firstPt = '';
  for (const line of lines) {
    if (line.startsWith('m=')) {
      inVideo = line.startsWith('m=video ');
      if (inVideo) {
        const parts = line.trim().split(/\s+/);
        firstPt = parts[3] || '';
      }
      continue;
    }
    if (!inVideo || !firstPt) continue;
    const m = line.match(new RegExp('^a=rtpmap:' + firstPt + '\\s+([^/\\s]+)', 'i'));
    if (m) {
      const codec = m[1].toLowerCase();
      return codec === 'h265' || codec === 'hevc';
    }
  }
  return false;
}

export function ensurePlayoutDelayExtInSdp(sdp, preferredId = null) {
  if (!sdp || typeof sdp !== 'string') return { sdp, extId: null };
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(/\r?\n/);

  const usedIds = new Set();
  let inVideo = false;
  let videoStartIdx = -1;
  let videoEndIdx = lines.length;
  let lastVideoExtIdx = -1;
  let firstVideoRtpmapIdx = -1;
  let existingExtId = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const em = line.match(/^a=extmap:(\d+)(?:\/[^\s]+)?\s+(\S+)/i);
    if (em) {
      const id = Number(em[1]);
      if (Number.isInteger(id)) usedIds.add(id);
      if (inVideo) {
        lastVideoExtIdx = i;
        if (em[2].toLowerCase() === PLAYOUT_DELAY_EXT_URI) {
          existingExtId = id;
        }
      }
      continue;
    }
    if (line.startsWith('m=')) {
      if (inVideo && videoEndIdx === lines.length) {
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

  if (videoStartIdx < 0) return { sdp, extId: null };
  if (existingExtId !== null) return { sdp, extId: existingExtId };

  let chosenId = null;
  if (Number.isInteger(preferredId) && preferredId >= 1 && preferredId <= 14 && !usedIds.has(preferredId)) {
    chosenId = preferredId;
  } else {
    for (let id = 1; id <= 14; id++) {
      if (!usedIds.has(id)) {
        chosenId = id;
        break;
      }
    }
  }
  if (chosenId === null) return { sdp, extId: null };

  const extLine = 'a=extmap:' + chosenId + ' ' + PLAYOUT_DELAY_EXT_URI;
  const insertAt =
    lastVideoExtIdx >= 0
      ? lastVideoExtIdx + 1
      : firstVideoRtpmapIdx >= 0
        ? firstVideoRtpmapIdx
        : videoEndIdx;
  lines.splice(insertAt, 0, extLine);
  return { sdp: lines.join(eol), extId: chosenId };
}
