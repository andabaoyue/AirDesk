# AirDesk Relay Server (`airdesk-relay-server`)

轻量、零数据库、开源自托管的 AirDesk 公网 WebSocket 信令与 STUN/TURN 凭证下发服务，用于在不安装 Tailscale/ZeroTier 的情况下实现跨公网（4G/5G ↔ 家庭/公司宽带）远程桌面直连与穿透。

> **隐私边界**：本服务仅转发 6 位配对码审批消息、SDP/ICE 协商包与短期免密凭证；音视频流与键鼠控制指令均通过端到端加密的 WebRTC（DTLS-SRTP / SCTP）传输，信令服务器本身看不到屏幕画面。

---

## 快速启动

### 方式 A：Node.js 直接运行（Node 18+）

```bash
npm install
PORT=47820 npm start
```

运行测试：

```bash
npm test
```

### 方式 B：Docker Compose 部署

```bash
docker compose up -d --build
```

生产环境请配合 **Caddy** 或 **Nginx** 开启 HTTPS/WSS 反向代理（将 `https://relay.example.com` 的 `/ws/signaling` 转发至本服务的 `47820` 端口）。

Caddy 示例（自动申请 HTTPS 证书）：

```caddyfile
relay.example.com {
    reverse_proxy 127.0.0.1:47820
}
```

---

## 环境变量说明

| 变量名 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `47820` | HTTP + WebSocket 监听端口 |
| `HOST` | `0.0.0.0` | 监听网卡地址 |
| `RELAY_ACCESS_KEY` | 空（不限制） | 填写后，仅携带匹配 `accessKey` 的电脑端可创建房间；同时请求 `GET /api/ice` 需附带请求头 `X-AirDesk-Access-Key` |
| `TRUST_PROXY` | `false` | 仅当部署在可信反向代理（如 Caddy / Nginx）后时设为 `true`，用于读取 `X-Forwarded-For` 做真实源 IP 防爆破限流 |
| `STUN_URLS` | `stun:stun.miwifi.com:3478,stun:stun.l.google.com:19302` | 逗号分隔 STUN 服务器列表 |
| `TURN_URLS` | 空 | 逗号分隔 TURN 中继地址（如 `turn:relay.example.com:3478`） |
| `TURN_SECRET` | 空 | `coturn` 共享密钥（配合 `--use-auth-secret` 动态签发短期 HMAC-SHA1 凭证） |
| `TURN_TTL_SEC` | `86400` | 动态 TURN 凭证有效期（秒） |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | 空 | 静态 TURN 用户名与密码（未设 `TURN_SECRET` 时生效） |

---

## 与 AirDesk 桌面端 & Android 端对接

1. **电脑端（AirDesk Desktop Host ≥ v0.5.7）**：
   - 信令模式选择 **「自定义远程 WSS 信令」**，填写 `https://relay.example.com`（若设置了 `RELAY_ACCESS_KEY`，一并填入密钥框）。
   - 点击 **「启动串流与配对」** 获取 6 位配对码。
2. **手机端（AirDesk Android ≥ v0.6.7）**：
   - 在首页 **「公网中继远程连接（WSS + STUN/TURN）」** 卡片填入 `https://relay.example.com` 与 6 位配对码即可跨网连接；首次批准后支持 7 天免密一键重连。
