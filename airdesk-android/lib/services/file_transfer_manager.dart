import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import '../models/airdesk_models.dart';
import 'native_bridge.dart';

class FileTransferManager {
  static const int _fileChunkBytes = 16384;
  static const int _maxFileBytes = 500 * 1024 * 1024;

  final void Function(String message) onToast;
  final void Function() onNotify;

  RTCDataChannel? _fileDc;
  bool _sendingFile = false;
  String? _pendingOfferId;
  Completer<void>? _pendingOfferCompleter;
  String? _pendingAckId;
  Completer<Map<String, dynamic>>? _pendingAckCompleter;
  String? _incomingFileId;
  String? _incomingFileName;
  String? _incomingFileMime;
  int _incomingFileTotal = 0;
  int _incomingFileReceived = 0;
  File? _incomingTempFile;
  IOSink? _incomingSink;
  DateTime _lastFileUiNotifyAt = DateTime.fromMillisecondsSinceEpoch(0);
  Future<void> _incomingFileChain = Future<void>.value();

  FileTransferProgress? activeFileTransfer;
  final List<FileTransferProgress> recentTransfers = [];

  FileTransferManager({
    required this.onToast,
    required this.onNotify,
  });

  bool get channelReady =>
      _fileDc != null && _fileDc!.state == RTCDataChannelState.RTCDataChannelOpen;

  void attachChannel(RTCDataChannel dc, {required bool Function() isStale}) {
    _fileDc = dc;
    dc.onDataChannelState = (state) {
      if (isStale()) return;
      if (state == RTCDataChannelState.RTCDataChannelClosed) {
        abortWaiters('文件传输通道已关闭');
      }
      onNotify();
    };
    dc.onMessage = (RTCDataChannelMessage message) {
      if (isStale()) return;
      _incomingFileChain = _incomingFileChain
          .then((_) => _handleFileDcMessage(message))
          .catchError((_) {});
    };
  }

  void _sendFileJson(Map<String, dynamic> obj) {
    final dc = _fileDc;
    if (dc != null && dc.state == RTCDataChannelState.RTCDataChannelOpen) {
      dc.send(RTCDataChannelMessage(jsonEncode(obj)));
    }
  }

  void abortWaiters(String reason) {
    if (_pendingOfferCompleter != null && !_pendingOfferCompleter!.isCompleted) {
      _pendingOfferCompleter!.completeError(StateError(reason));
    }
    _pendingOfferCompleter = null;
    _pendingOfferId = null;

    if (_pendingAckCompleter != null && !_pendingAckCompleter!.isCompleted) {
      _pendingAckCompleter!.completeError(StateError(reason));
    }
    _pendingAckCompleter = null;
    _pendingAckId = null;
  }

  void _recordTransferHistory(FileTransferProgress item) {
    recentTransfers.insert(0, item);
    if (recentTransfers.length > 8) {
      recentTransfers.removeRange(8, recentTransfers.length);
    }
  }

  Future<void> _closeIncomingTemp({bool deleteFile = true}) async {
    final sink = _incomingSink;
    _incomingSink = null;
    if (sink != null) {
      try {
        await sink.flush();
      } catch (_) {}
      try {
        await sink.close();
      } catch (_) {}
    }
    final tf = _incomingTempFile;
    _incomingTempFile = null;
    if (deleteFile && tf != null) {
      try {
        if (await tf.exists()) await tf.delete();
      } catch (_) {}
    }
    _incomingFileId = null;
    _incomingFileName = null;
    _incomingFileMime = null;
    _incomingFileTotal = 0;
    _incomingFileReceived = 0;
  }

  Future<void> _deleteTempFileSilently(String path) async {
    try {
      final f = File(path);
      if (await f.exists()) await f.delete();
    } catch (_) {}
  }

