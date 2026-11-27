import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { createRelayServer } from '../server.mjs';

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMsg(ws, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for WebSocket message'));
    }, 5000);
    const onMessage = (raw) => {
      const msg = JSON.parse(raw.toString('utf8'));
      if (!predicate || predicate(msg)) {
        cleanup();
        resolve(msg);
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error('WebSocket closed unexpectedly'));
    };
    function cleanup() {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('close', onClose);
    }
    ws.on('message', onMessage);
    ws.on('close', onClose);
  });
}

async function run() {
  const relay = createRelayServer({
    accessKey: 'secret-room-key',
    stunUrls: 'stun:stun.example.com:3478',
    turnUrls: 'turn:turn.example.com:3478?transport=udp',
    turnSecret: 'hmac-test-secret',
    turnTtlSec: 3600,
  });

  await new Promise((resolve) => relay.server.listen(0, '127.0.0.1', resolve));
  const addr = relay.server.address();
  const baseHttp = `http://127.0.0.1:${addr.port}`;
  const baseWs = `ws://127.0.0.1:${addr.port}/ws/signaling`;

  try {
    // 1. /health and /api/ice with dynamic HMAC TURN credential (accessKey gated)
    const healthRes = await fetch(`${baseHttp}/health`).then((r) => r.json());
    assert.equal(healthRes.ok, true);
    assert.equal(healthRes.hasTurn, true);
    assert.equal(healthRes.requiresAccessKey, true);

    const unauthIce = await fetch(`${baseHttp}/api/ice`);
    assert.equal(unauthIce.status, 401);

    const iceRes = await fetch(`${baseHttp}/api/ice`, {
      headers: { 'X-AirDesk-Access-Key': 'secret-room-key' },
    }).then((r) => r.json());
    assert.equal(iceRes.ok, true);
    assert.equal(iceRes.iceServers.length, 2);
    const turnEntry = iceRes.iceServers[1];
    assert.equal(turnEntry.urls, 'turn:turn.example.com:3478?transport=udp');
    const expectedCred = crypto
      .createHmac('sha1', 'hmac-test-secret')
      .update(turnEntry.username)
      .digest('base64');
    assert.equal(turnEntry.credential, expectedCred);

    // 2. RELAY_ACCESS_KEY rejects bad key
    const badHost = await openWs(baseWs);
    const badErrP = nextMsg(badHost, (m) => m.type === 'error');
    badHost.send(JSON.stringify({ type: 'host:create', accessKey: 'wrong-key' }));
    const badErr = await badErrP;
    assert.match(badErr.message, /密钥/);
    badHost.close();

    // 3. Valid host creates room, bad code fails, good code joins & gets approved
    const hostWs = await openWs(baseWs);
    const createdP = nextMsg(hostWs, (m) => m.type === 'host:created');
    hostWs.send(
      JSON.stringify({
        type: 'host:create',
        accessKey: 'secret-room-key',
        hostLabel: 'Test-PC',
        audioEnabled: true,
      })
    );
    const created = await createdP;
    assert.match(created.code, /^\d{6}$/);
    assert.equal(created.iceServers.length, 2);

    const clientWs = await openWs(baseWs);
    const wrongJoinP = nextMsg(clientWs, (m) => m.type === 'error');
    clientWs.send(JSON.stringify({ type: 'client:join', code: '000000' }));
    await wrongJoinP;

    const waitingP = nextMsg(clientWs, (m) => m.type === 'client:waiting_approval');
    const approvalReqP = nextMsg(hostWs, (m) => m.type === 'host:approval_request');
    clientWs.send(
      JSON.stringify({
        type: 'client:join',
        code: created.code,
        deviceLabel: 'Xiaomi 13',
        platformHint: 'Android App',
      })
    );
    await waitingP;
    const reqMsg = await approvalReqP;
    assert.equal(reqMsg.client.deviceLabel, 'Xiaomi 13');

    const approvedP = nextMsg(clientWs, (m) => m.type === 'client:approved');
    hostWs.send(JSON.stringify({ type: 'host:approval_decision', approved: true, mode: 'full_control' }));
    const approved = await approvedP;
    assert.equal(approved.mode, 'full_control');
    assert.equal(approved.audioEnabled, true);
    assert.equal(approved.iceServers.length, 2);
    assert.ok(approved.sessionToken && approved.sessionToken.length >= 16);

    // 4. Bidirectional SDP & ICE relay
    const hostOfferP = nextMsg(hostWs, (m) => m.type === 'rtc:offer');
    clientWs.send(JSON.stringify({ type: 'rtc:offer', sdp: 'v=0-offer' }));
    assert.equal((await hostOfferP).sdp, 'v=0-offer');

    const clientAnsP = nextMsg(clientWs, (m) => m.type === 'rtc:answer');
    hostWs.send(JSON.stringify({ type: 'rtc:answer', sdp: 'v=0-answer' }));
    assert.equal((await clientAnsP).sdp, 'v=0-answer');

    // 5. Session token auto-reconnect while old socket is still open (must NOT emit host:client_disconnected)
    let spuriousDisconnect = false;
    const onHostMsg = (raw) => {
      const m = JSON.parse(raw.toString('utf8'));
      if (m.type === 'host:client_disconnected') spuriousDisconnect = true;
    };
    hostWs.on('message', onHostMsg);

    const reconnWs = await openWs(baseWs);
    const reconnApprovedP = nextMsg(reconnWs, (m) => m.type === 'client:approved');
    const hostReconnP = nextMsg(hostWs, (m) => m.type === 'host:client_reconnected');
    reconnWs.send(JSON.stringify({ type: 'client:join', sessionToken: approved.sessionToken }));
    const reconnApproved = await reconnApprovedP;
    assert.equal(reconnApproved.reconnected, true);
    assert.equal(reconnApproved.audioEnabled, true);
    assert.equal((await hostReconnP).mode, 'full_control');
    await new Promise((r) => setTimeout(r, 80));
    hostWs.off('message', onHostMsg);
    assert.equal(spuriousDisconnect, false);

    // 5b. Host downgrades active mode -> reconnect respects view_only
    hostWs.send(JSON.stringify({ type: 'host:update_config', activeMode: 'view_only' }));
    await new Promise((r) => setTimeout(r, 30));
    const reconnWs2 = await openWs(baseWs);
    const reconn2ApprovedP = nextMsg(reconnWs2, (m) => m.type === 'client:approved');
    const hostReconn2P = nextMsg(hostWs, (m) => m.type === 'host:client_reconnected');
    reconnWs2.send(JSON.stringify({ type: 'client:join', sessionToken: approved.sessionToken }));
    const reconn2Approved = await reconn2ApprovedP;
    assert.equal(reconn2Approved.mode, 'view_only');
    assert.equal((await hostReconn2P).mode, 'view_only');
    reconnWs2.close();
    await nextMsg(hostWs, (m) => m.type === 'host:client_disconnected');

    // 6. Emergency stop revokes session tokens
    const reconnWs3 = await openWs(baseWs);
    const reconn3ApprovedP = nextMsg(reconnWs3, (m) => m.type === 'client:approved');
    reconnWs3.send(JSON.stringify({ type: 'client:join', sessionToken: approved.sessionToken }));
    await reconn3ApprovedP;
    const permP = nextMsg(reconnWs3, (m) => m.type === 'session:permission_updated');
    hostWs.send(JSON.stringify({ type: 'host:emergency_stop' }));
    assert.equal((await permP).controlEnabled, false);
    reconnWs3.close();
    await nextMsg(hostWs, (m) => m.type === 'host:client_disconnected');

    const expiredWs = await openWs(baseWs);
    const expiredErrP = nextMsg(expiredWs, (m) => m.type === 'error');
    expiredWs.send(JSON.stringify({ type: 'client:join', sessionToken: approved.sessionToken }));
    await expiredErrP;

    expiredWs.close();
    hostWs.close();

    // 7. v2 persistent hostId + hostSecret reclaim & desktop-delegated token verification
    const hostId = '482910537';
    const hostSecret = crypto.randomBytes(24).toString('hex');
    const hostIssuedToken = crypto.randomBytes(16).toString('hex');

    const v2Host1 = await openWs(baseWs);
    const v2Created1P = nextMsg(v2Host1, (m) => m.type === 'host:created');
    v2Host1.send(
      JSON.stringify({
        type: 'host:create',
        protoVersion: 2,
        hostId,
        hostSecret,
        accessKey: 'secret-room-key',
        hostLabel: 'Home-PC',
        audioEnabled: false,
      })
    );
    const v2Created1 = await v2Created1P;
    assert.equal(v2Created1.hostId, hostId);
    assert.equal(v2Created1.protoVersion, 2);

    // 7a. Initial 6-digit pairing returns hostId + host-issued sessionToken
    const v2Client1 = await openWs(baseWs);
    const v2ReqP = nextMsg(v2Host1, (m) => m.type === 'host:approval_request');
    v2Client1.send(
      JSON.stringify({
        type: 'client:join',
        protoVersion: 2,
        code: v2Created1.code,
        deviceLabel: 'Xiaomi 13',
        platformHint: 'Android App',
      })
    );
    await v2ReqP;
    const v2App1P = nextMsg(v2Client1, (m) => m.type === 'client:approved');
    v2Host1.send(
      JSON.stringify({
        type: 'host:approval_decision',
        approved: true,
        mode: 'full_control',
        sessionToken: hostIssuedToken,
      })
    );
    const v2App1 = await v2App1P;
    assert.equal(v2App1.hostId, hostId);
    assert.equal(v2App1.sessionToken, hostIssuedToken);

    // 7b. Explicit host session:close + disconnect -> client joining with hostId + sessionToken gets HOST_OFFLINE (retryable)
    const v2ClosedP = nextMsg(v2Client1, (m) => m.type === 'session:closed');
    v2Host1.send(JSON.stringify({ type: 'session:close', reason: 'host_stop' }));
    v2Host1.close();
    await v2ClosedP;
    await new Promise((r) => setTimeout(r, 40));

    const offlineClient = await openWs(baseWs);
    const offlineErrP = nextMsg(offlineClient, (m) => m.type === 'error');
    offlineClient.send(
      JSON.stringify({
        type: 'client:join',
        protoVersion: 2,
        hostId,
        sessionToken: hostIssuedToken,
      })
    );
    const offlineErr = await offlineErrP;
    assert.equal(offlineErr.code, 'HOST_OFFLINE');
    assert.equal(offlineErr.retryable, true);
    offlineClient.close();

    // 7c. Wrong hostSecret attempting to hijack hostId is rejected
    const rogueHost = await openWs(baseWs);
    const rogueErrP = nextMsg(rogueHost, (m) => m.type === 'error');
    rogueHost.send(
      JSON.stringify({
        type: 'host:create',
        protoVersion: 2,
        hostId,
        hostSecret: 'wrong-host-secret-000000',
        accessKey: 'secret-room-key',
      })
    );
    const rogueErr = await rogueErrP;
    assert.match(rogueErr.message, /校验失败/);
    rogueHost.close();

    // 7d. Genuine host reconnects and reclaims same hostId; client reconnects via host:verify_token
    const v2Host2 = await openWs(baseWs);
    const v2Created2P = nextMsg(v2Host2, (m) => m.type === 'host:created');
    v2Host2.send(
      JSON.stringify({
        type: 'host:create',
        protoVersion: 2,
        hostId,
        hostSecret,
        accessKey: 'secret-room-key',
        hostLabel: 'Home-PC',
      })
    );
    const v2Created2 = await v2Created2P;
    assert.equal(v2Created2.hostId, hostId);
    assert.notEqual(v2Created2.code, v2Created1.code);

    // Keep v2Client1 open until host approves new socket -> must only kick v2Client1 AFTER approved === true
    const v2Client2 = await openWs(baseWs);
    const verifyReqP = nextMsg(v2Host2, (m) => m.type === 'host:verify_token');
    v2Client2.send(
      JSON.stringify({
        type: 'client:join',
        protoVersion: 2,
        hostId,
        sessionToken: hostIssuedToken,
        deviceLabel: 'Xiaomi 13',
      })
    );
    const verifyReq = await verifyReqP;
    assert.equal(verifyReq.sessionToken, hostIssuedToken);
    assert.ok(verifyReq.verifyId);

    const v2App2P = nextMsg(v2Client2, (m) => m.type === 'client:approved');
    const v2HostReconnP = nextMsg(v2Host2, (m) => m.type === 'host:client_reconnected');
    v2Host2.send(
      JSON.stringify({
        type: 'host:token_verified',
        verifyId: verifyReq.verifyId,
        approved: true,
        mode: 'full_control',
      })
    );
    const v2App2 = await v2App2P;
    assert.equal(v2App2.reconnected, true);
    assert.equal(v2App2.hostId, hostId);
    assert.equal(v2App2.mode, 'full_control');
    assert.equal((await v2HostReconnP).mode, 'full_control');

    // 7e. Rejected host:token_verified keeps activeClientWs intact and records IP failure
    const badTokenClient = await openWs(baseWs);
    const verifyBadP = nextMsg(v2Host2, (m) => m.type === 'host:verify_token');
    badTokenClient.send(
      JSON.stringify({
        type: 'client:join',
        protoVersion: 2,
        hostId,
        sessionToken: 'revoked-token-1234567890',
      })
    );
    const verifyBad = await verifyBadP;
    const badTokenErrP = nextMsg(badTokenClient, (m) => m.type === 'error');
    v2Host2.send(
      JSON.stringify({
        type: 'host:token_verified',
        verifyId: verifyBad.verifyId,
        approved: false,
        reason: '凭证已被电脑端撤销',
      })
    );
    const badTokenErr = await badTokenErrP;
    assert.equal(badTokenErr.code, 'TOKEN_INVALID');
    assert.equal(v2Client2.readyState, WebSocket.OPEN);

    // 7f. Concurrent verifyId cap (max 4)
    const verifyFloodClients = [];
    for (let i = 0; i < 4; i += 1) {
      const c = await openWs(baseWs);
      verifyFloodClients.push(c);
      const p = nextMsg(v2Host2, (m) => m.type === 'host:verify_token');
      c.send(
        JSON.stringify({
          type: 'client:join',
          protoVersion: 2,
          hostId,
          sessionToken: `flood-token-${i}-1234567890`,
        })
      );
      await p;
    }
    const fifthClient = await openWs(baseWs);
    const fifthErrP = nextMsg(fifthClient, (m) => m.type === 'error');
    fifthClient.send(
      JSON.stringify({
        type: 'client:join',
        protoVersion: 2,
        hostId,
        sessionToken: 'flood-token-5-1234567890',
      })
    );
    const fifthErr = await fifthErrP;
    assert.equal(fifthErr.retryable, true);

    fifthClient.close();
    for (const c of verifyFloodClients) c.close();
    badTokenClient.close();
    v2Client1.close();

    // 7g. Host session:close frees active client slot immediately for new client join
    const v2SessionClosedP = nextMsg(v2Client2, (m) => m.type === 'session:closed');
    v2Host2.send(JSON.stringify({ type: 'session:close', reason: '电脑端已移除当前设备信任凭证' }));
    const v2SessionClosed = await v2SessionClosedP;
    assert.match(v2SessionClosed.reason, /移除/);

    const v2Client3 = await openWs(baseWs);
    const v2Wait3P = nextMsg(v2Client3, (m) => m.type === 'client:waiting_approval');
    const v2Req3P = nextMsg(v2Host2, (m) => m.type === 'host:approval_request');
    v2Client3.send(
      JSON.stringify({
        type: 'client:join',
        protoVersion: 2,
        code: v2Created2.code,
        deviceLabel: 'New Phone',
        platformHint: 'Android App',
      })
    );
    await v2Wait3P;
    assert.equal((await v2Req3P).client.deviceLabel, 'New Phone');

    v2Client3.close();
    v2Client2.close();
    v2Host2.close();

    // 8. Unattended password challenge-response forwarding & protection
    const p2HostId = 'k7m2p9x4q1w8';
    const p2HostSecret = crypto.randomBytes(24).toString('hex');
    const p2HostWs = await openWs(baseWs);
    const p2CreatedP = nextMsg(p2HostWs, (m) => m.type === 'host:created');
    p2HostWs.send(
      JSON.stringify({
        type: 'host:create',
        protoVersion: 2,
        hostId: p2HostId,
        hostSecret: p2HostSecret,
        accessKey: 'secret-room-key',
        hostLabel: 'P2-PC',
      })
    );
    const p2Created = await p2CreatedP;
    assert.equal(p2Created.hostId, p2HostId);

    // 8a. Password disabled error
    const pwDisabledClient = await openWs(baseWs);
    const chalReq1P = nextMsg(p2HostWs, (m) => m.type === 'host:password_challenge_request');
    pwDisabledClient.send(
      JSON.stringify({
        type: 'client:join',
        protoVersion: 2,
        authMode: 'password',
        hostId: p2HostId,
      })
    );
    const chalReq1 = await chalReq1P;
    const pwDisabledErrP = nextMsg(pwDisabledClient, (m) => m.type === 'error');
    p2HostWs.send(
      JSON.stringify({
        type: 'host:password_challenge_reply',
        challengeId: chalReq1.challengeId,
        ok: false,
        code: 'PASSWORD_DISABLED',
        message: '目标电脑未开启无人值守访问密码',
      })
    );
    const pwDisabledErr = await pwDisabledErrP;
    assert.equal(pwDisabledErr.code, 'PASSWORD_DISABLED');
    pwDisabledClient.close();

    // 8b. Existing active client stays connected during password challenge & failed attempts
    const activeClient = await openWs(baseWs);
    const activeReqP = nextMsg(p2HostWs, (m) => m.type === 'host:approval_request');
    activeClient.send(JSON.stringify({ type: 'client:join', code: p2Created.code }));
    await activeReqP;
    const activeAppP = nextMsg(activeClient, (m) => m.type === 'client:approved');
    p2HostWs.send(
      JSON.stringify({
        type: 'host:approval_decision',
        approved: true,
        mode: 'view_only',
        sessionToken: crypto.randomBytes(16).toString('hex'),
      })
    );
    await activeAppP;

    const badPwClient = await openWs(baseWs);
    const badChalReqP = nextMsg(p2HostWs, (m) => m.type === 'host:password_challenge_request');
    badPwClient.send(
      JSON.stringify({
        type: 'client:join',
        protoVersion: 2,
        authMode: 'password',
        hostId: p2HostId,
      })
    );
    const badChalReq = await badChalReqP;
    const clientChal1P = nextMsg(badPwClient, (m) => m.type === 'client:password_challenge');
    p2HostWs.send(
      JSON.stringify({
        type: 'host:password_challenge_reply',
        challengeId: badChalReq.challengeId,
        ok: true,
        nonce: 'n1'.repeat(12),
        salt: 's1'.repeat(8),
        kdf: 'scrypt',
        n: 16384,
        r: 8,
        p: 1,
        dkLen: 32,
      })
    );
    const clientChal1 = await clientChal1P;
    assert.equal(clientChal1.hostId, p2HostId);

    const hostVerify1P = nextMsg(p2HostWs, (m) => m.type === 'host:password_verify');
    badPwClient.send(
      JSON.stringify({
        type: 'client:password_response',
        challengeId: clientChal1.challengeId,
        proof: '00'.repeat(32),
      })
    );
    const hostVerify1 = await hostVerify1P;
    const badPwErrP = nextMsg(badPwClient, (m) => m.type === 'error');
    p2HostWs.send(
      JSON.stringify({
        type: 'host:password_verified',
        challengeId: hostVerify1.challengeId,
        approved: false,
        code: 'PASSWORD_INVALID',
        message: '访问密码错误（还剩 4 次机会）',
      })
    );
    const badPwErr = await badPwErrP;
    assert.equal(badPwErr.code, 'PASSWORD_INVALID');
    // Crucial: activeClient must NOT be kicked during challenge or on rejection
    assert.equal(activeClient.readyState, WebSocket.OPEN);
    badPwClient.close();

    // 8c. Successful password challenge replaces activeClient ONLY after approved === true
    const goodPwClient = await openWs(baseWs);
    const goodChalReqP = nextMsg(p2HostWs, (m) => m.type === 'host:password_challenge_request');
    goodPwClient.send(
      JSON.stringify({
        type: 'client:join',
        protoVersion: 2,
        authMode: 'password',
        hostId: p2HostId,
        deviceLabel: 'New Phone P2',
      })
    );
    const goodChalReq = await goodChalReqP;
    const clientChal2P = nextMsg(goodPwClient, (m) => m.type === 'client:password_challenge');
    p2HostWs.send(
      JSON.stringify({
        type: 'host:password_challenge_reply',
        challengeId: goodChalReq.challengeId,
        ok: true,
        nonce: 'n2'.repeat(12),
        salt: 's1'.repeat(8),
        kdf: 'scrypt',
        n: 16384,
        r: 8,
        p: 1,
        dkLen: 32,
      })
    );
    await clientChal2P;

    const hostVerify2P = nextMsg(p2HostWs, (m) => m.type === 'host:password_verify');
    goodPwClient.send(
      JSON.stringify({
        type: 'client:password_response',
        challengeId: goodChalReq.challengeId,
        proof: 'ab'.repeat(32),
      })
    );
    const hostVerify2 = await hostVerify2P;
    const pwIssuedTok = crypto.randomBytes(16).toString('hex');
    const goodAppP = nextMsg(goodPwClient, (m) => m.type === 'client:approved');
    const hostReconnP2 = nextMsg(p2HostWs, (m) => m.type === 'host:client_reconnected');
    p2HostWs.send(
      JSON.stringify({
        type: 'host:password_verified',
        challengeId: hostVerify2.challengeId,
        approved: true,
        mode: 'full_control',
        sessionToken: pwIssuedTok,
      })
    );
    const goodApp = await goodAppP;
    assert.equal(goodApp.hostId, p2HostId);
    assert.equal(goodApp.sessionToken, pwIssuedTok);
    assert.equal(goodApp.mode, 'full_control');
    assert.equal((await hostReconnP2).deviceLabel, 'New Phone P2');

    goodPwClient.close();
    activeClient.close();
    p2HostWs.close();

    // 9. PR 2 Signaling/Media decoupling: grace periods, resumeIfActive, attachExisting, relay restart & cross-device takeover
    {
      const gRelay = createRelayServer({
        accessKey: 'secret-room-key',
        gracePeriodMs: 250,
      });
      await new Promise((resolve) => gRelay.server.listen(0, '127.0.0.1', resolve));
      const gAddr = gRelay.server.address();
      const gWsUrl = `ws://127.0.0.1:${gAddr.port}/ws/signaling`;

      try {
        const gHostId = 'decouplehost1';
        const gHostSecret = crypto.randomBytes(24).toString('hex');
        const gTokA = crypto.randomBytes(16).toString('hex');
        const gTokB = crypto.randomBytes(16).toString('hex');

        const gh1 = await openWs(gWsUrl);
        const gc1P = nextMsg(gh1, (m) => m.type === 'host:created');
        gh1.send(
          JSON.stringify({
            type: 'host:create',
            protoVersion: 2,
            hostId: gHostId,
            hostSecret: gHostSecret,
            accessKey: 'secret-room-key',
            hostLabel: 'Decouple-PC',
          })
        );
        const gc1 = await gc1P;

        const gcl1 = await openWs(gWsUrl);
        const gReqP = nextMsg(gh1, (m) => m.type === 'host:approval_request');
        gcl1.send(
          JSON.stringify({
            type: 'client:join',
            protoVersion: 2,
            code: gc1.code,
            deviceLabel: 'Phone-A',
          })
        );
        await gReqP;
        const gAppP = nextMsg(gcl1, (m) => m.type === 'client:approved');
        gh1.send(
          JSON.stringify({
            type: 'host:approval_decision',
            approved: true,
            mode: 'full_control',
            sessionToken: gTokA,
          })
        );
        await gAppP;

        // 9a. Unplanned host WS drop within grace period keeps client alive, resumeIfActive resumes room
        let clientSawClosedDuringGrace = false;
        const onClientMsg9a = (raw) => {
          const m = JSON.parse(raw.toString('utf8'));
          if (m.type === 'session:closed') clientSawClosedDuringGrace = true;
        };
        gcl1.on('message', onClientMsg9a);
        gh1.close();
        await new Promise((r) => setTimeout(r, 80));
        assert.equal(clientSawClosedDuringGrace, false);
        gcl1.off('message', onClientMsg9a);

        const gh2 = await openWs(gWsUrl);
        const gResumedP = nextMsg(gcl1, (m) => m.type === 'session:signaling_resumed');
        const gh2CreatedP = nextMsg(gh2, (m) => m.type === 'host:created');
        gh2.send(
          JSON.stringify({
            type: 'host:create',
            protoVersion: 2,
            hostId: gHostId,
            hostSecret: gHostSecret,
            accessKey: 'secret-room-key',
            resumeIfActive: true,
          })
        );
        assert.equal((await gResumedP).role, 'host');
        assert.equal((await gh2CreatedP).resumedActiveClient, true);

        const offerRelayP = nextMsg(gh2, (m) => m.type === 'rtc:offer');
        gcl1.send(JSON.stringify({ type: 'rtc:offer', sdp: 'after-host-resume' }));
        assert.equal((await offerRelayP).sdp, 'after-host-resume');

        // 9b. Unplanned client WS drop within grace period -> attachExisting: true + Desktop reattached: true
        let hostSawDisconnectDuringGrace = false;
        const onHostMsg9b = (raw) => {
          const m = JSON.parse(raw.toString('utf8'));
          if (m.type === 'host:client_disconnected') hostSawDisconnectDuringGrace = true;
        };
        gh2.on('message', onHostMsg9b);
        gcl1.close();
        await new Promise((r) => setTimeout(r, 80));
        assert.equal(hostSawDisconnectDuringGrace, false);
        gh2.off('message', onHostMsg9b);

        const gcl2 = await openWs(gWsUrl);
        const verifyAttachP = nextMsg(gh2, (m) => m.type === 'host:verify_token');
        gcl2.send(
          JSON.stringify({
            type: 'client:join',
            protoVersion: 2,
            hostId: gHostId,
            sessionToken: gTokA,
            attachExisting: true,
            deviceLabel: 'Phone-A',
          })
        );
        const verifyAttach = await verifyAttachP;
        assert.equal(verifyAttach.attachExisting, true);

        const gcl2AppP = nextMsg(gcl2, (m) => m.type === 'client:approved');
        const hostReattP = nextMsg(gh2, (m) => m.type === 'host:client_reattached');
        gh2.send(
          JSON.stringify({
            type: 'host:token_verified',
            verifyId: verifyAttach.verifyId,
            approved: true,
            reattached: true,
            mode: 'full_control',
          })
        );
        const gcl2App = await gcl2AppP;
        assert.equal(gcl2App.reattached, true);
        assert.equal((await hostReattP).mode, 'full_control');

        const iceOfferP = nextMsg(gh2, (m) => m.type === 'rtc:offer');
        gcl2.send(JSON.stringify({ type: 'rtc:offer', sdp: 'ice-restart-sdp', iceRestart: true }));
        const iceOffer = await iceOfferP;
        assert.equal(iceOffer.iceRestart, true);
        assert.equal(iceOffer.sdp, 'ice-restart-sdp');

        // 9c. Cross-device takeover with DIFFERENT token -> Desktop replies reattached: false -> kicks gcl2
        const gcl3 = await openWs(gWsUrl);
        const verifyTakeoverP = nextMsg(gh2, (m) => m.type === 'host:verify_token');
        gcl3.send(
          JSON.stringify({
            type: 'client:join',
            protoVersion: 2,
            hostId: gHostId,
            sessionToken: gTokB,
            attachExisting: true,
            deviceLabel: 'Phone-B',
          })
        );
        const verifyTakeover = await verifyTakeoverP;
        const gcl2KickedP = nextMsg(gcl2, (m) => m.type === 'session:closed');
        const gcl3AppP = nextMsg(gcl3, (m) => m.type === 'client:approved');
        const hostReconnTakeoverP = nextMsg(gh2, (m) => m.type === 'host:client_reconnected');
        gh2.send(
          JSON.stringify({
            type: 'host:token_verified',
            verifyId: verifyTakeover.verifyId,
            approved: true,
            reattached: false,
            mode: 'view_only',
          })
        );
        await gcl2KickedP;
        assert.equal((await gcl3AppP).reattached, false);
        assert.equal((await hostReconnTakeoverP).deviceLabel, 'Phone-B');

        // 9d. Explicit session:close cleans up immediately (no grace wait)
        const immediateClosedP = nextMsg(gcl3, (m) => m.type === 'session:closed');
        gh2.send(JSON.stringify({ type: 'session:close', reason: 'manual_stop' }));
        assert.equal((await immediateClosedP).reason, 'manual_stop');

        // 9e. Unplanned disconnect past gracePeriodMs fires timeout cleanup
        const gcl4 = await openWs(gWsUrl);
        const v4P = nextMsg(gh2, (m) => m.type === 'host:verify_token');
        gcl4.send(
          JSON.stringify({
            type: 'client:join',
            protoVersion: 2,
            hostId: gHostId,
            sessionToken: gTokB,
          })
        );
        const v4 = await v4P;
        const app4P = nextMsg(gcl4, (m) => m.type === 'client:approved');
        gh2.send(
          JSON.stringify({
            type: 'host:token_verified',
            verifyId: v4.verifyId,
            approved: true,
            mode: 'full_control',
          })
        );
        await app4P;
        const hostTimeoutP = nextMsg(gh2, (m) => m.type === 'host:client_disconnected');
        gcl4.close();
        const hostTimeout = await hostTimeoutP;
        assert.match(hostTimeout.reason, /超时/);

        gcl2.close();
        gcl3.close();
        gh2.close();
      } finally {
        await gRelay.close();
      }

      // 9f. Simulated relay restart (empty in-memory roomsByHostId) still allows authoritative reattach
      const gRelayRestarted = createRelayServer({ accessKey: 'secret-room-key', gracePeriodMs: 250 });
      await new Promise((resolve) => gRelayRestarted.server.listen(0, '127.0.0.1', resolve));
      const rAddr = gRelayRestarted.server.address();
      const rWsUrl = `ws://127.0.0.1:${rAddr.port}/ws/signaling`;
      try {
        const rh = await openWs(rWsUrl);
        const rcP = nextMsg(rh, (m) => m.type === 'host:created');
        rh.send(
          JSON.stringify({
            type: 'host:create',
            protoVersion: 2,
            hostId: 'restartedhost1',
            hostSecret: crypto.randomBytes(24).toString('hex'),
            accessKey: 'secret-room-key',
            resumeIfActive: true,
          })
        );
        await rcP;

        const rcl = await openWs(rWsUrl);
        const rvP = nextMsg(rh, (m) => m.type === 'host:verify_token');
        rcl.send(
          JSON.stringify({
            type: 'client:join',
            protoVersion: 2,
            hostId: 'restartedhost1',
            sessionToken: crypto.randomBytes(16).toString('hex'),
            attachExisting: true,
          })
        );
        const rv = await rvP;
        const rclAppP = nextMsg(rcl, (m) => m.type === 'client:approved');
        const rhReattP = nextMsg(rh, (m) => m.type === 'host:client_reattached');
        rh.send(
          JSON.stringify({
            type: 'host:token_verified',
            verifyId: rv.verifyId,
            approved: true,
            reattached: true,
            mode: 'full_control',
          })
        );
        assert.equal((await rclAppP).reattached, true);
        assert.equal((await rhReattP).mode, 'full_control');
        rcl.close();
        rh.close();
      } finally {
        await gRelayRestarted.close();
      }
    }

    console.log('RELAY_SMOKE_TEST_ALL_9_CHECKS_PASSED');
  } finally {
    await relay.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
