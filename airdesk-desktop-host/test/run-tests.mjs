import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const net = require('node:net');
const { WebSocket } = require('ws');
const { createTrustStore } = require('../electron/modules/trust-store.cjs');
const { createLanServerManager } = require('../electron/modules/lan-server.cjs');

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
import { createMediaCaptureManager } from '../renderer/modules/media-capture.mjs';

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

  // JitterBuffer hysteresis: >75ms triggers congestion, <=55ms allows recovery, 56..75ms holds steady
  abr.reset({ baseMaxOverride: 12000, isLanLike: true });
  const jbEval = { ...baseEval, limitReason: 'none', encodeMs: 8, rttMs: 15 };
  for (let i = 0; i < 3; i++) {
    assert.equal(
      abr.evaluate({
        ...jbEval,
        lastClientDiag: { jbMs: 65, dropped: 0, freezes: 0 },
        lastClientDiagAt: 9500 + i * 2000,
        nowMs: 10000 + i * 2000,
      }),
      null
    );
    assert.equal(abr.state.congestedStreak, 0);
    assert.equal(abr.state.healthyStreak, 0);
  }
  assert.equal(
    abr.evaluate({
      ...jbEval,
      lastClientDiag: { jbMs: 80, dropped: 0, freezes: 0 },
      lastClientDiagAt: 19500,
      nowMs: 20000,
    }),
    null
  );
  assert.equal(abr.state.congestedStreak, 1);
  const jbStepDown = abr.evaluate({
    ...jbEval,
    lastClientDiag: { jbMs: 80, dropped: 0, freezes: 0 },
    lastClientDiagAt: 21500,
    nowMs: 22000,
  });
  assert.deepEqual(jbStepDown, { action: 'step_down', targetKbps: 9000, fps: 30 });

  // 60ms JB (between 55 and 75) prevents ramp-up even over >=4 cycles
  for (let i = 0; i < 5; i++) {
    assert.equal(
      abr.evaluate({
        ...jbEval,
        lastClientDiag: { jbMs: 60, dropped: 0, freezes: 0 },
        lastClientDiagAt: 28500 + i * 2000,
        nowMs: 29000 + i * 2000,
      }),
      null
    );
    assert.equal(abr.state.healthyStreak, 0);
  }

  // <=55ms JB recovers after 4 healthy cycles
  for (let i = 0; i < 3; i++) {
    assert.equal(
      abr.evaluate({
        ...jbEval,
        lastClientDiag: { jbMs: 55, dropped: 0, freezes: 0 },
        lastClientDiagAt: 38500 + i * 2000,
        nowMs: 39000 + i * 2000,
      }),
      null
    );
  }
  const jbRampUp = abr.evaluate({
    ...jbEval,
    lastClientDiag: { jbMs: 55, dropped: 0, freezes: 0 },
    lastClientDiagAt: 44500,
    nowMs: 45000,
  });
  assert.deepEqual(jbRampUp, { action: 'ramp_up', targetKbps: 10350, fps: 30 });

  // Bandwidth bottleneck below 3500 kbps caps 60fps to 30fps; recovery restores fps before bitrate
  abr.reset({ baseMaxOverride: 4000, isLanLike: true });
  abr.evaluate({ ...baseEval, captureMaxFps: 60, limitReason: 'bandwidth', nowMs: 10000 });
  const bwFpsCap = abr.evaluate({
    ...baseEval,
    captureMaxFps: 60,
    limitReason: 'bandwidth',
    nowMs: 12000,
  });
  assert.deepEqual(bwFpsCap, { action: 'step_down', targetKbps: 3000, fps: 30 });
  assert.equal(abr.state.adaptiveFpsCap, 30);

  for (let i = 0; i < 3; i++) {
    assert.equal(
      abr.evaluate({
        ...jbEval,
        captureMaxFps: 60,
        lastClientDiag: { jbMs: 50, dropped: 0, freezes: 0 },
        lastClientDiagAt: 18500 + i * 2000,
        nowMs: 19000 + i * 2000,
      }),
      null
    );
  }
  const bwRestoreFps = abr.evaluate({
    ...jbEval,
    captureMaxFps: 60,
    lastClientDiag: { jbMs: 50, dropped: 0, freezes: 0 },
    lastClientDiagAt: 24500,
    nowMs: 25000,
  });
  assert.deepEqual(bwRestoreFps, { action: 'ramp_up', targetKbps: 3000, fps: 60 });
  assert.equal(abr.state.adaptiveFpsCap, null);

  for (let i = 0; i < 3; i++) {
    assert.equal(
      abr.evaluate({
        ...jbEval,
        captureMaxFps: 60,
        lastClientDiag: { jbMs: 50, dropped: 0, freezes: 0 },
        lastClientDiagAt: 31500 + i * 2000,
        nowMs: 32000 + i * 2000,
      }),
      null
    );
  }
  const bwRestoreKbps = abr.evaluate({
    ...jbEval,
    captureMaxFps: 60,
    lastClientDiag: { jbMs: 50, dropped: 0, freezes: 0 },
    lastClientDiagAt: 37500,
    nowMs: 38000,
  });
  assert.deepEqual(bwRestoreKbps, { action: 'ramp_up', targetKbps: 4000, fps: 60 });
  assert.equal(abr.state.state, 'normal');
}

