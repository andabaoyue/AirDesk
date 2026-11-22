## 改动说明
<!-- 简要说明本次 PR 解决的问题或新增的能力 -->

## 涉及模块
- [ ] `airdesk-desktop-host`（桌面端 / 原生 Helper / 内置 PWA）
- [ ] `airdesk-android`（Android Flutter + Kotlin）
- [ ] `airdesk-relay-server`（公网信令中继）
- [ ] 文档 / CI 配置

## 验证清单
- [ ] 已在修改的子模块中通过本地校验（`npm test` / `flutter analyze && flutter test`）
- [ ] 若涉及跨端信令或 DataChannel 字段，已同步桌面端、PWA 与 Android 端
- [ ] 已确认未包含个人 IP、签名密钥（`.jks` / `key.properties`）、构建产物或测试残留文件
- [ ] 遵守不引入 VDD 的架构边界
