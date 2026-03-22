# Clawbot for All

一个面向多用户的 OpenClaw 管理台，覆盖从账号准入到实例运维的完整闭环：

- 邀请码注册、用户登录、用户修改密码
- 部署时注入管理员账号，首次登录强制改密
- 管理员创建邀请码 / 邀请链接
- 用户创建属于自己的 OpenClaw 实例，并查看创建进度
- 自动写入每个实例的模型 API / Key 配置
- 通过 Docker 拉起对应实例
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
OPENCLAW_RUNNER_IMAGE=clawbot-openclaw-runner:local
OPENCLAW_WECHAT_BIND_TIMEOUT_MS=600000
```

## CI 镜像构建

现在仓库已经带了自动构建 runner 镜像的 GitHub Actions：

- Workflow：`.github/workflows/build-runner-image.yml`
- 镜像仓库：`ghcr.io/<github-owner>/clawbot-openclaw-runner`
- 默认标签：`latest`、分支名、Git Tag、`sha-*`

部署时如果希望直接使用 CI 构建产物，可以把 `OPENCLAW_RUNNER_IMAGE`
改成对应的 GHCR 镜像地址。

说明：

- `ADMIN_EMAIL` / `ADMIN_NAME` / `ADMIN_PASSWORD`
  用于首次部署时初始化管理员账号
- 若该邮箱已存在，系统会确保其角色为 `admin`
- 新建管理员会自动带 `mustChangePassword=true`
- `PUBLIC_ORIGIN` 用于生成邀请码注册链接

## 运行要求

- Node.js 22+
- Docker Desktop / Docker Engine
- 允许当前机器执行：
  - `docker build`
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
3. 在容器内执行微信接入命令
4. 从命令输出中识别二维码图片 / data URL / ASCII 二维码
5. 将二维码直接展示到前端
6. 读取实例目录内保存的微信账号文件，展示已配对信息

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

## 当前实现说明

当前版本仍是本地 JSON 存储 + 原生 Node HTTP 服务的 MVP，但已经覆盖了完整业务闭环，适合先验证：

- 多用户准入
- 多实例创建
- 模型配置写入
- 微信绑定与二维码展示
- 基础实例运维

如果后续进入生产，建议继续补：

- 数据库替换 JSON 文件
- 任务队列替换进程内异步任务
- 审计日志
- 更细粒度的管理员权限模型
