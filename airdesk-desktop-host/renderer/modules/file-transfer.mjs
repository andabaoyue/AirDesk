export const FILE_CHUNK_BYTES = 16384;
export const MAX_FILE_TRANSFER_BYTES = 500 * 1024 * 1024;

export function formatFileBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(2) + ' MB';
}

export function createFileTransferManager({
  statusEl,
  progressWrapEl,
  progressBarEl,
  logEl,
  showNotice,
  airdeskAPI,
}) {
  let fileDc = null;
  const outgoingFileQueue = [];
  let outgoingFileBusy = false;
  let pendingOutgoingOffer = null;
  let pendingOutgoingAck = null;
  let activeIncomingFile = null;
  let incomingFileWriteChain = Promise.resolve();
  const recentFileLogs = [];

  function updateFileTransferUi(statusText, ratio) {
    if (statusEl && typeof statusText === 'string') {
      statusEl.textContent = statusText;
    }
    if (progressWrapEl && progressBarEl) {
      if (typeof ratio === 'number' && Number.isFinite(ratio) && ratio >= 0) {
        progressWrapEl.style.display = 'block';
        progressBarEl.style.width = Math.max(0, Math.min(100, Math.round(ratio * 100))) + '%';
      } else {
        progressWrapEl.style.display = 'none';
        progressBarEl.style.width = '0%';
      }
    }
  }

  function appendFileTransferLog(line) {
    if (!line) return;
    recentFileLogs.unshift('[' + new Date().toLocaleTimeString() + '] ' + line);
    if (recentFileLogs.length > 5) recentFileLogs.length = 5;
    if (logEl) {
      logEl.textContent = recentFileLogs.join('\n');
    }
  }

  function rejectPendingOutgoingFileWaiters(reason) {
    if (pendingOutgoingOffer) {
      const p = pendingOutgoingOffer;
      pendingOutgoingOffer = null;
      p.reject(new Error(reason));
    }
    if (pendingOutgoingAck) {
      const p = pendingOutgoingAck;
      pendingOutgoingAck = null;
      p.reject(new Error(reason));
    }
  }

  function waitForFileOfferResponse(id, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pendingOutgoingOffer && pendingOutgoingOffer.id === id) {
          pendingOutgoingOffer = null;
          reject(new Error('手机端响应接收请求超时'));
        }
      }, timeoutMs);
      pendingOutgoingOffer = {
        id,
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
    });
  }

  function waitForFileAck(id, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pendingOutgoingAck && pendingOutgoingAck.id === id) {
          pendingOutgoingAck = null;
          reject(new Error('等待手机落盘确认超时'));
        }
      }, timeoutMs);
      pendingOutgoingAck = {
        id,
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
    });
  }

  async function waitFileChannelDrain(dc) {
    if (!dc || dc.readyState !== 'open' || dc.bufferedAmount <= 1048576) return;
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        dc.onbufferedamountlow = null;
        clearInterval(poll);
        resolve();
      };
      dc.onbufferedamountlow = () => {
        if (dc.bufferedAmount <= 524288) finish();
      };
      const poll = setInterval(() => {
        if (!dc || dc.readyState !== 'open' || dc.bufferedAmount <= 524288) {
          finish();
        }
      }, 30);
    });
  }

  async function processOutgoingFileQueue() {
    if (outgoingFileBusy) return;
    outgoingFileBusy = true;
    try {
      while (outgoingFileQueue.length > 0) {
        const file = outgoingFileQueue.shift();
        if (!file || !fileDc || fileDc.readyState !== 'open') break;
        const transferId = 'tx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        try {
          updateFileTransferUi('正在请求手机接收：' + file.name + ' (' + formatFileBytes(file.size) + ')', 0);
          fileDc.send(
            JSON.stringify({
              t: 'file:offer',
              id: transferId,
              name: file.name,
              size: file.size,
              mime: file.type || 'application/octet-stream',
            })
          );
          await waitForFileOfferResponse(transferId);

          let offset = 0;
          let lastUiAt = 0;
          while (offset < file.size) {
            if (!fileDc || fileDc.readyState !== 'open') {
              throw new Error('file-transfer 通道已断开');
            }
            await waitFileChannelDrain(fileDc);
            const end = Math.min(file.size, offset + FILE_CHUNK_BYTES);
            const buf = await file.slice(offset, end).arrayBuffer();
            fileDc.send(buf);
            offset = end;
            const nowTs = Date.now();
            if (nowTs - lastUiAt >= 80 || offset >= file.size) {
              lastUiAt = nowTs;
              updateFileTransferUi(
                '正在发送至手机：' + file.name + ' (' + formatFileBytes(offset) + ' / ' + formatFileBytes(file.size) + ')',
                file.size > 0 ? offset / file.size : 1
              );
            }
          }

          fileDc.send(JSON.stringify({ t: 'file:done', id: transferId, bytes: file.size }));
          const ack = await waitForFileAck(transferId);
          const savedLabel = (ack && (ack.savedPath || ack.savedName)) || file.name;
          updateFileTransferUi('发送完成：' + file.name, 1);
          appendFileTransferLog('已发送到手机：' + file.name + ' -> ' + savedLabel);
          showNotice('文件已发送到手机：' + file.name);
        } catch (err) {
          if (fileDc && fileDc.readyState === 'open') {
            try {
              fileDc.send(JSON.stringify({ t: 'file:cancel', id: transferId, reason: err.message }));
            } catch {}
          }
          updateFileTransferUi('发送失败：' + file.name + ' (' + err.message + ')', -1);
          appendFileTransferLog('发送失败：' + file.name + ' (' + err.message + ')');
          showNotice('发送失败：' + err.message);
        }
      }
    } finally {
      outgoingFileBusy = false;
    }
  }

  function enqueueFilesForMobile(fileList) {
    if (!fileDc || fileDc.readyState !== 'open') {
      showNotice('请先连接支持文件传输的手机客户端 (AirDesk v0.7.0+)');
      return;
    }
    for (const f of Array.from(fileList)) {
      if (!f) continue;
      if (f.size > MAX_FILE_TRANSFER_BYTES) {
        showNotice('文件过大（超过 500MB 上限）：' + f.name);
        continue;
      }
      outgoingFileQueue.push(f);
    }
    processOutgoingFileQueue().catch(() => {});
  }

  function attachFileTransferChannel(dc) {
    fileDc = dc;
    dc.binaryType = 'arraybuffer';
    try {
      dc.bufferedAmountLowThreshold = 262144;
    } catch {}

    dc.onopen = () => {
      updateFileTransferUi('文件传输通道已就绪（支持双向 16KB 分片传输，最大 500MB）', -1);
    };

    dc.onclose = () => {
      rejectPendingOutgoingFileWaiters('文件通道已关闭');
      outgoingFileQueue.length = 0;
      const stale = activeIncomingFile;
      activeIncomingFile = null;
      if (stale) {
        incomingFileWriteChain = incomingFileWriteChain
          .then(() => airdeskAPI.fileRecvEnd(stale.id, false))
          .catch(() => {});
      }
      updateFileTransferUi('文件传输通道已断开', -1);
    };

    dc.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        const t = msg && msg.t;
        if (t === 'file:accept') {
          if (pendingOutgoingOffer && pendingOutgoingOffer.id === msg.id) {
            const p = pendingOutgoingOffer;
            pendingOutgoingOffer = null;
            p.resolve(msg);
          }
        } else if (t === 'file:reject') {
          if (pendingOutgoingOffer && pendingOutgoingOffer.id === msg.id) {
            const p = pendingOutgoingOffer;
            pendingOutgoingOffer = null;
            p.reject(new Error(msg.reason || '对方拒绝接收文件'));
          }
        } else if (t === 'file:ack') {
          if (pendingOutgoingAck && pendingOutgoingAck.id === msg.id) {
            const p = pendingOutgoingAck;
            pendingOutgoingAck = null;
            if (msg.ok === false) p.reject(new Error(msg.message || '对方保存文件失败'));
            else p.resolve(msg);
          }
        } else if (t === 'file:offer') {
          incomingFileWriteChain = incomingFileWriteChain.then(async () => {
            if (activeIncomingFile) {
              if (dc.readyState === 'open') {
                dc.send(JSON.stringify({ t: 'file:reject', id: msg.id, reason: '电脑端正在接收另一文件' }));
              }
              return;
            }
            const res = await airdeskAPI.fileRecvBegin({
              id: msg.id,
              name: msg.name,
              size: msg.size,
              mime: msg.mime,
            });
            if (!res || !res.ok) {
              if (dc.readyState === 'open') {
                dc.send(
                  JSON.stringify({
                    t: 'file:reject',
                    id: msg.id,
                    reason: (res && res.reason) || '电脑端拒绝接收',
                  })
                );
              }
              showNotice((res && res.reason) || '拒绝接收手机文件');
              return;
            }
            activeIncomingFile = {
              id: msg.id,
              name: res.finalName || msg.name || 'file',
              expectedSize: Number(msg.size) || 0,
              receivedBytes: 0,
              lastUiAt: 0,
            };
            updateFileTransferUi(
              '正在接收手机文件：' + activeIncomingFile.name + ' (0 / ' + formatFileBytes(activeIncomingFile.expectedSize) + ')',
              0
            );
            if (dc.readyState === 'open') {
              dc.send(JSON.stringify({ t: 'file:accept', id: msg.id }));
            }
          }).catch((err) => {
            console.error('[AirDesk FileRecv] file:offer error:', err);
          });
        } else if (t === 'file:done') {
          incomingFileWriteChain = incomingFileWriteChain.then(async () => {
            const cur = activeIncomingFile;
            if (!cur || cur.id !== msg.id) return;
            activeIncomingFile = null;
            const res = await airdeskAPI.fileRecvEnd(cur.id, true);
            if (res && res.ok) {
              updateFileTransferUi('接收完成：' + (res.finalName || cur.name), 1);
              appendFileTransferLog('收到手机文件：' + (res.savedPath || res.finalName));
              showNotice('已接收手机文件：' + (res.finalName || cur.name));
              if (dc.readyState === 'open') {
                dc.send(
                  JSON.stringify({
                    t: 'file:ack',
                    id: cur.id,
                    ok: true,
                    savedName: res.finalName,
                    savedPath: res.savedPath,
                  })
                );
              }
            } else {
              updateFileTransferUi('保存失败：' + ((res && res.reason) || '写入错误'), -1);
              if (dc.readyState === 'open') {
                dc.send(
                  JSON.stringify({
                    t: 'file:ack',
                    id: cur.id,
                    ok: false,
                    message: (res && res.reason) || '写入失败',
                  })
                );
              }
            }
          }).catch((err) => {
            console.error('[AirDesk FileRecv] file:done error:', err);
          });
        } else if (t === 'file:cancel') {
          incomingFileWriteChain = incomingFileWriteChain.then(async () => {
            const cur = activeIncomingFile;
            if (cur && (!msg.id || cur.id === msg.id)) {
              activeIncomingFile = null;
              await airdeskAPI.fileRecvEnd(cur.id, false);
              updateFileTransferUi('对方取消了文件传输：' + cur.name, -1);
            }
          }).catch((err) => {
            console.error('[AirDesk FileRecv] file:cancel error:', err);
          });
        }
        return;
      }

      const rawChunk = ev.data;
      incomingFileWriteChain = incomingFileWriteChain.then(async () => {
        const cur = activeIncomingFile;
        if (!cur) return;
        let u8 = null;
        if (rawChunk instanceof ArrayBuffer) {
          u8 = new Uint8Array(rawChunk);
        } else if (rawChunk && typeof rawChunk.arrayBuffer === 'function') {
          u8 = new Uint8Array(await rawChunk.arrayBuffer());
        } else if (ArrayBuffer.isView(rawChunk)) {
          u8 = new Uint8Array(rawChunk.buffer, rawChunk.byteOffset, rawChunk.byteLength);
        }
        if (!u8) return;
        const res = await airdeskAPI.fileRecvChunk(cur.id, u8);
        if (!res || !res.ok) {
          activeIncomingFile = null;
          await airdeskAPI.fileRecvEnd(cur.id, false);
          updateFileTransferUi('接收失败：' + ((res && res.reason) || '分片写入失败'), -1);
          if (dc.readyState === 'open') {
            dc.send(JSON.stringify({ t: 'file:cancel', id: cur.id, reason: (res && res.reason) || 'write_error' }));
          }
          return;
        }
        cur.receivedBytes = res.receivedBytes;
        const nowTs = Date.now();
        if (nowTs - cur.lastUiAt >= 80 || cur.receivedBytes >= cur.expectedSize) {
          cur.lastUiAt = nowTs;
          updateFileTransferUi(
            '正在接收手机文件：' + cur.name + ' (' + formatFileBytes(cur.receivedBytes) + ' / ' + formatFileBytes(cur.expectedSize) + ')',
            cur.expectedSize > 0 ? cur.receivedBytes / cur.expectedSize : 1
          );
        }
      }).catch((err) => {
        console.error('[AirDesk FileRecv] chunk write error:', err);
      });
    };
  }

  function cleanupOnDisconnect() {
    rejectPendingOutgoingFileWaiters('连接已关闭');
    outgoingFileQueue.length = 0;
    outgoingFileBusy = false;
    const staleIncoming = activeIncomingFile;
    activeIncomingFile = null;
    if (staleIncoming && airdeskAPI.fileRecvEnd) {
      incomingFileWriteChain = incomingFileWriteChain
        .then(() => airdeskAPI.fileRecvEnd(staleIncoming.id, false))
        .catch(() => {});
    }
    updateFileTransferUi('等待建立 WebRTC 连接后可互传文件（单文件上限 500MB）', -1);
    if (fileDc) {
      fileDc.close();
      fileDc = null;
    }
  }

  return {
    updateFileTransferUi,
    appendFileTransferLog,
    enqueueFilesForMobile,
    attachFileTransferChannel,
    cleanupOnDisconnect,
  };
}
