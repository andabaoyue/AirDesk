import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'native_bridge.dart';

class LanRemoteFile {
  final String name;
  final int size;
  final int mtimeMs;

  const LanRemoteFile({
    required this.name,
    required this.size,
    required this.mtimeMs,
  });

  factory LanRemoteFile.fromJson(Map<String, dynamic> j) => LanRemoteFile(
        name: (j['name'] ?? '').toString(),
        size: (j['size'] as num?)?.toInt() ?? 0,
        mtimeMs: (j['mtimeMs'] as num?)?.toInt() ?? 0,
      );
}

class LanFileService {
  static void _attachAuthHeaders(HttpHeaders headers, String? token, String? pin) {
    if (token != null && token.trim().isNotEmpty) {
      headers.set('X-AirDesk-Token', token.trim());
    }
    if (pin != null && pin.trim().isNotEmpty) {
      headers.set('X-AirDesk-Pin', pin.trim());
    }
  }

  static Future<({bool ok, bool authRequired, List<LanRemoteFile> files, String? error})>
      listHostFiles({
    required String ip,
    required int port,
    String? token,
    String? pin,
  }) async {
    final client = HttpClient()..connectionTimeout = const Duration(seconds: 4);
    try {
      final req = await client.getUrl(Uri.parse('http://$ip:$port/api/lan-files/list'));
      _attachAuthHeaders(req.headers, token, pin);
      final res = await req.close().timeout(const Duration(seconds: 6));
      final body = await utf8.decoder.bind(res).join();
      final json = jsonDecode(body) as Map<String, dynamic>;
      if (res.statusCode == 401) {
        return (
          ok: false,
          authRequired: true,
          files: <LanRemoteFile>[],
          error: (json['error'] ?? '需要 6 位配对码').toString(),
        );
      }
      if (res.statusCode != 200 || json['ok'] != true) {
        return (
          ok: false,
          authRequired: false,
          files: <LanRemoteFile>[],
          error: (json['error'] ?? '获取列表失败 (${res.statusCode})').toString(),
        );
      }
      final files = (json['files'] as List<dynamic>? ?? const [])
          .whereType<Map<String, dynamic>>()
          .map(LanRemoteFile.fromJson)
          .where((f) => f.name.isNotEmpty)
          .toList();
      return (ok: true, authRequired: false, files: files, error: null);
    } catch (e) {
      return (
        ok: false,
        authRequired: false,
        files: <LanRemoteFile>[],
        error: e.toString(),
      );
    } finally {
      client.close(force: true);
    }
  }

  static Future<({bool ok, bool authRequired, String savedName, String? error})>
      uploadFile({
    required String ip,
    required int port,
    required PickedLocalFile file,
    String? token,
    String? pin,
    void Function(int sent, int total)? onProgress,
  }) async {
    final client = HttpClient()..connectionTimeout = const Duration(seconds: 5);
    try {
      final uri = Uri.parse(
        'http://$ip:$port/api/lan-files/upload?name=${Uri.encodeQueryComponent(file.name)}',
      );
      final req = await client.postUrl(uri);
      _attachAuthHeaders(req.headers, token, pin);
      req.headers.set(HttpHeaders.contentTypeHeader, 'application/octet-stream');
      if (file.size >= 0) {
        req.contentLength = file.size;
      }

      var sent = 0;
      var lastNotifyMs = 0;
      final src = File(file.path);
      await for (final chunk in src.openRead()) {
        req.add(chunk);
        sent += chunk.length;
        final nowMs = DateTime.now().millisecondsSinceEpoch;
        if (nowMs - lastNotifyMs >= 80 || sent >= file.size) {
          lastNotifyMs = nowMs;
          onProgress?.call(sent, file.size);
        }
      }

      final res = await req.close();
      final body = await utf8.decoder.bind(res).join();
      final json = jsonDecode(body) as Map<String, dynamic>;
      if (res.statusCode == 401) {
        return (
          ok: false,
          authRequired: true,
          savedName: file.name,
          error: (json['error'] ?? '需要 6 位配对码').toString(),
        );
      }
      if (res.statusCode != 200 || json['ok'] != true) {
        return (
          ok: false,
          authRequired: false,
          savedName: file.name,
          error: (json['error'] ?? '上传失败 (${res.statusCode})').toString(),
        );
      }
      return (
        ok: true,
        authRequired: false,
        savedName: (json['savedName'] ?? file.name).toString(),
        error: null,
      );
    } catch (e) {
      return (
        ok: false,
        authRequired: false,
        savedName: file.name,
        error: e.toString(),
      );
    } finally {
      client.close(force: true);
      try {
        final f = File(file.path);
        if (await f.exists()) await f.delete();
      } catch (_) {}
    }
  }

  static Future<({bool ok, bool authRequired, String displayPath, String? error})>
      downloadFile({
    required String ip,
    required int port,
    required String fileName,
    String? token,
    String? pin,
    void Function(int received, int total)? onProgress,
  }) async {
    final client = HttpClient()..connectionTimeout = const Duration(seconds: 5);
    final tempFile = File(
      '${Directory.systemTemp.path}/airdesk_lan_dl_${DateTime.now().millisecondsSinceEpoch}.part',
    );
    IOSink? sink;
    try {
      final uri = Uri.parse(
        'http://$ip:$port/api/lan-files/download?name=${Uri.encodeQueryComponent(fileName)}',
      );
      final req = await client.getUrl(uri);
      _attachAuthHeaders(req.headers, token, pin);
      final res = await req.close();
      if (res.statusCode == 401) {
        return (
          ok: false,
          authRequired: true,
          displayPath: '',
          error: '需要 6 位配对码',
        );
      }
      if (res.statusCode != 200) {
        return (
          ok: false,
          authRequired: false,
          displayPath: '',
          error: '下载失败 (${res.statusCode})',
        );
      }

      final total = res.contentLength > 0 ? res.contentLength : 0;
      sink = tempFile.openWrite();
      var received = 0;
      var lastNotifyMs = 0;
      await for (final chunk in res) {
        sink.add(chunk);
        received += chunk.length;
        final nowMs = DateTime.now().millisecondsSinceEpoch;
        if (nowMs - lastNotifyMs >= 80 || (total > 0 && received >= total)) {
          lastNotifyMs = nowMs;
          onProgress?.call(received, total);
        }
      }
      await sink.flush();
      await sink.close();
      sink = null;

      final saved = await NativeBridge.saveFileToDownloads(
        tempPath: tempFile.path,
        fileName: fileName,
      );
      if (!saved.ok) {
        return (
          ok: false,
          authRequired: false,
          displayPath: '',
          error: saved.error ?? '保存失败',
        );
      }
      return (
        ok: true,
        authRequired: false,
        displayPath: saved.displayPath,
        error: null,
      );
    } catch (e) {
      return (
        ok: false,
        authRequired: false,
        displayPath: '',
        error: e.toString(),
      );
    } finally {
      try {
        await sink?.close();
      } catch (_) {}
      try {
        if (await tempFile.exists()) await tempFile.delete();
      } catch (_) {}
      client.close(force: true);
    }
  }
}