  Future<void> sendLocalFile(PickedLocalFile file) async {
    if (!channelReady) {
      await _deleteTempFileSilently(file.path);
      onToast('文件传输通道尚未就绪，请先建立连接');
      return;
    }
    if (_sendingFile) {
      await _deleteTempFileSilently(file.path);
      onToast('当前正在发送文件，请等待完成');
      return;
    }
    if (file.size > _maxFileBytes) {
      await _deleteTempFileSilently(file.path);
      onToast('文件过大，单文件上限为 500MB');
      return;
    }

    _sendingFile = true;
    final transferId = 'mob_${DateTime.now().millisecondsSinceEpoch}';
    var progressItem = FileTransferProgress(
      id: transferId,
      name: file.name,
      totalBytes: file.size,
      transferredBytes: 0,
      isOutgoing: true,
      state: FileTransferState.negotiating,
      message: '等待电脑确认接收...',
    );
    activeFileTransfer = progressItem;
    onNotify();

    try {
      final offerCompleter = Completer<void>();
      _pendingOfferId = transferId;
      _pendingOfferCompleter = offerCompleter;

      _sendFileJson({
        't': 'file:offer',
        'id': transferId,
        'name': file.name,
        'size': file.size,
        'mime': file.mime,
      });

      await offerCompleter.future.timeout(
        const Duration(seconds: 10),
        onTimeout: () => throw TimeoutException('电脑端响应超时'),
      );

      progressItem = progressItem.copyWith(
        state: FileTransferState.transferring,
        message: '正在发送至电脑...',
      );
      activeFileTransfer = progressItem;
      onNotify();

      var sentBytes = 0;
      var chunkCounter = 0;
      var lastUiMs = 0;
      final srcFile = File(file.path);
      await for (final data in srcFile.openRead()) {
        final u8 = data is Uint8List ? data : Uint8List.fromList(data);
        var offset = 0;
        while (offset < u8.length) {
          if (!channelReady) {
            throw StateError('文件传输通道已断开');
          }
          final end = (offset + _fileChunkBytes <= u8.length)
              ? offset + _fileChunkBytes
              : u8.length;
          final slice = Uint8List.sublistView(u8, offset, end);
          await _fileDc!.send(RTCDataChannelMessage.fromBinary(slice));
          offset = end;
          sentBytes += slice.length;
          chunkCounter++;

          if (chunkCounter % 8 == 0) {
            try {
              var buffered = await _fileDc!.getBufferedAmount();
              while (buffered > 524288 && channelReady) {
                await Future<void>.delayed(const Duration(milliseconds: 15));
                buffered = await _fileDc!.getBufferedAmount();
              }
            } catch (_) {}
          }

          final nowMs = DateTime.now().millisecondsSinceEpoch;
          if (nowMs - lastUiMs >= 90 || sentBytes >= file.size) {
            lastUiMs = nowMs;
            progressItem = progressItem.copyWith(
              transferredBytes: sentBytes,
              message: '发送中...',
            );
            activeFileTransfer = progressItem;
            onNotify();
          }
        }
      }

      progressItem = progressItem.copyWith(
        transferredBytes: sentBytes,
        state: FileTransferState.finalizing,
        message: '等待电脑落盘确认...',
      );
      activeFileTransfer = progressItem;
      onNotify();

      final ackCompleter = Completer<Map<String, dynamic>>();
      _pendingAckId = transferId;
      _pendingAckCompleter = ackCompleter;
      _sendFileJson({'t': 'file:done', 'id': transferId, 'bytes': sentBytes});

      final ack = await ackCompleter.future.timeout(
        const Duration(seconds: 15),
        onTimeout: () => throw TimeoutException('等待电脑落盘确认超时'),
      );

      final savedName = (ack['savedName'] ?? file.name).toString();
      final savedPath = (ack['savedPath'] ?? '下载/AirDesk/$savedName').toString();
      final doneItem = progressItem.copyWith(
        transferredBytes: file.size,
        state: FileTransferState.completed,
        message: '已保存到电脑',
        savedPath: savedPath,
      );
      activeFileTransfer = null;
      _recordTransferHistory(doneItem);
      onToast('已发送到电脑：$savedName');
    } catch (e) {
      _sendFileJson({'t': 'file:cancel', 'id': transferId, 'reason': e.toString()});
      final failItem = progressItem.copyWith(
        state: FileTransferState.failed,
        message: e.toString(),
      );
      activeFileTransfer = null;
      _recordTransferHistory(failItem);
      onToast('发送失败：$e');
    } finally {
      _sendingFile = false;
      _pendingOfferId = null;
      _pendingOfferCompleter = null;
      _pendingAckId = null;
      _pendingAckCompleter = null;
      try {
        final f = File(file.path);
        if (await f.exists()) await f.delete();
      } catch (_) {}
      onNotify();
    }
  }

