# Clawbot for All

多租户 OpenClaw 管理台，支持按用户创建实例、预装微信插件、后台镜像预热、服务日志查看，以及基于 GHCR 的镜像部署。发布镜像支持 `linux/amd64` 和 `linux/arm64`。

Multi-tenant OpenClaw control plane with per-user instances, preinstalled WeChat plugin, background runner-image warmup, server log viewing, and GHCR-based deployment. Published images support `linux/amd64` and `linux/arm64`.

## 1. 功能列表

### 中文

- 邀请码注册、管理员初始化、首次登录强制改密
- 每个用户独享一个 OpenClaw 实例
- Runner 镜像预装微信插件，创建实例后可直接拉起二维码绑定
- Server 启动后后台预热 runner 镜像，不阻塞服务启动
- 管理员后台可查看 runner 镜像状态、服务日志、实例状态和模型预设
- 实例容器支持通过环境变量限制 CPU 和内存，便于单机部署多个实例
- App / Runner 镜像通过 GitHub Actions 发布到 GHCR
- 发布镜像支持 `linux/amd64` 与 `linux/arm64`
- Runner 镜像默认钉死已验证组合：`openclaw@2026.3.13` + `@tencent-weixin/openclaw-weixin@1.0.3`

### English

- Invite-only registration, admin bootstrap, and forced password change on first login
- One dedicated OpenClaw instance per user
- Runner image ships with the WeChat plugin preinstalled for immediate QR pairing
- Server warms the runner image in the background after startup without blocking HTTP boot
- Admin console can inspect runner image status, server logs, instance state, and model presets
- Per-instance container CPU and memory limits can be configured with environment variables
- App and runner images are published to GHCR via GitHub Actions
- Published images support both `linux/amd64` and `linux/arm64`
- The runner image is pinned to a verified pairing: `openclaw@2026.3.13` + `@tencent-weixin/openclaw-weixin@1.0.3`

## 2. 如何快速 Docker 部署

### 中文

1. 准备目录：

```bash
mkdir -p /opt/clawbot-for-all
cd /opt/clawbot-for-all
```

2. 写入 `compose.yaml`：

```yaml
services:
  clawbot:
    image: ghcr.io/jimizhou/clawbot-for-all:latest
    container_name: clawbot-for-all
    restart: unless-stopped
    ports:
      - "4300:4300"
    environment:
      HOST: 0.0.0.0
      PORT: 4300
      SESSION_TTL_DAYS: 14
      PUBLIC_ORIGIN: https://your-domain.example
      ADMIN_EMAIL: admin@example.com
      ADMIN_NAME: 平台管理员
      ADMIN_PASSWORD: ChangeMe123!
      OPENCLAW_RUNNER_IMAGE: ghcr.io/jimizhou/clawbot-openclaw-runner:latest
      OPENCLAW_RUNNER_PULL_TIMEOUT_MS: 600000
      OPENCLAW_RUNNER_CPUS: "1.0"
      OPENCLAW_RUNNER_MEMORY: 1g
      OPENCLAW_WECHAT_BIND_TIMEOUT_MS: 600000
    volumes:
      - ./data:/app/data
      - /var/run/docker.sock:/var/run/docker.sock
```

3. 启动：

```bash
docker compose up -d
```

4. 查看服务日志：

```bash
docker logs -f clawbot-for-all
```

说明：

- `OPENCLAW_RUNNER_CPUS`：限制每个实例容器可用 CPU，例如 `0.5`、`1.0`、`2`
- `OPENCLAW_RUNNER_MEMORY`：限制每个实例容器内存，例如 `512m`、`1g`、`2g`
- 当前 `latest` runner 镜像应内置已验证版本组合：`openclaw@2026.3.13` + `@tencent-weixin/openclaw-weixin@1.0.3`
- 业务数据和 server 日志保存在 `./data`
- server 日志文件路径为 `./data/logs/server.log`
- 应用容器必须挂载 `/var/run/docker.sock`
- 如果 GHCR 包已公开，VPS 无需额外登录即可拉镜像

### English

1. Prepare a deployment directory:

```bash
mkdir -p /opt/clawbot-for-all
cd /opt/clawbot-for-all
```

2. Create `compose.yaml`:

```yaml
services:
  clawbot:
    image: ghcr.io/jimizhou/clawbot-for-all:latest
    container_name: clawbot-for-all
    restart: unless-stopped
    ports:
      - "4300:4300"
    environment:
      HOST: 0.0.0.0
      PORT: 4300
      SESSION_TTL_DAYS: 14
      PUBLIC_ORIGIN: https://your-domain.example
      ADMIN_EMAIL: admin@example.com
      ADMIN_NAME: Platform Admin
      ADMIN_PASSWORD: ChangeMe123!
      OPENCLAW_RUNNER_IMAGE: ghcr.io/jimizhou/clawbot-openclaw-runner:latest
      OPENCLAW_RUNNER_PULL_TIMEOUT_MS: 600000
      OPENCLAW_RUNNER_CPUS: "1.0"
      OPENCLAW_RUNNER_MEMORY: 1g
      OPENCLAW_WECHAT_BIND_TIMEOUT_MS: 600000
    volumes:
      - ./data:/app/data
      - /var/run/docker.sock:/var/run/docker.sock
```

3. Start the service:

```bash
docker compose up -d
```

4. Follow logs:

```bash
docker logs -f clawbot-for-all
```

Notes:

- `OPENCLAW_RUNNER_CPUS` limits CPU per instance container, for example `0.5`, `1.0`, or `2`
- `OPENCLAW_RUNNER_MEMORY` limits memory per instance container, for example `512m`, `1g`, or `2g`
- The current `latest` runner image is expected to ship with the verified pairing `openclaw@2026.3.13` + `@tencent-weixin/openclaw-weixin@1.0.3`
- App data and server logs are stored under `./data`
- Server log file path is `./data/logs/server.log`
- The app container must mount `/var/run/docker.sock`
- If the GHCR packages are public, the VPS can pull images anonymously

## 3. 本地开发步骤

### 中文

1. 安装依赖：

```bash
npm install
```

2. 复制环境变量：

```bash
cp .env.example .env
```

3. 启动开发服务：

```bash
npm run dev
```

4. 访问：

```text
http://127.0.0.1:4300
```

本地开发要求：

- Node.js 22+
- Docker Desktop / Docker Engine
- 当前机器允许执行 `docker pull`、`docker run`、`docker rm`、`docker exec`、`docker logs`

### English

1. Install dependencies:

```bash
npm install
```

2. Copy environment variables:

```bash
cp .env.example .env
```

3. Start the dev server:

```bash
npm run dev
```

4. Open:

```text
http://127.0.0.1:4300
```

Local development requirements:

- Node.js 22+
- Docker Desktop or Docker Engine
- The host machine must be allowed to run `docker pull`, `docker run`, `docker rm`, `docker exec`, and `docker logs`

## 4. License

MIT

## 5. 感谢

[LinuxDo社区](https://linux.do/)