// 4. Unit tests: Persistent Host Identity & Unified Trust Store (trust-store.cjs)
{
  const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'airdesk-trust-test-'));
  try {
    let changeNotifies = 0;
    const store1 = createTrustStore({
      userDataDir: tmpUserData,
      onTrustedDevicesChanged: () => {
        changeNotifies += 1;
      },
    });
    const id1 = store1.getOrCreateHostIdentity();
    assert.match(id1.hostId, /^[0-9a-z]{12}$/);
    assert.ok(id1.hostSecret.length >= 32);

    // Reloading from disk preserves exact same hostId & hostSecret
    const store2 = createTrustStore({ userDataDir: tmpUserData });
    const id2 = store2.getOrCreateHostIdentity();
    assert.deepEqual(id2, id1);

    // Backward compatibility: legacy 9-digit hostId persisted on disk is preserved as-is
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airdesk-legacy-id-'));
    try {
      fs.writeFileSync(
        path.join(legacyDir, 'host-identity.json'),
        JSON.stringify({
          hostId: '482910537',
          hostSecret: 'a'.repeat(64),
          createdAt: 1700000000000,
        }),
        'utf8'
      );
      const legacyStore = createTrustStore({ userDataDir: legacyDir });
      assert.equal(legacyStore.getOrCreateHostIdentity().hostId, '482910537');
    } finally {
      fs.rmSync(legacyDir, { recursive: true, force: true });
    }

    // Default TTL is 7d; can switch to 30d and never
    assert.equal(store1.getHostSettings().trustTtlOption, '7d');
    const issued7d = store1.issueToken({
      mode: 'full_control',
      deviceLabel: 'Xiaomi 13',
      platformHint: 'Android App',
      ipMasked: '1.2.3.4',
      source: 'relay',
    });
    assert.ok(issued7d.record.expiresAt > Date.now() + 6 * 24 * 60 * 60 * 1000);
    assert.equal(changeNotifies >= 1, true);

    store1.updateHostSettings({ trustTtlOption: 'never', autoStartOnBoot: true, autoHostOnStartup: true });
    assert.deepEqual(store1.getHostSettings(), {
      trustTtlOption: 'never',
      autoStartOnBoot: true,
      autoHostOnStartup: true,
    });
    const verifiedNever = store1.verifyAndTouchToken(issued7d.sessionToken, { ipMasked: '5.6.7.8' });
    assert.equal(verifiedNever.ok, true);
    assert.equal(verifiedNever.mode, 'full_control');
    assert.equal(verifiedNever.record.expiresAt, null);

    // Reload from disk preserves never-expiring token & settings
    const store3 = createTrustStore({ userDataDir: tmpUserData });
    assert.equal(store3.getHostSettings().trustTtlOption, 'never');
    const listed = store3.listTrustedDevices();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].source, 'relay');
    assert.equal(listed[0].expiresAt, null);
    assert.equal(listed[0].ipMasked, '5.6.7.8');

    // Mode update & single-token revocation
    assert.equal(store3.updateTokenMode(issued7d.sessionToken, 'view_only'), true);
    assert.equal(store3.verifyAndTouchToken(issued7d.sessionToken).mode, 'view_only');
    const revoked = store3.revokeToken(listed[0].tokenId);
    assert.equal(revoked.length, 1);
    assert.equal(store3.verifyAndTouchToken(issued7d.sessionToken).ok, false);
    assert.equal(store3.listTrustedDevices().length, 0);

    // 5. Unattended fixed access password: min length, scrypt challenge-response, single-use nonce & 5-attempt lockout
    assert.equal(store3.getUnattendedPasswordStatus().enabled, false);
    assert.equal(store3.createPasswordChallenge({ challengeId: 'c0' }).code, 'PASSWORD_DISABLED');
    assert.equal(store3.setUnattendedPassword('12345').ok, false);

    const testPw = 'AirDesk@2026!中文';
    assert.equal(store3.setUnattendedPassword(testPw).ok, true);
    assert.equal(store3.getUnattendedPasswordStatus().enabled, true);

    const chal1 = store3.createPasswordChallenge({ challengeId: 'c1', nowTs: 10000 });
    assert.equal(chal1.ok, true);
    assert.equal(chal1.kdf, 'scrypt');
    assert.ok(chal1.nonce.length >= 32);

    const dk = crypto.scryptSync(testPw, Buffer.from(chal1.salt, 'hex'), chal1.dkLen, {
      N: chal1.n,
      r: chal1.r,
      p: chal1.p,
    });
    const goodProof = crypto
      .createHmac('sha256', dk)
      .update(`airdesk-pw-v1:${id1.hostId}:c1:${chal1.nonce}`)
      .digest('hex');

    const okVerify = store3.verifyPasswordChallenge({
      challengeId: 'c1',
      proof: goodProof,
      deviceLabel: 'Test Phone',
      platformHint: 'Android App',
      ipMasked: '1.2.3.4',
      nowTs: 11000,
    });
    assert.equal(okVerify.ok, true);
    assert.equal(okVerify.mode, 'full_control');
    assert.ok(okVerify.sessionToken.length >= 16);

    // Replay of same challengeId/nonce must fail (single-use nonce)
    const replayVerify = store3.verifyPasswordChallenge({
      challengeId: 'c1',
      proof: goodProof,
      nowTs: 12000,
    });
    assert.equal(replayVerify.ok, false);
    assert.equal(replayVerify.code, 'CHALLENGE_EXPIRED');

    // Failed verification also consumes nonce and triggers 5-attempt lockout for 5 minutes
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const cid = `bad-${attempt}`;
      const ch = store3.createPasswordChallenge({ challengeId: cid, nowTs: 20000 + attempt * 100 });
      assert.equal(ch.ok, true);
      const res = store3.verifyPasswordChallenge({
        challengeId: cid,
        proof: '00'.repeat(32),
        nowTs: 20050 + attempt * 100,
      });
      assert.equal(res.ok, false);
      if (attempt < 5) {
        assert.equal(res.code, 'PASSWORD_INVALID');
        assert.equal(res.remainingAttempts, 5 - attempt);
      } else {
        assert.equal(res.code, 'PASSWORD_LOCKED');
      }
      // Same nonce cannot be reused even after failure
      const reuseBad = store3.verifyPasswordChallenge({
        challengeId: cid,
        proof: '00'.repeat(32),
        nowTs: 20060 + attempt * 100,
      });
      assert.equal(reuseBad.ok, false);
    }

    const lockedUntil = store3.getUnattendedPasswordStatus(21000).lockedUntilMs;
    assert.ok(lockedUntil > 21000);
    // Attempts during lockout must NOT extend lockedUntilMs
    const lockedChal = store3.createPasswordChallenge({ challengeId: 'c-locked', nowTs: 60000 });
    assert.equal(lockedChal.ok, false);
    assert.equal(lockedChal.code, 'PASSWORD_LOCKED');
    assert.equal(store3.getUnattendedPasswordStatus(60000).lockedUntilMs, lockedUntil);

    // Lockout persists across store reload and clears after 5 minutes
    const store4 = createTrustStore({ userDataDir: tmpUserData });
    assert.equal(store4.getUnattendedPasswordStatus(60000).locked, true);
    const unlockedAfter = store4.createPasswordChallenge({
      challengeId: 'c-after-lock',
      nowTs: lockedUntil + 1000,
    });
    assert.equal(unlockedAfter.ok, true);

    assert.equal(store4.clearUnattendedPassword().ok, true);
    assert.equal(store4.getUnattendedPasswordStatus().enabled, false);
  } finally {
    fs.rmSync(tmpUserData, { recursive: true, force: true });
  }
}

