# Changelog

所有重要版本变更都会记录在本文件中。

## [v0.8.3] - 2026-11-22

### 稳定性修复
- **Electron 退出 `write EPIPE` 崩溃修复**：为 `process.stdout`、`process.stderr` 与原生输入 Helper 的 `stdin`/`stdout`/`stderr` 流统一注册 `error` 事件防线，`sendToHelper()` 补充流可写/未销毁检查与异步错误回调，并在 `will-quit` 时先优雅 `stdin.end()` 后延时兜底结束子进程，彻底消除退出时的 `Uncaught Exception: Error: write EPIPE` 弹窗。

## [v0.8.2] - 2026-11-22

### 安全与稳定性加固
- **Windows 提权服务 Fail-Closed（P0）**：`win-elevated-service.cs` 与 Electron 连接侧在 `pipe.secret` 缺失或长度不足时一律拒绝接入；管道首行认证新增 3 秒超时断连防占坑 DoS；校验接入进程镜像路径；`SupervisorLoop` 新增限频文件日志与错误退避。
- **Windows 输入助手性能与兼容升级（P1）**：`WH_MOUSE_LL` 回调移除同步 stdout 阻塞，改为无锁信号与独立后台线程异步派发，退出时显式卸载钩子；升级 `Per-Monitor DPI Aware v2` 与虚拟桌面 bounds 缓存；通过 `MapVirtualKey` 填充硬件扫描码并校验 `SendInput` 返回值。
- **Android 局域网文件流控与生命周期优化（P1）**：`LanFileService` 改为 `addStream` 背压流式上传/下载，新增 `25s` 空闲超时、`LanFileCancelToken` 取消令牌与显式 `deleteSourceOnFinish` 控制；`RemoteStagePage` 后台释放硬件锁、前台切回主动探活并在超时时自动重连，视频/准星/HUD 包裹 `RepaintBoundary` 隔离重绘。
- **中继服务端生产默认加固（P2）**：`docker-compose.yml` 默认绑定 `127.0.0.1:47820:47820`、启用 `read_only` / `cap_drop: [ALL]` / `no-new-privileges` 与日志轮转；`server.mjs` 在未配置 `RELAY_ACCESS_KEY` 启动时输出安全警告，并自动清理超 75 秒失活的僵尸 WebSocket 连接。

## [v0.8.1] - 2026-11-22

### 安全与稳定性修复
- **内置信令房间注册防伪造**：桌面端 `/ws/signaling` 处理 `host:create` 时校验本机回环地址或主进程随机内部凭证（`localHostToken`），拦截局域网外部客户端伪造房间。
- **局域网文件上传流背压加固**：`/api/lan-files/upload` 增加 `drainPending` 保护的 `req.pause()` / `wsOut.once('drain')` 背压流控。
- **WebRTC 文件接收与断连状态加固**：`incomingFileWriteChain` 补齐异常 `.catch(...)` 恢复兜底；`pc.onconnectionstatechange` 增加 `currentPc` 实例比对及 `disconnected` `2.5s` 宽限自动恢复窗口。
- **macOS 原生 Helper 与打包修复**：`mac-input-helper.swift` 启动关闭 stdout 块缓冲（`setbuf(stdout, nil)`）；Electron Helper `spawn` 绑定 `error` 监听；`package.json` 补充 macOS `extendInfo` 权限声明与 `--publish never`，`release.yml` 补充 `fail-fast: false` 与 `CSC_IDENTITY_AUTO_DISCOVERY: false`。
- **Android 临时媒体流回收**：`webrtc_session_service.dart` 在 `onTrack` 降级创建本地 `MediaStream` 时追踪并在 `_cleanupRtc()` 中显式 `dispose()`。

## [v0.8.0-beta.1] - 2026-11-22

首个面向 GitHub 开源社区的公测基线版本（桌面端 `v0.5.15` · Android 端 `v0.7.5` · 公网中继 `v1.0.0`）。

### 核心功能
- **三链路接入**：内置局域网/手机热点/USB（`47820`）发现与信令服务、Tailscale/ZeroTier 异地组网直连、以及独立零数据库 Docker 公网中继服务（`airdesk-relay-server`）。
- **低延迟视频与渲染**：H.264（`42e01f`）与可选 H.265/HEVC 协商、自适应 `contentHint` 软编探测回退、强制 `playout-delay` RTP 扩展（`min=0, max=0`）、Android 真无边框沉浸横屏与 0%–100% 自适应无裁切填充、串流期间自动抑制 Windows 窗口缩放过渡动画减少残影。
- **操控与文件互传**：直接触控 / 笔记本触控板（含本地即时准星）双模式、外接键鼠 `Pointer Capture` 透传、急停释放全按键、7 天免密设备管理、按需桌面音频同步、双向 WebRTC `file-transfer` 通道（最高 500MB）与局域网 HTTP 快传。

### 安全性与工程化加固
- 补全并审计三端安全边界：中继 `/api/ice` 鉴权、`TRUST_PROXY` 开关、防跨房 PIN 轮换 DoS、本地与公网重连竞态隔离、Electron IPC 严格源校验、局域网文件快传并发/路径/CORS 限制、Windows SYSTEM 服务 `pipe.secret` 与 Console Session 校验。
- 添加 MIT `LICENSE`、`SECURITY.md`、`CONTRIBUTING.md`、结构化 Bug/Feature Issue 模板以及 GitHub Actions CI/Release 流水线。
