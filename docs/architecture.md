# AirDesk 架构与协议说明

## 1. 整体分层

AirDesk 由三个独立子工程协作构成，媒体与键鼠控制通道全部点对点加密传输：

1. **`airdesk-desktop-host`（桌面被控端）**
   - **主进程 (`electron/main.cjs`)**：负责窗口生命周期、安全策略、内置本地 HTTP/WS/UDP（`47820`）信令服务、局域网文件快传 API（`/api/lan-files/*`）、信任设备 Token 持久化、多屏坐标映射（Windows `dipToScreenPoint` / macOS 逻辑点），以及向原生 Helper 注入输入。
   - **Preload 网桥 (`electron/preload.cjs`)**：在 `contextIsolation: true`、`sandbox: true` 下暴露冻结的 `window.airdeskAPI` 白名单，分离高频单向指针通道（`ipcRenderer.send`）与可靠控制通道（`ipcRenderer.invoke`）。
   - **渲染进程 (`renderer/host.js`)**：通过 `desktopCapturer` + `getUserMedia` 采集屏幕与系统音频，管理 WebRTC `RTCPeerConnection`、动态比特率/帧率策略、硬件/软件编码器探测与 3 个 DataChannel 调度。
   - **原生输入 Helper (`native/`)**：Windows（`win-input-helper.cs` / 可选 SYSTEM 服务 `win-elevated-service.cs`）与 macOS（`mac-input-helper.swift`），负责执行操作系统级鼠标键盘注入、物理鼠标接管检测与串流期窗口动画抑制。
2. **`airdesk-android`（Android 控制端）**
   - **Flutter 业务与交互层 (`lib/`)**：负责 UDP 局域网/USB 发现、WebRTC 会话状态机、全屏视频渲染（`_computeVideoRect` 单一真值反算点击坐标）、直接触控 / 触控板（含本地即时准星）/ 自由缩放手势、虚拟键盘与双向文件传输。
   - **原生 Kotlin 层 (`android/app/.../MainActivity.kt`, `QrScanActivity.kt`)**：自定义 `NetworkMonitor.NetworkChangeDetectorFactory` 直接枚举系统网卡（解决系统 `ConnectivityManager` 遗漏热点/USB 网卡问题，并在纯局域网直连时屏蔽蜂窝网与公网 IPv6）；接入外接鼠标 `requestPointerCapture()`；通过 Camera2 + ZXing 实现零第三方冗余 SDK 扫码；通过 MediaStore/SAF 安全存取文件。
3. **`airdesk-relay-server`（可选公网中继）**
   - 无数据库 Node.js + `ws` 服务，负责 `host:create`、`client:join`、审批转发、7 天免密重连校验与 `rtc:offer` / `rtc:answer` / `rtc:ice` 透传，支持 `/api/ice` 与动态 HMAC-SHA1 `coturn` 凭证签发。

## 2. WebRTC 多通道约定

| 通道名 / 类型 | 传输特性 | 承载消息 |
| :--- | :--- | :--- |
| **Video Track** | `RecvOnly` (Android) / `SendOnly` (PC) | H.264 (`42e01f` 优先) 或可选 H.265/HEVC；协商 `playout-delay` RTP 扩展降低抖动缓冲 |
| **Audio Track** | 按需协商（默认关闭） | 桌面音频流；开关时通过 `ui:config` / `audio:set` 触发无感免密重连 |
| **`ctrl-reliable`** | `ordered: true` | `m:btn`、`k:down`/`k:up`/`k:release_all`、`text:unicode`、`sys:sas`、`perm`、`policy`、`displays:list`、`clip:*`、`diag:*`、`video:pli` |
| **`input-unreliable`** | `ordered: false, maxRetransmits: 0` | 高频相对移动 `m:rel`、拖拽移动 `m:abs`、滚轮 `m:whl`、电脑端回传光标校准 `cursor:pos` |
| **`file-transfer`** | `ordered: true` + 16KB 分片背压 | `file:offer` / `file:accept` / `file:reject` / 二进制分片 / `file:done` / `file:ack` / `file:cancel` |

## 3. 多屏与混合 DPI 坐标一致性

桌面端统一以目标显示器的边界归一化 `[0, 1]` 与移动端通信：
- 移动端在 `_computeVideoRect` 内将触点位置逆变换回归一化 `(x, y)`，再在直触点击抬手时通过 `ctrl-reliable` 严格按 `m:abs -> m:btn(down) -> m:btn(up)` 顺序发出，避免跨通道乱序错点。
- Windows 主进程先将归一化坐标还原为目标显示器 DIP 坐标，再调用 `screen.dipToScreenPoint()` 转为物理虚拟桌面像素发送给 `SendInput(..., MOUSEEVENTF_VIRTUALDESK)`；macOS 则直接传入逻辑 DIP 点给 `CGEvent`。
