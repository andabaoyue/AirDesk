# Contributing to AirDesk

欢迎任何形式的贡献，包括 Bug 修复、低延迟与编解码优化、多品牌设备兼容报告、文档完善与翻译。

## 仓库结构

- `airdesk-desktop-host/` — Electron 桌面被控端 + Windows/macOS 原生输入 Helper
- `airdesk-android/` — Flutter + 原生 Kotlin Android 控制端
- `airdesk-relay-server/` — 独立 Node.js WSS 公网信令与 STUN/TURN 凭证中继
- `docs/` — 架构、部署与排障文档

## 架构约定（提交 PR 前请先阅读）

1. **不引入虚拟显示器驱动（VDD）**：本项目明确定位为轻量跨端串流，不接受捆绑或安装第三方/自研 VDD 的 PR。
2. **诚实标注实测边界**：涉及编码器兼容、帧率上限、平台权限差异的功能或文案，不得隐藏已知系统限制。
3. **跨端协议一致**：任何修改 `ctrl-reliable`、`input-unreliable`、`file-transfer` 或 WebSocket 信令字段的变更，必须同步检查并更新 `airdesk-desktop-host`（含内置 Web PWA）、`airdesk-android` 与 `airdesk-relay-server`。
4. **严禁提交敏感凭证与产物**：请勿将 `*.jks`、`key.properties`、`.env`、`*.apk`、`*.exe`、`trusted-tokens.json` 或个人 IP/主机名提交进仓库。

## 本地验证命令

提交 PR 前请在对应子目录运行校验：

```bash
# 1. 公网中继服务（6 项端到端冒烟测试）
cd airdesk-relay-server
npm test

# 2. 桌面被控端（JS 语法校验 + 原生 Helper 编译）
cd airdesk-desktop-host
npm test
npm run prebuild:win   # macOS 运行 npm run prebuild:mac

# 3. Android 客户端（静态分析 + 单测）
cd airdesk-android
flutter pub get
flutter analyze
flutter test
```

## 提交流程

1. Fork 本仓库并从 `main` 创建特性分支（如 `feat/xxx` 或 `fix/xxx`）。
2. 完成代码修改与本地验证。
3. 提交 Pull Request 并按照 PR 模板填写改动范围、验证情况与相关截图/日志。
