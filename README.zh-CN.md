# Clawbot for All

一个面向多用户的 OpenClaw 管理台，覆盖从账号准入到实例运维的完整闭环：

- 邀请码注册、用户登录、用户修改密码
- 部署时注入管理员账号，首次登录强制改密
- 管理员创建邀请码 / 邀请链接
- 用户创建属于自己的 OpenClaw 实例，并查看创建进度
- 自动写入每个实例的模型 API / Key 配置
- 通过 Docker 拉起对应实例
- Runner 镜像预装微信插件，用户实例启动后可直接拉起二维码绑定
- 在用户实例容器内执行微信接入 CLI，并把二维码直接回传到前端
- 查看实例日志、配置插件、重启网关

## 快速启动

```bash
cp .env.example .env
npm run dev
```

默认访问：

- 本机：`http://127.0.0.1:4300`
- 局域网：`http://<服务器局域网IP>:4300`

## 环境变量

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

说明：

- `ADMIN_EMAIL` / `ADMIN_NAME` / `ADMIN_PASSWORD`
  用于首次部署时初始化管理员账号
- 若该邮箱已存在，系统会确保其角色为 `admin`
- 新建管理员会自动带 `mustChangePassword=true`
- `PUBLIC_ORIGIN` 用于生成邀请码注册链接
- `OPENCLAW_RUNNER_PULL_TIMEOUT_MS`
  用于控制 VPS 首次拉取 runner 镜像的最长等待时间

## 镜像发布

仓库内置了自动发布镜像和写入 Release 镜像地址的 GitHub Actions：

- Workflow：`.github/workflows/publish-images.yml`
- 应用镜像：`ghcr.io/<github-owner>/clawbot-for-all`
- Runner 镜像：`ghcr.io/<github-owner>/clawbot-openclaw-runner`
- 默认标签：`latest`、分支名、Git Tag、`sha-*`
- Runner 镜像额外写入 `io.clawbot.openclaw.version` 标签，便于在 VPS 和管理台核对 OpenClaw 版本
- Server 日志会落盘到 `data/logs/server.log`，并可在管理员后台直接查看
- 当推送 `v*` 标签时，会自动把对应镜像地址写入 GitHub Release

## 运行要求

- Node.js 22+
- Docker Desktop / Docker Engine
- 允许当前机器执行：
  - `docker pull`
  - `docker run`
  - `docker rm`
  - `docker exec`
  - `docker logs`

## 主要流程

### 1. 管理员初始化

服务启动时会检查环境变量中的管理员账号配置。

- 若管理员邮箱不存在，则自动创建管理员账号
- 管理员首次登录后必须修改密码
- 改密完成前，不允许进入邀请码和实例控制台

### 2. 邀请码注册

- 普通用户必须持有邀请码才能注册
- 管理员可在前端工作台创建邀请码
- 系统会生成可直接分发的邀请链接：`/?invite=<code>`

### 3. OpenClaw 实例生命周期

用户创建实例后，后端会异步执行：

1. 创建实例目录
2. 写入 `openclaw.json`
3. 拉起用户专属容器
4. 返回创建进度到前端

实例创建完成后，用户可继续执行：

- 更新模型配置
- 修改插件配置
- 查看最近日志
- 重启网关
- 生成微信绑定二维码

### 4. 微信绑定

点击前端“生成微信绑定二维码”后，后端会：

1. 确认该用户实例容器已运行
2. 进入对应 OpenClaw 容器
3. 检查并启用 runner 镜像内预装的微信插件
4. 在容器内直接执行微信接入命令
5. 从命令输出中识别二维码图片 / data URL / ASCII 二维码
6. 将二维码直接展示到前端
7. 读取实例目录内保存的微信账号文件，展示已配对信息

## 数据结构

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

其中：

- `data/db.json` 保存用户、会话、邀请码、实例元数据
- `data/instances/<instanceId>/home/openclaw.json`
  保存每个实例的独立 OpenClaw 配置
- `data/instances/<instanceId>/home/.openclaw/openclaw-weixin/accounts`
  保存微信配对账号信息

## 容器部署

项目已提供可直接审阅和使用的容器化部署文件：

- 应用 Dockerfile：`./Dockerfile`
- Compose 模板：`./compose.yaml`

启动方式：

```bash
docker compose up -d
```

部署要点：

- 应用容器需要挂载 `/var/run/docker.sock`，用于创建用户实例容器
- 业务数据存储在 `./data`
- 若使用公开镜像部署，`OPENCLAW_RUNNER_IMAGE` 默认已指向 GHCR runner 镜像
- 管理员可在后台“镜像管理”页查看 runner 镜像是否已预热、本地 digest 与内置 OpenClaw 版本
- 管理员可在后台“服务日志”页查看最近 server 日志，无需 SSH 上机排查
