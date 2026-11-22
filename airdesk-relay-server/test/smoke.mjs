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
    console.log('RELAY_SMOKE_TEST_ALL_6_CHECKS_PASSED');
  } finally {
    await relay.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
