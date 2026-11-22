# AirDesk Desktop Host (`airdesk-desktop-host` · v0.5.15)

面向开源社区的跨端低延迟屏幕串流与远程操控桌面端（Electron + Windows/macOS 原生输入 Helper + 内置本地信令 `47820` 与移动端 PWA）。

## 核心特性

- **6 组全局快捷键（隐藏到系统托盘仍可用）**：
  - `Ctrl / Cmd + Alt + S`：一键启动 / 停止屏幕串流与配对
  - `Ctrl / Cmd + Alt + M`：多显示器循环切换当前共享屏幕
  - `Ctrl / Cmd + Alt + L`：一键切换「允许操控 / 仅观看（只读）」
  - `Ctrl / Cmd + Alt + Y / N`：收到连接请求时快速批准 / 拒绝
  - `Ctrl / Cmd + Alt + Esc`：物理急停（立刻断权 + 释放所有键鼠状态）
- **内置本地局域网/热点信令服务（端口 `47820`）**：启动即挂载本地 HTTP + WebSocket 信令、UDP 局域网发现广播、局域网 HTTP 文件快传、二维码配对与移动端 PWA 兜底网页。
- **低延迟 WebRTC 管线**：强制协商 `playout-delay` RTP 扩展、`WebRTC-VideoRateControl` 高突发 Pacer、自动硬编/软编探测回退、可选 H.265/HEVC 协商、按需桌面音频重协商、空闲自动降帧与串流期 Windows 窗口缩放动画自动抑制。
- **纵深安全与可选 SYSTEM 提权服务**：主进程权威裁决权限、混合 DPI/Retina 坐标精确映射、7 天可信设备列表管理与一键吊销；另提供可选安装的 `NT AUTHORITY\SYSTEM` 后台输入服务（支持 UAC 弹窗、锁屏操作与 `Ctrl+Alt+Del` SAS）。

## 本地运行

```bash
npm install
npm run prebuild:win   # macOS 请执行 npm run prebuild:mac
npm start
```

## 打包独立安装包

```bash
# Windows（自动先运行 prebuild:win 编译原生 Helper，再产出 NSIS 安装包）
npm run build:win

# macOS（自动先运行 prebuild:mac 用 swiftc -O 编译原生 Helper，再产出 DMG）
npm run build:mac
```

## 系统权限与防火墙说明

- **Windows 防火墙（热点/局域网直连必看）**：手机个人热点常被 Windows 识别为「公用网络」。可通过界面上的「一键放行端口 47820」写入 TCP/UDP `47820` 入站放行规则。
- **Windows UIPI 权限边界**：默认以 `asInvoker` 普通用户权限运行；需要操作 UAC/管理员窗口或锁屏桌面时，可在「设备与快捷键」页可选安装后台提权服务。
- **macOS 隐私授权**：首次运行需在「系统设置 → 隐私与安全性」授予 **屏幕录制** 与 **辅助功能** 权限。
- 更多架构与排查细节请见 [ROADMAP.md](ROADMAP.md) 与 [../docs/troubleshooting.md](../docs/troubleshooting.md)。
