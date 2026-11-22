# Changelog

所有重要版本变更都会记录在本文件中。

## [v0.8.0-beta.1] - 2026-11-22

首个面向 GitHub 开源社区的公测基线版本（桌面端 `v0.5.15` · Android 端 `v0.7.5` · 公网中继 `v1.0.0`）。

### 核心功能
- **三链路接入**：内置局域网/手机热点/USB（`47820`）发现与信令服务、Tailscale/ZeroTier 异地组网直连、以及独立零数据库 Docker 公网中继服务（`airdesk-relay-server`）。
- **低延迟视频与渲染**：H.264（`42e01f`）与可选 H.265/HEVC 协商、自适应 `contentHint` 软编探测回退、强制 `playout-delay` RTP 扩展（`min=0, max=0`）、Android 真无边框沉浸横屏与 0%–100% 自适应无裁切填充、串流期间自动抑制 Windows 窗口缩放过渡动画减少残影。
- **操控与文件互传**：直接触控 / 笔记本触控板（含本地即时准星）双模式、外接键鼠 `Pointer Capture` 透传、急停释放全按键、7 天免密设备管理、按需桌面音频同步、双向 WebRTC `file-transfer` 通道（最高 500MB）与局域网 HTTP 快传。

### 安全性与工程化加固
- 补全并审计三端安全边界：中继 `/api/ice` 鉴权、`TRUST_PROXY` 开关、防跨房 PIN 轮换 DoS、本地与公网重连竞态隔离、Electron IPC 严格源校验、局域网文件快传并发/路径/CORS 限制、Windows SYSTEM 服务 `pipe.secret` 与 Console Session 校验。
- 添加 MIT `LICENSE`、`SECURITY.md`、`CONTRIBUTING.md`、结构化 Bug/Feature Issue 模板以及 GitHub Actions CI/Release 流水线。
