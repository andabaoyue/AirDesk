# Changelog

所有重要版本变更都会记录在本文件中。

## [v0.10.0] - 2026-11-28

### 无人值守高熵 hostId 与 scrypt 密码鉴权（PR #1–#3）
- **持久化高熵 `hostId` 与 Host 端信任设备库**：桌面端生成并持久化高熵 `hostId`，由 Host 端自主维护信任设备列表（Trust Store），配合开机自启与中继指数退避重连，支持无人值守远程接入；多主机场景下按主机端点与 `hostId` 隔离存储 Relay 免密 Token。
- **无人值守密码鉴权与 `scrypt` 安全参数上限校验**：新增无人值守访问密码校验流程，Android 端对中继下发的 `scrypt` KDF 参数（`N`、`r`、`p`）实施合法性校验与工作因子上限拦截，防止异常参数导致客户端资源耗尽。
- **会话关闭槽位清理**：修复中继服务端在宿主机发送 `session:close` 时未及时清理房间客户端槽位并断开对端连接的问题。

### 桌面端空载低功耗与长时串流治理（PR #4、#5）
- **空载低功耗门控**：无远程会话期间自动门控休眠原生输入钩子、看门狗定时器与状态节流逻辑，修复屏幕采集泄漏并在 `handleOffer` 失败时清理主进程会话状态，显著降低待机 CPU/GPU 占用。
- **连接保活与长时串流防卡顿**：新增 WebSocket `ping/pong` 心跳看门狗与 ICE 参数调优；引入 WakeLock 定时刷新、WebRTC 丢帧保护、编解码参数去重与 ABR 迟滞窗口，缓解多小时连续串流后的渐进式卡顿。

### 音频无黑屏热切换与 WS/WebRTC 解耦（PR #5、#6）
- **音频无黑屏热切换**：支持在串流过程中实时开启或关闭桌面音频而无需销毁重建视频轨与 PeerConnection，彻底消除切换音频时的画面黑屏闪烁。
- **WS 信令与 WebRTC 媒体解耦 + 切网 `iceRestart`**：重构中继、桌面端与 Android 端的信令/媒体状态机，WebSocket 信令重连不再打断正在进行的 WebRTC 媒体流；网络切换时自动触发 `iceRestart` 无缝恢复连接，并修复 `HOST_OFFLINE` 重试计数在调度周期内丢失的问题。

### LAN/Relay 双模常驻、中继批量探活与 Android 设备簿（PR #7）
- **桌面端 LAN/Relay 双模常驻**：桌面主机同时保持局域网内置服务与公网中继信令在线，无需手动切换模式即可同时响应局域网直连与公网穿透请求；同步修复 `lan-server` 在 `session:close` 时清理活跃与待处理客户端槽位。
- **中继批量探活与 Android 多主机设备簿**：中继服务端新增批量主机在线探活接口；Android 端新增多主机设备簿管理多台电脑及免密状态，并引入 `500ms` Smart Route 智能路由择优，优先秒连低延迟局域网通道并在不可达时自动回落至公网中继。

## [v0.9.0] - 2026-11-24

### 音频通道、虚拟声卡与 UAC 安全桌面增强
- **Android 强制媒体音频通道 & 静音修复**：在 `MainActivity.kt` 锁定 `STREAM_MUSIC` 并新增 `ensureMediaAudioMode`（重置 `MODE_NORMAL` 与 `isSpeakerphoneOn = false`），在 `webrtc_session_service.dart` 追踪独立 `_remoteAudioTrack`，修复小米 HyperOS/MIUI 语音通话通道降质及静音按钮失效问题；SDP 注入 Opus 立体声与 `128kbps` 码率参数。
- **Windows CoreAudio 虚拟声卡路由与 UAC 检测恢复**：新增 `win-input-helper.cs` 枚举/切换系统默认音频设备与安全桌面检测，串流桌面音频期间可选自动切换至虚拟声卡静音本机并异常退出自动兜底恢复；UAC/锁屏期间自动通知控制端显示快捷响应横幅并在退出安全桌面后自动恢复采集。

### 性能、画质、显存与输入跟手度优化
- **待机按需懒采集与显存自动释放**：启动共享仅开启信令与二维码，收到 Offer 再按单飞锁按需拉起屏幕采集；断连保留 20 秒热重连窗口，超时自动释放全部音视频轨并停用 `powerSaveBlocker`；副屏热缓存缩短至 15 秒且最多缓存 1 块。
- **画质与编码优先级升级**：三端统一支持 H.264 Constrained High（`640c`）优先与网络场景分级码率策略，PC/Android 端同步展示实时码率（`<1000 kbps / Mbps`）、编码 Profile；Android 端视频纹理启用 `FilterQuality.medium`。
- **8ms 指针合并与紧凑输入协议**：Android 端合并 `m:abs` / `m:rel` / `m:whl` 高频指针事件并在点击前先冲刷缓冲；Windows 输入助手与提权服务协商 `compactProto`（`R`/`A`/`W` 单行文本指令）进一步降低高频输入开销。
- **收发双端遥测 AIMD 动态码率自愈**：结合发送端 `qualityLimitationReason`/编码耗时/RTT 与接收端掉帧/冻结/JitterBuffer，拥塞时 4 秒冷却快降至保底码率（CPU 瓶颈自动 60→30fps 降档），链路健康恢复后稳步回升，HUD 与诊断面板实时标记 `ABR`。

### 架构模块化整理与自动化测试
- **三端超长核心文件低风险拆分**：
  - Desktop 主进程：`electron/main.cjs` 拆出 `native-helper.cjs`、`virtual-audio.cjs`、`lan-server.cjs`、`web-client-template.cjs`、`input-router.cjs`；
  - Desktop 渲染进程：采用浏览器原生 ES Module，从 `renderer/host.js` 拆出 `sdp-codec.mjs`、`abr-controller.mjs`、`media-capture.mjs`、`file-transfer.mjs`；
  - Android 远程舞台：`remote_stage_page.dart` 拆出 `stage_video_layer.dart`、`stage_telemetry_hud.dart`、`stage_secure_desktop_banner.dart`、`stage_overlays.dart`，保持 `RepaintBoundary` 与局部刷新隔离。
- **打包与常驻测试体系**：`package.json` 显式纳入 `electron/modules/**/*` 与 `renderer/modules/**/*`，新增 Windows 便携版 `.zip` 打包目标；新增 `test/run-tests.mjs` 覆盖全仓 `.cjs`/`.mjs`/`host.js` 语法检查及 `sdp-codec` / `abr-controller` 单元测试。

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
