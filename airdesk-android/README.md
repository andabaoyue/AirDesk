# AirDesk Android Client (`airdesk-android` · v0.7.5)

AirDesk 的独立 Android 控制端（Flutter + 原生 Kotlin Platform Channel），配合 `airdesk-desktop-host` 与可选 `airdesk-relay-server` 实现局域网 / 手机热点 / USB 有线 / Tailscale / 公网中继低延迟桌面串流与双向文件传输。

## 核心特性

- **真无边框沉浸式全屏**：`Edge-to-Edge` + `Immersive Sticky` + `SHORT_EDGES` 刘海屏适配 + 双面横屏（`SENSOR_LANDSCAPE`）+ 防误触二次返回退出。
- **硬件解码优先 + 强制低延迟 Playout**：SDP 优先协商 `H.264 (42e01f)` 与可选 `H.265/HEVC`，注入 `playout-delay` RTP 扩展并在突发掉帧时快速请求关键帧刷新；悬浮调试 HUD 实时展示双端编解码耗时、抖动缓冲与 RTT。
- **热点 / USB / 异地组网兼容网卡枚举**：原生 Kotlin 层直接枚举 OS 网络接口，兼容被 `ConnectivityManager` 忽略的 `wlan2`/`ap0`/`rndis0`，并在纯局域网直连时自动过滤蜂窝网与非异地 IPv6 干扰。
- **双触控模式与 120Hz 本地准星**：支持「直接触控」与「笔记本触控板（本地即时准星 + 电脑光标校准 + 快捷左右键 + 双指滚轮）」，支持外接实体鼠标 `Pointer Capture` 与外接键盘直传。
- **双向文件传输**：WebRTC `file-transfer` 通道（16KB 分片，最高 500MB）与局域网 HTTP 快传，文件安全落盘至 `Download/AirDesk`。

## 本地构建

环境要求：Flutter Stable（Dart SDK `>=3.8.0 <4.0.0`）、JDK 17、Android SDK。

```bash
flutter pub get
flutter analyze
flutter test
flutter build apk --release --split-per-abi --target-platform android-arm64
```

可选：如需使用自己的正式 Release 密钥签名，请复制 `android/key.properties.example` 为 `android/key.properties` 并填入本地 `.jks` 路径与口令（切勿将密钥或口令提交到 Git）。
