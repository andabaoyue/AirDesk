# 自建公网信令与中继指南 (`airdesk-relay-server`)

当你需要在**移动网络（4G/5G）或跨城市宽带**环境下远程连接桌面，且不希望使用 Tailscale / ZeroTier 异地组网时，可以在自己的云服务器上 3 分钟部署 `airdesk-relay-server`。

> **隐私说明**：中继服务器只转发配对审批和 SDP/ICE 信令包，屏幕画面和键鼠事件通过端到端加密的 WebRTC 传输，服务器无法查看屏幕内容。

---

## 1. 准备工作

- 一台拥有公网 IP 的 Linux VPS（1C1G 即可）
- 一个指向该服务器 IP 的域名（例如 `relay.example.com`，因为公网建议走 `https://` / `wss://`）
- 放行端口：`80` / `443`（HTTPS/WSS 反向代理）；若同时部署 `coturn` 中继，还需放行 `3478`（TCP/UDP）及 TURN 中继端口段（默认 `49152-65535/udp`）

---

## 2. 启动信令容器

```bash
git clone https://github.com/andabaoyue/AirDesk.git
cd AirDesk/airdesk-relay-server
cp .env.example .env
```

按需编辑 `docker-compose.yml` 或 `.env`：
- **强烈建议设置 `RELAY_ACCESS_KEY`**：填入一个强随机密钥。设置后只有知道该密钥的电脑端才能建房，陌生人无法白嫖你的信令服务器；同时 `/api/ice` 会要求请求头携带匹配的 `X-AirDesk-Access-Key`。
- 若经由 Caddy/Nginx 反向代理部署，建议设置 `TRUST_PROXY=true`，确保按真实客户端 IP 进行防爆破限流。

启动服务：

```bash
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:47820/health
```

---

## 3. 配置 HTTPS / WSS 反向代理（以 Caddy 为例）

Caddy 会自动申请并续期 Let's Encrypt 证书，且原生透传 WebSocket：

```caddyfile
relay.example.com {
    reverse_proxy 127.0.0.1:47820
}
```

若使用 Nginx，请确保为 `/ws/signaling` 配置 `proxy_http_version 1.1` 与 `Upgrade` / `Connection "upgrade"` 请求头。

---

## 4. 可选：部署 Coturn 中继兜底

大多数家庭宽带与手机 4G/5G 仅靠默认 `STUN_URLS` 即可直连 P2P；但如果公司内网处于严格对称 NAT（Symmetric NAT）导致 ICE 无法打洞，可取消 `docker-compose.yml` 中 `coturn` 段的注释并设置强 `TURN_SECRET`：

1. 将 `your-domain.com` 替换为你的域名；
2. 将两处 `replace-with-strong-random-secret` 替换为同一串长随机密码；
3. 重启 `docker compose up -d --build`。

服务端会在建房和批准连接时自动通过 HMAC-SHA1 生成有时效性的短期 TURN 凭证下发给双方，无需把静态密码写死在客户端。

---

## 5. 双端接入

1. **桌面被控端**：在「信令模式」中选择 **「自定义远程 WSS 信令」**，填写 `https://relay.example.com` 与你的 `RELAY_ACCESS_KEY`，点击「启动串流与配对」。
2. **Android 客户端**：在首页切换到 **「公网中继」** 标签页，填入 `https://relay.example.com` 与电脑显示的 6 位配对码即可跨网直连。
