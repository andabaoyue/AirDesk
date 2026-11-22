# AirDesk 迭代更新路线图 (Roadmap)

| 阶段 | 版本目标 | 状态 | 核心内容 |
| --- | --- | --- | --- |
| **P0：底层加固** | `v0.2.x` | ✅ 已完成 | `asarUnpack`、多屏 DPI/Retina 坐标映射、WebRTC 资源释放与 ICE 队列、Win/Mac 原生输入 Helper |
| **P1：桌面效率与本地直连** | `v0.3.x ~ v0.4.x` | ✅ 已完成 | 6 组全局快捷键 + 系统托盘常驻 + 内置本地信令（`47820` 热点扫码直连） + 物理鼠标接管优先 |
| **P2：低延迟画质与安全闭环** | `v0.5.x` | ✅ 已完成 | `ZeroPlayoutDelay`、H.264/HEVC 协商、自适应 `contentHint`、双向文件传输、按需桌面音频、可选 SYSTEM 提权服务、串流期窗口动画抑制与安全审计加固 |
| **P3：Android 原生控制端** | `v0.7.x` | ✅ 已完成 | Flutter + Kotlin 真无边框全屏、`MediaCodec` 硬解与 120Hz 触控板准星、USB/热点网卡枚举、外接键鼠 `Pointer Capture`、调试 HUD 与文件安全落盘 |
| **P4：GitHub 开源公测** | `v0.8.0-beta.1` | 🚧 当前阶段 | MIT 开源、Issue/Bug 反馈区、CI/Release 自动化流水线、收集社区跨网络（公网中继/多显卡/多机型）实测反馈 |
| **P5：正式稳定版** | `v1.0.0` | 📋 规划中 | 基于社区实测完成多端兼容性打磨、公网中继大规模稳定性验证、正式签名发布与国际化（EN/ZH）完善 |

> 详细架构与排障说明见仓库文档：[docs/architecture.md](../docs/architecture.md) · [docs/self-hosting.md](../docs/self-hosting.md) · [docs/troubleshooting.md](../docs/troubleshooting.md)
