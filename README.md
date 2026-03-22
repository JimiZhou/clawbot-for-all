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
OPENCLAW_RUNNER_IMAGE=clawbot-openclaw-runner:local
OPENCLAW_WECHAT_BIND_TIMEOUT_MS=600000
```

## CI Image

GitHub Actions now builds the runner image automatically:

- Workflow: `.github/workflows/build-runner-image.yml`
- Registry: `ghcr.io/<github-owner>/clawbot-openclaw-runner`
- Tags: `latest`, branch name, git tag, and `sha-*`
