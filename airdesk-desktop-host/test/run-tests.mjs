import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isLanLikeConnection,
  computeTieredVideoBitrates,
  scoreH264Fmtp,
  sortPreferredVideoCodecs,
  boostVideoSdpBitrate,
  enhanceAudioOpusSdp,
  sdpPrefersHevc,
  ensurePlayoutDelayExtInSdp,
  parseIceServerInput,
  PLAYOUT_DELAY_EXT_URI,
} from '../renderer/modules/sdp-codec.mjs';
import {
  computeAbrFloorKbps,
  createAbrController,
} from '../renderer/modules/abr-controller.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

function collectFiles(dir, ext) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(full, ext));
    } else if (entry.isFile() && entry.name.endsWith(ext)) {
      results.push(full);
    }
  }
  return results;
}

// 1. Syntax checks across all Electron CJS, Renderer ESM, and test scripts
const cjsFiles = collectFiles(path.join(rootDir, 'electron'), '.cjs');
assert.ok(cjsFiles.length >= 7, 'Expected at least 7 .cjs files under electron/');
for (const file of cjsFiles) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}

const mjsFiles = [
  ...collectFiles(path.join(rootDir, 'renderer', 'modules'), '.mjs'),
  ...collectFiles(path.join(rootDir, 'test'), '.mjs'),
];
assert.ok(mjsFiles.length >= 5, 'Expected at least 5 .mjs files across renderer/modules and test/');
for (const file of mjsFiles) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}

const hostJsPath = path.join(rootDir, 'renderer', 'host.js');
execFileSync(process.execPath, ['--input-type=module', '--check'], {
  input: fs.readFileSync(hostJsPath),
  stdio: ['pipe', 'inherit', 'inherit'],
});

