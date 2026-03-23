# Clawbot for All

Multi-tenant OpenClaw control plane with invite-only registration, per-user instance provisioning, WeChat QR pairing, and basic operations.

多租户 OpenClaw 管理台，支持邀请码注册、按用户创建实例、微信二维码绑定和基础运维。

## Readme

- 中文文档: [README.zh-CN.md](./README.zh-CN.md)
- English docs: [README.en.md](./README.en.md)

## Features

- Invite-only registration and user login
- Admin bootstrap from environment variables
- Forced password change on first admin login
- Per-user OpenClaw instance creation with provisioning progress
- Runner image with preinstalled WeChat plugin for immediate QR pairing
- WeChat QR pairing rendered directly in web UI
- Instance logs, model config, plugin config, gateway restart

## Quick Start

```bash
cp .env.example .env
npm run dev
```

Default URL:

- `http://127.0.0.1:4300`

## Environment

```bash
HOST=0.0.0.0
PORT=4300
SESSION_TTL_DAYS=14
PUBLIC_ORIGIN=http://127.0.0.1:4300
ADMIN_EMAIL=admin@example.com
ADMIN_NAME=平台管理员
ADMIN_PASSWORD=ChangeMe123!
OPENCLAW_RUNNER_IMAGE=ghcr.io/jimizhou/clawbot-openclaw-runner:latest
OPENCLAW_RUNNER_PULL_TIMEOUT_MS=600000
OPENCLAW_WECHAT_BIND_TIMEOUT_MS=600000
```

## Images and Release

GitHub Actions now publishes both images and writes tagged image references into GitHub Releases:

- Workflow: `.github/workflows/publish-images.yml`
- App image: `ghcr.io/<github-owner>/clawbot-for-all`
- Runner image: `ghcr.io/<github-owner>/clawbot-openclaw-runner`
- Tags: `latest`, branch name, git tag, and `sha-*`
- Runner image labels include `io.clawbot.openclaw.version` for OpenClaw version tracking
- Server logs are written to `data/logs/server.log` and can be viewed in the admin console

## Container Deployment

Use the included compose file:

```bash
docker compose up -d
```

Files:

- App Dockerfile: `./Dockerfile`
- Deployment template: `./compose.yaml`
- Admin console can inspect runner image cache, digest, and embedded OpenClaw version after startup
- Admin console can also inspect recent server logs without SSH access