  Future<void> _handleFileDcMessage(RTCDataChannelMessage message) async {
    if (!message.isBinary) {
      Map<String, dynamic> d;
      try {
        d = jsonDecode(message.text) as Map<String, dynamic>;
      } catch (_) {
        return;
      }
      final t = (d['t'] ?? '').toString();
      final id = (d['id'] ?? '').toString();

      if (t == 'file:accept') {
        if (_pendingOfferId == id &&
            _pendingOfferCompleter != null &&
            !_pendingOfferCompleter!.isCompleted) {
          _pendingOfferCompleter!.complete();
        }
        return;
      }
      if (t == 'file:reject') {
        if (_pendingOfferId == id &&
            _pendingOfferCompleter != null &&
            !_pendingOfferCompleter!.isCompleted) {
          _pendingOfferCompleter!.completeError(
            StateError((d['reason'] ?? '电脑拒绝接收').toString()),
          );
        }
        return;
      }
      if (t == 'file:ack') {
        if (_pendingAckId == id &&
            _pendingAckCompleter != null &&
            !_pendingAckCompleter!.isCompleted) {
          if (d['ok'] == false) {
            _pendingAckCompleter!.completeError(
              StateError((d['message'] ?? '保存失败').toString()),
            );
          } else {
            _pendingAckCompleter!.complete(d);
          }
        }
        return;
      }
      if (t == 'file:cancel') {
        if (_incomingFileId != null && (id.isEmpty || id == _incomingFileId)) {
          final cancelledName = _incomingFileName ?? '文件';
          await _closeIncomingTemp(deleteFile: true);
          activeFileTransfer = null;
          onToast('对方取消了传输：$cancelledName');
          onNotify();
        }
        return;
      }
      if (t == 'file:offer') {
        final size = (d['size'] as num?)?.toInt() ?? 0;
        final name = (d['name'] ?? 'airdesk-file.bin').toString();
        final mime = (d['mime'] ?? 'application/octet-stream').toString();
        if (_incomingFileId != null) {
          _sendFileJson({'t': 'file:reject', 'id': id, 'reason': '手机正在接收另一个文件'});
          return;
        }
        if (size < 0 || size > _maxFileBytes) {
          _sendFileJson({'t': 'file:reject', 'id': id, 'reason': '文件大小超出 500MB 上限'});
          return;
        }
        try {
          final tempFile = File(
            '${Directory.systemTemp.path}/airdesk_rx_${DateTime.now().millisecondsSinceEpoch}.part',
          );
          _incomingSink = tempFile.openWrite();
          _incomingTempFile = tempFile;
          _incomingFileId = id;
          _incomingFileName = name;
          _incomingFileMime = mime;
          _incomingFileTotal = size;
          _incomingFileReceived = 0;
          activeFileTransfer = FileTransferProgress(
            id: id,
            name: name,
            totalBytes: size,
            transferredBytes: 0,
            isOutgoing: false,
            state: FileTransferState.transferring,
            message: '正在接收来自电脑的文件...',
          );
          onNotify();
          _sendFileJson({'t': 'file:accept', 'id': id});
        } catch (e) {
          await _closeIncomingTemp(deleteFile: true);
          _sendFileJson({'t': 'file:reject', 'id': id, 'reason': e.toString()});
        }
        return;
      }
      if (t == 'file:done') {
        if (_incomingFileId != id || _incomingTempFile == null) return;
        final fileName = _incomingFileName ?? 'airdesk-file.bin';
        final mime = _incomingFileMime ?? 'application/octet-stream';
        final total = _incomingFileTotal;
        final received = _incomingFileReceived;
        final declaredDone = (d['bytes'] as num?)?.toInt() ?? total;
        final tempFile = _incomingTempFile!;
        final sink = _incomingSink;
        _incomingSink = null;
        if (sink != null) {
          try {
            await sink.flush();
            await sink.close();
          } catch (_) {}
        }
        if (received != total || received != declaredDone) {
          await _closeIncomingTemp(deleteFile: true);
          final failItem = FileTransferProgress(
            id: id,
            name: fileName,
            totalBytes: total,
            transferredBytes: received,
            isOutgoing: false,
            state: FileTransferState.failed,
            message: '接收文件字节数不完整 ($received/$total)',
          );
          activeFileTransfer = null;
          _recordTransferHistory(failItem);
          _sendFileJson({
            't': 'file:ack',
            'id': id,
            'ok': false,
            'message': '接收文件字节数不完整',
          });
          onToast('接收文件失败：分片不完整');
          onNotify();
          return;
        }
        activeFileTransfer = activeFileTransfer?.copyWith(
          state: FileTransferState.finalizing,
          message: '正在保存到 Download/AirDesk...',
        );
        onNotify();

        final saved = await NativeBridge.saveFileToDownloads(
          tempPath: tempFile.path,
          fileName: fileName,
          mimeType: mime,
        );
        await _closeIncomingTemp(deleteFile: !saved.ok);
        if (saved.ok) {
          final doneItem = FileTransferProgress(
            id: id,
            name: saved.savedName,
            totalBytes: total,
            transferredBytes: total,
            isOutgoing: false,
            state: FileTransferState.completed,
            message: '已保存',
            savedPath: saved.displayPath,
          );
          activeFileTransfer = null;
          _recordTransferHistory(doneItem);
          _sendFileJson({
            't': 'file:ack',
            'id': id,
            'ok': true,
            'savedName': saved.savedName,
            'savedPath': saved.displayPath,
          });
          onToast('已保存文件到 ${saved.displayPath}');
        } else {
          final failItem = FileTransferProgress(
            id: id,
            name: fileName,
            totalBytes: total,
            transferredBytes: 0,
            isOutgoing: false,
            state: FileTransferState.failed,
            message: saved.error ?? '保存失败',
          );
          activeFileTransfer = null;
          _recordTransferHistory(failItem);
          _sendFileJson({
            't': 'file:ack',
            'id': id,
            'ok': false,
            'message': saved.error ?? '保存失败',
          });
          onToast('保存文件失败：${saved.error}');
        }
        onNotify();
      }
      return;
    }

    if (_incomingFileId == null || _incomingSink == null) return;
    final bytes = message.binary;
    if (_incomingFileReceived + bytes.length > _maxFileBytes) {
      final badId = _incomingFileId!;
      await _closeIncomingTemp(deleteFile: true);
      activeFileTransfer = null;
      _sendFileJson({'t': 'file:cancel', 'id': badId, 'reason': '超出大小限制'});
      onNotify();
      return;
    }
    _incomingSink!.add(bytes);
    _incomingFileReceived += bytes.length;
    final now = DateTime.now();
    if (now.difference(_lastFileUiNotifyAt).inMilliseconds >= 90 ||
        _incomingFileReceived >= _incomingFileTotal) {
      _lastFileUiNotifyAt = now;
      activeFileTransfer = activeFileTransfer?.copyWith(
        transferredBytes: _incomingFileReceived,
        message: '接收中...',
      );
      onNotify();
    }
  }

  Future<void> cleanup() async {
    abortWaiters('WebRTC 连接已重置');
    await _closeIncomingTemp(deleteFile: true);
    activeFileTransfer = null;
    try {
      await _fileDc?.close();
    } catch (_) {}
    _fileDc = null;
  }
}