// 2. Unit tests: SDP & codec utilities (sdp-codec.mjs)
{
  assert.equal(scoreH264Fmtp('level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c1f'), 0);
  assert.equal(scoreH264Fmtp('profile-level-id=42e01f'), 1);
  assert.equal(scoreH264Fmtp('profile-level-id=42e01e'), 2);
  assert.equal(scoreH264Fmtp('profile-level-id=42001f'), 3);
  assert.equal(scoreH264Fmtp('profile-level-id=42001e'), 4);
  assert.equal(scoreH264Fmtp('profile-level-id=64001f'), 5);
  assert.equal(scoreH264Fmtp(''), 6);

  const sampleCodecs = [
    { mimeType: 'video/VP8', sdpFmtpLine: '' },
    { mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=42001f' },
    { mimeType: 'video/H265', sdpFmtpLine: '' },
    { mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=640c1f' },
    { mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=42e01f' },
  ];
  const h264First = sortPreferredVideoCodecs(sampleCodecs, false);
  assert.deepEqual(
    h264First.map((c) => `${c.mimeType}:${c.sdpFmtpLine}`),
    [
      'video/H264:profile-level-id=640c1f',
      'video/H264:profile-level-id=42e01f',
      'video/H264:profile-level-id=42001f',
      'video/H265:',
    ]
  );
  const hevcFirst = sortPreferredVideoCodecs(sampleCodecs, true);
  assert.equal(hevcFirst[0].mimeType, 'video/H265');
  assert.equal(hevcFirst[1].sdpFmtpLine, 'profile-level-id=640c1f');

  assert.equal(isLanLikeConnection({ isRelay: false, lanNoStun: true, activePeerIsOverlay: false }), true);
  assert.equal(isLanLikeConnection({ isRelay: true, lanNoStun: true, activePeerIsOverlay: false }), false);
  assert.equal(isLanLikeConnection({ isRelay: false, lanNoStun: true, activePeerIsOverlay: true }), false);

  assert.deepEqual(
    computeTieredVideoBitrates({ isRelay: false, lanNoStun: true, activePeerIsOverlay: false, fps: 30, resolution: '1080p' }),
    { minKbps: 2000, startKbps: 6000, maxKbps: 12000 }
  );
  assert.deepEqual(
    computeTieredVideoBitrates({ isRelay: false, lanNoStun: true, activePeerIsOverlay: false, fps: 60, resolution: 'native' }),
    { minKbps: 2000, startKbps: 8000, maxKbps: 24000 }
  );
  assert.deepEqual(
    computeTieredVideoBitrates({ isRelay: true, lanNoStun: false, activePeerIsOverlay: false, fps: 30, resolution: '1080p' }),
    { minKbps: 600, startKbps: 2500, maxKbps: 6000 }
  );

  const rawSdp = [
    'v=0',
    'm=video 9 UDP/TLS/RTP/SAVPF 96 97',
    'c=IN IP4 0.0.0.0',
    'a=rtpmap:96 H264/90000',
    'a=fmtp:96 level-asymmetry-allowed=1;profile-level-id=640c1f',
    'a=rtpmap:97 rtx/90000',
    'a=fmtp:97 apt=96',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'a=rtpmap:111 opus/48000/2',
    'a=fmtp:111 minptime=10;useinbandfec=1',
  ].join('\r\n');

  const boosted = boostVideoSdpBitrate(rawSdp, 2000, 6000, 12000);
  assert.ok(boosted.includes('b=AS:12000'));
  assert.ok(boosted.includes('x-google-min-bitrate=2000;x-google-start-bitrate=6000;x-google-max-bitrate=12000'));
  assert.ok(!boosted.includes('apt=96;x-google-min-bitrate'));

  const opusSdp = enhanceAudioOpusSdp(boosted);
  assert.ok(opusSdp.includes('a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=128000'));

  const extRes = ensurePlayoutDelayExtInSdp(opusSdp);
  assert.equal(extRes.extId, 1);
  assert.ok(extRes.sdp.includes(`a=extmap:1 ${PLAYOUT_DELAY_EXT_URI}`));
  const idempotent = ensurePlayoutDelayExtInSdp(extRes.sdp);
  assert.equal(idempotent.extId, 1);

  assert.equal(sdpPrefersHevc('m=video 9 UDP/TLS/RTP/SAVPF 98 96\r\na=rtpmap:98 H265/90000'), true);
  assert.equal(sdpPrefersHevc(rawSdp), false);

  assert.deepEqual(parseIceServerInput('stun:stun.example.com:3478, turn:u%3A1:p%402@turn.example.com:3478'), [
    { urls: 'stun:stun.example.com:3478' },
    { urls: 'turn:turn.example.com:3478', username: 'u:1', credential: 'p@2' },
  ]);
}

// 3. Unit tests: AIMD Adaptive Bitrate controller (abr-controller.mjs)
{
  assert.equal(computeAbrFloorKbps(true), 2500);
  assert.equal(computeAbrFloorKbps(false), 800);

  const abr = createAbrController();
  abr.reset({ baseMaxOverride: 12000, isLanLike: true });
  assert.equal(abr.state.currentTargetKbps, 12000);
  assert.equal(abr.state.minFloorKbps, 2500);
  assert.equal(abr.state.state, 'normal');

  // Idle throttled or secure desktop skips evaluation
  assert.equal(
    abr.evaluate({
      hasActivePeer: true,
      hasPc: true,
      hasVideoSender: true,
      isIdleThrottled: true,
      hostInSecureDesktop: false,
      isLanLike: true,
      captureMaxFps: 30,
      limitReason: 'bandwidth',
      encodeMs: 10,
      rttMs: 20,
      lastClientDiag: null,
      lastClientDiagAt: 0,
      nowMs: 10000,
    }),
    null
  );

  // First congested tick increments streak without stepping down
  const baseEval = {
    hasActivePeer: true,
    hasPc: true,
    hasVideoSender: true,
    isIdleThrottled: false,
    hostInSecureDesktop: false,
    isLanLike: true,
    captureMaxFps: 30,
    limitReason: 'bandwidth',
    encodeMs: 10,
    rttMs: 20,
    lastClientDiag: null,
    lastClientDiagAt: 0,
  };
  assert.equal(abr.evaluate({ ...baseEval, nowMs: 10000 }), null);
  assert.equal(abr.state.congestedStreak, 1);

  // Second consecutive congested tick steps down to 0.75x
  const stepDown = abr.evaluate({ ...baseEval, nowMs: 12000 });
  assert.deepEqual(stepDown, { action: 'step_down', targetKbps: 9000, fps: 30 });
  assert.equal(abr.state.state, 'throttled');

  // Cooldown debounce (< 4000ms) prevents immediate second drop even on freeze
  assert.equal(
    abr.evaluate({
      ...baseEval,
      lastClientDiag: { jbMs: 50, dropped: 4, freezes: 1 },
      lastClientDiagAt: 13500,
      nowMs: 14000,
    }),
    null
  );

  // Freeze after 4000ms cooldown triggers single-cycle step-down
  const freezeStep = abr.evaluate({
    ...baseEval,
    lastClientDiag: { jbMs: 50, dropped: 5, freezes: 2 },
    lastClientDiagAt: 16500,
    nowMs: 17000,
  });
  assert.deepEqual(freezeStep, { action: 'step_down', targetKbps: 6750, fps: 30 });

  // CPU bottleneck at 60fps caps adaptiveFpsCap at 30
  abr.evaluate({ ...baseEval, captureMaxFps: 60, limitReason: 'cpu', encodeMs: 25, nowMs: 22000 });
  const cpuStep = abr.evaluate({ ...baseEval, captureMaxFps: 60, limitReason: 'cpu', encodeMs: 25, nowMs: 24000 });
  assert.deepEqual(cpuStep, { action: 'step_down', targetKbps: 5063, fps: 30 });
  assert.equal(abr.state.adaptiveFpsCap, 30);

  // 4 healthy cycles after 6s cooldown lifts fps cap first, before ramping bitrate
  for (let i = 0; i < 3; i++) {
    assert.equal(
      abr.evaluate({
        ...baseEval,
        captureMaxFps: 60,
        limitReason: 'none',
        encodeMs: 8,
        rttMs: 15,
        nowMs: 31000 + i * 2000,
      }),
      null
    );
  }
  const restoreFps = abr.evaluate({
    ...baseEval,
    captureMaxFps: 60,
    limitReason: 'none',
    encodeMs: 8,
    rttMs: 15,
    nowMs: 37000,
  });
  assert.deepEqual(restoreFps, { action: 'ramp_up', targetKbps: 5063, fps: 60 });
  assert.equal(abr.state.adaptiveFpsCap, null);

  // Floor clamping for LAN (>= 2500 kbps)
  abr.reset({ baseMaxOverride: 3000, isLanLike: true });
  abr.evaluate({ ...baseEval, nowMs: 10000 });
  const clamped = abr.evaluate({ ...baseEval, nowMs: 12000 });
  assert.equal(clamped.targetKbps, 2500);
}

console.log(
  `[AirDesk Tests] Passed syntax checks (${cjsFiles.length} CJS, ${mjsFiles.length} MJS, host.js) + sdp-codec & abr-controller unit tests.`
);
