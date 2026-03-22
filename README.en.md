# Clawbot for All

A multi-tenant OpenClaw control plane covering the full lifecycle from account onboarding to instance operations:

- Invite-only user registration, login, and password change
- Admin bootstrap from environment variables with forced password reset on first login
- Admin-generated invite codes and invite links
- Per-user OpenClaw instance creation with live provisioning progress
- Automatic model API / key injection for each instance
- Docker-based runtime provisioning
- WeChat onboarding executed inside each user's container, with QR code rendered directly in the web UI
- Instance logs, plugin configuration, and gateway restart

## Quick Start

```bash
cp .env.example .env
npm run dev
```

Default access:

- Local: `http://127.0.0.1:4300`
- LAN: `http://<server-lan-ip>:4300`

## Environment Variables

```bash
HOST=0.0.0.0
PORT=4300
SESSION_TTL_DAYS=14
PUBLIC_ORIGIN=http://127.0.0.1:4300
ADMIN_EMAIL=admin@example.com
ADMIN_NAME=Platform Admin
ADMIN_PASSWORD=ChangeMe123!
OPENCLAW_RUNNER_IMAGE=clawbot-openclaw-runner:local
OPENCLAW_WECHAT_BIND_TIMEOUT_MS=600000
```

Notes:

- `ADMIN_EMAIL` / `ADMIN_NAME` / `ADMIN_PASSWORD`
  are used to bootstrap the first admin account
- If the admin email already exists, the service will still enforce `role=admin`
- Newly created admin users get `mustChangePassword=true`
- `PUBLIC_ORIGIN` is used to generate invite registration links

## Requirements

- Node.js 22+
- Docker Desktop / Docker Engine
- The current machine must be able to run:
  - `docker build`
  - `docker run`
  - `docker rm`
  - `docker exec`
  - `docker logs`

## Main Flows

### 1. Admin Bootstrap

At service startup, the app checks whether admin environment variables are configured.

- If the admin email does not exist, an admin account is created automatically
- The admin must change password on first login
- Invite management and instance operations are blocked until the password reset is completed

### 2. Invite-Based Registration

- Regular users must provide a valid invite code to register
- Admins can create invite codes directly from the web UI
- The system also generates invite links in the form `/?invite=<code>`

### 3. OpenClaw Instance Lifecycle

When a user creates an instance, the backend runs an async provisioning flow:

1. Create instance directories
2. Write `openclaw.json`
3. Start a dedicated container
4. Report provisioning progress back to the UI

After the instance becomes ready, the user can:

- Update model settings
- Update plugin settings
- View recent logs
- Restart the gateway
- Generate a WeChat pairing QR code

### 4. WeChat Pairing

When the user clicks "Generate WeChat QR code", the backend will:

1. Ensure the instance container is running
2. Enter the target OpenClaw container
3. Execute the WeChat integration command inside the container
4. Parse QR output from image URL, data URL, or ASCII QR
5. Render the QR code directly in the web UI
6. Read paired account files from the instance directory and display pairing metadata

## Data Layout

```text
data/
├── db.json
└── instances/
    └── <instanceId>/
        ├── home/
        │   ├── openclaw.json
        │   └── .openclaw/
        ├── logs/
        └── workspace/
```

Where:

- `data/db.json` stores users, sessions, invites, and instance metadata
- `data/instances/<instanceId>/home/openclaw.json`
  stores per-instance OpenClaw configuration
- `data/instances/<instanceId>/home/.openclaw/openclaw-weixin/accounts`
  stores paired WeChat account metadata

## Current Status

This is still an MVP built on local JSON storage and a native Node HTTP server, but it already covers the main product loop:

- multi-user onboarding
- multi-instance creation
- model config injection
- WeChat pairing and QR rendering
- basic instance operations

For production, the next logical steps are:

- replace JSON with a real database
- replace in-process async jobs with a task queue
- add audit logs
- add a finer-grained admin permission model