// 6. Unit tests: PR 0 idle capture release & power-saving guards
{
  const prevNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let displayVideoStops = 0;
  let audioStops = 0;
  let virtualAudioDisables = 0;
  let hasActivePeer = false;
  let hasPc = false;
  let isHosting = true;

  const makeTrack = (kind, onStop) => ({
    kind,
    readyState: 'live',
    enabled: true,
    muted: false,
    contentHint: '',
    stop() {
      this.readyState = 'ended';
      if (onStop) onStop();
    },
  });

  const makeStream = (tracks) => ({
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    removeTrack: () => {},
  });

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        async getUserMedia(constraints) {
          if (constraints && constraints.audio) {
            return makeStream([
              makeTrack('video'),
              makeTrack('audio', () => {
                audioStops += 1;
              }),
            ]);
          }
          return makeStream([
            makeTrack('video', () => {
              displayVideoStops += 1;
            }),
          ]);
        },
      },
    },
  });

  try {
    let statusText = '';
    const mgr = createMediaCaptureManager({
      getScreenSources: () => [{ id: 'screen:0:0', displayId: '1', name: 'Display 1' }],
      getSelectedDisplayId: () => '1',
      setSelectedDisplayId: () => {},
      getSelectedResolution: () => '1080p',
      getCaptureMaxFps: () => 30,
      getContentHintPref: () => 'auto',
      getAudioEnabled: () => true,
      setAudioEnabledState: () => {},
      getVirtualAudioInfo: () => null,
      getMuteHostVirtualAudio: () => false,
      getIsHosting: () => isHosting,
      getHasActivePeer: () => hasActivePeer,
      getHasPc: () => hasPc,
      getPcStats: async () => new Map(),
      getHostInSecureDesktop: () => false,
      getVideoSender: () => null,
      getAudioSender: () => null,
      getReliableDc: () => null,
      getWs: () => null,
      onAudioRenegotiatePreserveCtrl: () => {},
      applyVideoParameters: async () => {},
      getAbrTargetKbps: () => 6000,
      getAbrFpsCap: () => 30,
      getIsIdleThrottled: () => false,
      pushDisplaysListToClient: () => {},
      pushUiConfigToClient: () => {},
      showNotice: () => {},
      setStatusText: (t) => {
        statusText = t;
      },
      airdeskAPI: {
        setActiveDisplay: async () => ({ ok: true }),
        setVirtualAudioRoute: async (opts) => {
          if (opts && opts.enable === false) virtualAudioDisables += 1;
          return { ok: true };
        },
      },
    });

    await mgr.ensureLocalCaptureReady();
    assert.ok(mgr.getLocalStream() !== null);
    assert.ok(mgr.getLocalAudioTrack() !== null);

    // Must NOT release when cancelled before timer fires
    mgr.scheduleIdleCaptureRelease(20);
    mgr.cancelIdleCaptureRelease();
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(mgr.getLocalStream() !== null);
    assert.equal(displayVideoStops, 0);

    // Must NOT release if peer is active
    hasActivePeer = true;
    mgr.scheduleIdleCaptureRelease(20);
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(mgr.getLocalStream() !== null);
    assert.equal(displayVideoStops, 0);

    // Must release video + audio tracks and restore virtual audio when idle
    hasActivePeer = false;
    mgr.scheduleIdleCaptureRelease(20);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(mgr.getLocalStream(), null);
    assert.equal(mgr.getLocalAudioTrack(), null);
    assert.equal(displayVideoStops, 1);
    assert.ok(audioStops >= 1);
    assert.ok(virtualAudioDisables >= 1);
    assert.ok(statusText.includes('自动释放'));
  } finally {
    if (prevNavDesc) {
      Object.defineProperty(globalThis, 'navigator', prevNavDesc);
    } else {
      delete globalThis.navigator;
    }
  }

  // Structural guards: native helpers must gate hooks/polling on sys:session_state & main.cjs must gate throttling/watchdog
  const winHelperSrc = fs.readFileSync(path.join(rootDir, 'native', 'win-input-helper.cs'), 'utf8');
  assert.ok(winHelperSrc.includes('"sys:session_state"'));
  assert.ok(winHelperSrc.includes('SetSessionActive('));
  assert.ok(winHelperSrc.includes('SampleSecureDesktop()'));
  const helperStartSec = winHelperSrc.slice(
    winHelperSrc.indexOf('static void StartSecureDesktopMonitor()'),
    winHelperSrc.indexOf('while (!_secureDesktopStopping)')
  );
  assert.ok(helperStartSec.includes('SampleSecureDesktop()'));
  const helperMainSection = winHelperSrc.slice(winHelperSrc.indexOf('static void Main('));
  assert.equal(helperMainSection.includes('StartPhysicalMouseMonitor()'), false);
  assert.equal(helperMainSection.includes('StartSecureDesktopMonitor()'), false);

  const elevSrc = fs.readFileSync(path.join(rootDir, 'native', 'win-elevated-service.cs'), 'utf8');
  assert.ok(elevSrc.includes('"sys:session_state"'));
  assert.ok(elevSrc.includes('SetSessionActive('));
  assert.ok(elevSrc.includes('SampleSecureDesktop(out '));
  const elevStartSec = elevSrc.slice(
    elevSrc.indexOf('private static void StartSecureDesktopMonitor()'),
    elevSrc.indexOf('while (!_secureDesktopStopping)')
  );
  assert.ok(elevStartSec.includes('SampleSecureDesktop(out '));
  const elevRunSection = elevSrc.slice(elevSrc.indexOf('public static void Run('), elevSrc.indexOf('while (true)'));
  assert.equal(elevRunSection.includes('StartPhysicalMouseMonitor()'), false);
  assert.equal(elevRunSection.includes('StartSecureDesktopMonitor()'), false);

  const mainCjsSrc = fs.readFileSync(path.join(rootDir, 'electron', 'main.cjs'), 'utf8');
  assert.ok(mainCjsSrc.includes('setBackgroundThrottling('));
  assert.ok(mainCjsSrc.includes('startHeartbeatWatchdog'));
  assert.ok(mainCjsSrc.includes('stopHeartbeatWatchdog'));
  assert.ok(mainCjsSrc.includes("'airdesk:set-hosting-active'"));
}

