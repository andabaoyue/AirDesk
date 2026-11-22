# Security Policy & Architecture Boundaries

## 安全模型概览

AirDesk 遵循**默认只读、按需授权、零云端留存画面**的安全原则：

1. **端到端加密传输**：音视频流与输入控制数据全部走 WebRTC（DTLS-SRTP + SCTP DataChannel）端到端加密；自建中继 `airdesk-relay-server` 仅转发信令握手报文，不解密、不存储屏幕画面或键鼠事件。
2. **默认只读与主进程权威状态**：任何客户端连接均需经过桌面端人工批准（或匹配 7 天有效期的 `sessionToken`）；即使开启远程操控，权限状态也严格由 Electron 主进程（`electron/main.cjs`）独立裁决，急停快捷键（`Ctrl/Cmd + Alt + Esc`）与物理鼠标接管可立即吊销远端控制权并强制释放所有已按下的键鼠状态。
3. **防爆破与访问隔离**：
   - 本地与公网配对房间均带 30 分钟配对码有效期、单房间连续 5 次错误自动轮换 6 位码及按 IP 限流；
   - `airdesk-relay-server` 支持 `RELAY_ACCESS_KEY` 建房门禁与 `/api/ice` 鉴权头（`X-AirDesk-Access-Key`）；`TRUST_PROXY` 默认关闭以防止伪造 `X-Forwarded-For` 绕过限流；
   - 局域网文件快传接口（`/api/lan-files/*`）仅允许已授权头凭证访问，不开启全局 `CORS: *`，并强制路径安全清洗、并发上限与字节完整性校验。
4. **Windows 可选 SYSTEM 提权服务边界**：
   - 默认以普通用户权限（`asInvoker`）运行；
   - 可选安装的后台服务（`AirDeskElevatedInput`）在独立命名管道 `\\.\pipe\AirDeskElevatedInput` 上启用 `PipeOptionFirstInstance`、拒绝网络访问、校验客户端进程属于当前活跃 Console Session，并校验由管理员安装时写入且仅 SYSTEM 与 Administrators 可读的 `C:\ProgramData\AirDesk\pipe.secret`。

## 已知能力边界

- **UAC / 安全桌面（Secure Desktop）**：未安装可选 SYSTEM 服务时，Electron 非管理员模式无法向 Windows UAC 提示框、任务管理器或锁屏界面注入输入；Electron `desktopCapturer` 在 Secure Desktop 切换期间按操作系统机制可能出现短暂黑屏或采集中断。
- **不引入虚拟显示器驱动（VDD）**：本项目不携带或安装内核级虚拟显示器驱动。

## 上报安全漏洞

如果你发现了安全漏洞（例如权限绕过、路径穿越、任意代码执行、信令越权等），请**不要**在公开 Issue 中直接披露可利用细节：

1. 可优先通过 GitHub Repository 的 **Security -> Advisories -> Report a vulnerability** 提交私密报告；
2. 若仓库暂未开启 Private Vulnerability Reporting，可先在 Issue 标题注明 `[SECURITY]` 请求私密联系方式（切勿在公开正文附上 PoC 或私钥）。

我们会在确认复现后尽快评估修复并同步发布安全更新。