// 7. Unit tests: PR 1 LAN zombie WS cleanup, hot audio replaceTrack, & host.js stability checks
{
  // 7a. LAN server zombie WS heartbeat cleanup
  const tmpLanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airdesk-lan-ws-test-'));
  const trustStore = createTrustStore({ userDataDir: tmpLanDir });
  const lanMgr = createLanServerManager({
    appVersion: '0.9.0',
    trustStore,
    getMainWindow: () => null,
    getHasActiveSession: () => false,
    getAuthoritativeControl: () => false,
    getAirDeskDownloadsDir: () => tmpLanDir,
    sanitizeFileName: (n) => n,
    allocateUniqueFilePath: (d, n) => ({ finalName: n, finalPath: path.join(d, n) }),
    maxFileTransferBytes: 1024 * 1024,
    buildEmbeddedMobileClientHtml: () => '<html></html>',
    wsPingIntervalMs: 35,
    wsStaleTimeoutMs: 80,
  });

  const freePort = await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => resolve(addr.port));
    });
  });

  try {
    const info = await lanMgr.startLocalSignalingServer(freePort);
    const wsUrl = `ws://127.0.0.1:${info.port}/ws/signaling`;

    const hostWs = new WebSocket(wsUrl);
    const pairCode = await new Promise((resolve, reject) => {
      hostWs.once('error', reject);
      hostWs.on('open', () => {
        hostWs.send(
          JSON.stringify({
            type: 'host:create',
            localHostToken: info.localHostToken,
            hostLabel: 'Test-PC',
          })
        );
      });
      hostWs.on('message', (raw) => {
        const msg = JSON.parse(raw.toString('utf8'));
        if (msg.type === 'host:created') resolve(msg.code);
      });
    });
    assert.match(pairCode, /^\d{6}$/);

    // Connect a silent client that ignores protocol pings (autoPong: false) -> server must terminate it
    const silentClient = new WebSocket(wsUrl, { autoPong: false });
    let closedByServer = false;
    let hostSawCancelled = false;
    hostWs.on('message', (raw) => {
      const msg = JSON.parse(raw.toString('utf8'));
      if (msg.type === 'host:pending_cancelled') hostSawCancelled = true;
    });
    await new Promise((resolve, reject) => {
      silentClient.once('error', reject);
      silentClient.on('open', () => {
        silentClient.send(JSON.stringify({ type: 'client:join', code: pairCode, deviceLabel: 'ZombiePhone' }));
      });
      silentClient.on('close', () => {
        closedByServer = true;
        resolve();
      });
      setTimeout(() => reject(new Error('Zombie client was not terminated by lan-server heartbeat')), 2000);
    });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(closedByServer, true);
    assert.equal(hostSawCancelled, true);
    hostWs.close();
  } finally {
    lanMgr.stopLocalSignalingServer();
    fs.rmSync(tmpLanDir, { recursive: true, force: true });
  }

  // 7b. Hot audio toggle: audioSender != null uses replaceTrack and skips renegotiation; audioSender == null falls back
  const prevNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let audioEnabledState = false;
  let renegotiateCalls = 0;
  let replacedTracks = [];
  let currentAudioSender = {
    async replaceTrack(track) {
      replacedTracks.push(track);
    },
  };
  const makeTrack = (kind) => ({ kind, readyState: 'live', enabled: true, muted: false, stop() { this.readyState = 'ended'; } });
  const makeStream = (tracks) => ({
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    removeTrack: () => {},
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        async getUserMedia(constraints) {
          if (constraints && constraints.audio) return makeStream([makeTrack('video'), makeTrack('audio')]);
          return makeStream([makeTrack('video')]);
        },
      },
    },
  });

  try {
    const mgr = createMediaCaptureManager({
      getScreenSources: () => [{ id: 'screen:0:0', displayId: '1', name: 'Display 1' }],
      getSelectedDisplayId: () => '1',
      setSelectedDisplayId: () => {},
      getSelectedResolution: () => '1080p',
      getCaptureMaxFps: () => 30,
      getContentHintPref: () => 'auto',
      getAudioEnabled: () => audioEnabledState,
      setAudioEnabledState: (v) => {
        audioEnabledState = Boolean(v);
      },
      getVirtualAudioInfo: () => null,
      getMuteHostVirtualAudio: () => false,
      getIsHosting: () => true,
      getHasActivePeer: () => true,
      getHasPc: () => true,
      getPcStats: async () => new Map(),
      getHostInSecureDesktop: () => false,
      getVideoSender: () => null,
      getAudioSender: () => currentAudioSender,
      getReliableDc: () => null,
      getWs: () => null,
      onAudioRenegotiatePreserveCtrl: () => {
        renegotiateCalls += 1;
      },
      applyVideoParameters: async () => {},
      getAbrTargetKbps: () => 6000,
      getAbrFpsCap: () => 30,
      getIsIdleThrottled: () => false,
      pushDisplaysListToClient: () => {},
      pushUiConfigToClient: () => {},
      showNotice: () => {},
      setStatusText: () => {},
      airdeskAPI: {
        setActiveDisplay: async () => ({ ok: true }),
        setVirtualAudioRoute: async () => ({ ok: true }),
      },
    });
    await mgr.ensureLocalCaptureReady();
    await mgr.setDesktopAudioEnabled(true, false);
    assert.equal(renegotiateCalls, 0);
    assert.equal(replacedTracks.length, 1);
    assert.equal(replacedTracks[0].kind, 'audio');

    await mgr.setDesktopAudioEnabled(false, false);
    assert.equal(renegotiateCalls, 0);
    assert.equal(replacedTracks.length, 2);
    assert.equal(replacedTracks[1], null);

    // Fallback path when audioSender is null (e.g. legacy/Web PWA client)
    currentAudioSender = null;
    await mgr.setDesktopAudioEnabled(true, false);
    assert.equal(renegotiateCalls, 1);
    mgr.releaseLocalCaptureMedia();
  } finally {
    if (prevNavDesc) Object.defineProperty(globalThis, 'navigator', prevNavDesc);
    else delete globalThis.navigator;
  }

  // 7c. Structural assertions for PR 1 in host.js
  const hostSrc = fs.readFileSync(hostJsPath, 'utf8');
  assert.ok(hostSrc.includes("audioTransceiver.direction = 'sendonly'"));
  assert.ok(hostSrc.includes("RTCRtpSender.getCapabilities('video')"));
  assert.ok(hostSrc.includes('iceCandidatePoolSize: resolvedIceServers.length > 0 ? 2 : 0'));
  assert.ok(hostSrc.includes('wsPongTimeoutTimer'));
  assert.ok(hostSrc.includes('cachedHostname'));
}

console.log(
  `[AirDesk Tests] Passed syntax checks (${cjsFiles.length} CJS, ${mjsFiles.length} MJS, host.js) + sdp-codec, abr-controller, trust-store, PR 0 idle-guard & PR 1 stability/hot-audio tests.`
);
