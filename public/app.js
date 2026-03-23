/* ── Constants ─────────────────────────────────────────── */

const MODEL_API_MODES = [
  "openai-responses",
  "openai-completions",
  "anthropic-messages",
  "google-generative-ai",
];

const LOG_TAIL_OPTIONS = [100, 200, 400, 800];

const DEFAULT_PLUGIN_TEMPLATE = {
  allow: [],
  entries: {
    "openclaw-weixin": {
      enabled: true,
    },
  },
};

/* ── State ────────────────────────────────────────────── */

const state = {
  user: null,
  instances: [],
  invites: [],
  adminUsers: [],
  adminInstances: [],
  runnerImage: null,
  serverLogs: {
    text: "",
    path: "",
    totalLines: 0,
    updatedAt: null,
    tail: 400,
  },
  logsByInstanceId: {},
  logTailByInstanceId: {},
  statsByInstanceId: {},
  flash: null,
  busyKey: "",
  adminTab: "instances",
  onboardStep: 1,
  onboardData: {},
  registerData: {},
  modelPresets: [],
  instanceTab: "run",
};

const app = document.querySelector("#app");
let pollingTimer = null;
let statsTimer = null;

/* ── Helpers ──────────────────────────────────────────── */

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function requestJson(url, options = {}) {
  return fetch(url, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  }).then(async (response) => {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || "请求失败");
      error.payload = payload;
      throw error;
    }
    return payload;
  });
}

function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatBytes(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num) || num <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let next = num;
  let index = 0;
  while (next >= 1024 && index < units.length - 1) {
    next /= 1024;
    index++;
  }
  return `${next.toFixed(next >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function toInputDatetime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function setFlash(message, tone = "info") {
  state.flash = { message, tone };
  render();
}

function setBusy(key) {
  state.busyKey = key;
  render();
}

function clearBusy() {
  state.busyKey = "";
  render();
}

function syncPasswordGate(error) {
  if (error?.payload?.requirePasswordChange && error.payload.user) {
    state.user = error.payload.user;
    state.instances = [];
    state.invites = [];
    updatePolling();
    navigate("#/change-password");
  }
}

async function copyText(text, successMessage) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    setFlash(successMessage);
    return;
  }
  setFlash(`请手动复制：${text}`);
}

function showToast(message, tone = "error") {
  const existing = document.querySelector(".toast-overlay");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.className = "toast-overlay";
  overlay.innerHTML = `<div class="toast toast-${tone}">
    <span class="toast-message">${escapeHtml(message)}</span>
    <button class="toast-close" type="button" aria-label="关闭通知">&times;</button>
  </div>`;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector(".toast-close").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  setTimeout(close, 5000);
}

/* ── Polling ──────────────────────────────────────────── */

function updatePolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }

  if (statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
  }

  const needsPolling =
    state.user &&
    !state.user.mustChangePassword &&
    state.instances.some(
      (i) =>
        i.provisioning?.status === "running" ||
        ["starting", "waiting_scan", "scanned"].includes(i.wechatBinding?.status),
    );

  if (needsPolling) {
    pollingTimer = setInterval(() => {
      loadInstances().catch(() => {});
    }, 3000);
  }

  const runningInstance = state.user && !state.user.mustChangePassword
    ? state.instances.find((i) => i.status === "running" && i.provisioning?.status === "ready")
    : null;

  if (runningInstance) {
    loadInstanceStats(runningInstance.id).catch(() => {});
    statsTimer = setInterval(() => {
      loadInstanceStats(runningInstance.id).then(() => {
        render();
      }).catch(() => {});
    }, 5000);
  }
}

/* ── Data loaders ─────────────────────────────────────── */

async function loadSession() {
  const payload = await requestJson("/api/session", { method: "GET" });
  state.user = payload.user;
}

async function loadInstances() {
  if (!state.user || state.user.mustChangePassword) {
    state.instances = [];
    updatePolling();
    return;
  }
  const payload = await requestJson("/api/instances", { method: "GET" });
  state.instances = payload.instances;
  updatePolling();
}

async function loadInvites() {
  if (!state.user || state.user.role !== "admin") {
    state.invites = [];
    return;
  }
  const payload = await requestJson("/api/invites", { method: "GET" });
  state.invites = payload.invites;
}

async function loadAdminUsers() {
  if (!state.user || state.user.role !== "admin") return;
  const payload = await requestJson("/api/admin/users", { method: "GET" });
  state.adminUsers = payload.users;
}

async function loadAdminInstances() {
  if (!state.user || state.user.role !== "admin") return;
  const payload = await requestJson("/api/admin/instances", { method: "GET" });
  state.adminInstances = payload.instances;
}

async function loadAdminRunnerImage() {
  if (!state.user || state.user.role !== "admin") return;
  const payload = await requestJson("/api/admin/runner-image", { method: "GET" });
  state.runnerImage = payload.image || null;
}

async function loadAdminServerLogs(tail = state.serverLogs?.tail || 400) {
  if (!state.user || state.user.role !== "admin") return;
  const payload = await requestJson(`/api/admin/server-logs?tail=${tail}`, { method: "GET" });
  state.serverLogs = payload.logs || {
    text: "",
    path: "",
    totalLines: 0,
    updatedAt: null,
    tail,
  };
}

async function loadLogs(instanceId, tail) {
  tail = tail || state.logTailByInstanceId[instanceId] || 200;
  state.logTailByInstanceId[instanceId] = tail;
  const payload = await requestJson(`/api/instances/${instanceId}/logs?tail=${tail}`, { method: "GET" });
  state.logsByInstanceId[instanceId] = payload.logs || "";
}

async function loadInstanceStats(instanceId) {
  const payload = await requestJson(`/api/instances/${instanceId}/stats`, { method: "GET" });
  state.statsByInstanceId[instanceId] = payload.stats || null;
}

async function loadModelPresets() {
  if (!state.user) { state.modelPresets = []; return; }
  const payload = await requestJson("/api/model-presets", { method: "GET" });
  state.modelPresets = payload.presets || [];
}

/* ── Router ───────────────────────────────────────────── */

function currentRoute() {
  return location.hash || (getInviteCode() ? "#/register" : "#/login");
}

function navigate(hash) {
  location.hash = hash;
}

function resolveRoute() {
  if (!state.user) return "#/login";
  if (state.user.mustChangePassword) return "#/change-password";
  if (state.user.role === "admin") return "#/admin";
  if (state.instances.length === 0) return "#/onboard";
  return "#/instance";
}

function autoNavigate() {
  navigate(resolveRoute());
}

/* ── Bootstrap ────────────────────────────────────────── */

async function bootstrap() {
  await loadSession();
  if (state.user && !state.user.mustChangePassword) {
    if (state.user.role === "admin") {
      const hash = currentRoute();
      if (hash === "#/admin" || hash.startsWith("#/admin")) {
        await Promise.all([loadAdminInstances(), loadAdminUsers(), loadInvites(), loadModelPresets(), loadAdminRunnerImage(), loadAdminServerLogs()]);
      }
    } else {
      await loadInstances();
    }
  }
  const hash = currentRoute();
  if (hash === "#/login" || hash === "#/register") {
    if (state.user) {
      autoNavigate();
      return;
    }
  }
  if (state.user && !state.user.mustChangePassword && state.user.role !== "admin") {
    if (hash !== "#/instance" && hash !== "#/onboard" && hash !== "#/change-password") {
      autoNavigate();
      return;
    }
  }
  render();
}

/* ── ASCII QR to SVG ──────────────────────────────────── */

function asciiQrToSvgDataUrl(ascii) {
  const lines = ascii.split("\n").filter((l) => l.trim());
  if (!lines.length) return "";
  const height = lines.length;
  const width = Math.max(...lines.map((l) => l.length));
  let rects = "";
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < (lines[y]?.length || 0); x++) {
      const ch = lines[y][x];
      if (ch === "\u2588" || ch === "#") {
        rects += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
      }
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges"><rect width="${width}" height="${height}" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

/* ── Tone helpers ─────────────────────────────────────── */

function instanceTone(instance) {
  const p = instance.provisioning?.status || "ready";
  if (p === "error") return "danger";
  if (p === "running") return "accent";
  if (instance.status === "running") return "good";
  if (instance.status === "stopped") return "muted";
  return "accent";
}

function bindingTone(binding) {
  if (!binding) return "muted";
  if (binding.status === "connected") return "good";
  if (binding.status === "error") return "danger";
  if (["starting", "waiting_scan", "scanned"].includes(binding.status)) return "accent";
  return "muted";
}

function runnerImageTone(image) {
  if (!image) return "muted";
  if (image.status === "ready") return "good";
  if (image.status === "pulling") return "accent";
  if (image.status === "error") return "danger";
  if (image.status === "missing") return "warn";
  return "muted";
}

function inviteLifecycle(invite) {
  if (invite.revoked) return { label: "已停用", tone: "muted" };
  if (invite.expiresAt && new Date(invite.expiresAt).getTime() <= Date.now()) return { label: "已过期", tone: "warn" };
  if ((invite.uses || 0) >= (invite.maxUses || 1)) return { label: "已用尽", tone: "warn" };
  return { label: "可分发", tone: "good" };
}

function statusBadge(label, tone = "muted") {
  return `<span class="badge badge-${tone}">${escapeHtml(label)}</span>`;
}

/* ── Shared layout fragments ──────────────────────────── */

function flashMarkup() {
  if (!state.flash) return "";
  return `<div class="flash flash-${state.flash.tone}">${escapeHtml(state.flash.message)}<button class="flash-close" type="button" aria-label="关闭提示" data-action="dismiss-flash">&times;</button></div>`;
}

function navBar(items = [], right = "") {
  return `
    <nav class="navbar">
      <button class="navbar-brand-group" type="button" data-action="nav-home">
        <span class="navbar-brand-kicker">OpenClaw Launcher</span>
        <span class="navbar-brand">Clawbot for All</span>
      </button>
      <div class="navbar-items">${items.map((i) => `<button class="navbar-item ${i.active ? "active" : ""}" data-action="${i.action}">${escapeHtml(i.label)}</button>`).join("")}</div>
      <div class="navbar-right">${right}</div>
    </nav>`;
}

function userDropdown() {
  return `<div class="user-dropdown">
    <button class="user-dropdown-trigger" type="button" data-action="toggle-user-menu" aria-haspopup="menu" aria-expanded="false" aria-controls="user-menu">
      <span class="user-name">${escapeHtml(state.user?.name || "")}</span>
      <span class="user-dropdown-arrow">&#9662;</span>
    </button>
    <div class="user-dropdown-menu" id="user-menu" role="menu">
      <a class="user-dropdown-item" href="#/change-password">修改密码</a>
      <button class="user-dropdown-item" type="button" data-action="logout">退出登录</button>
    </div>
  </div>`;
}

function pageHero({ eyebrow = "", title = "", description = "" }) {
  return `
    <section class="page-hero">
      ${eyebrow ? `<span class="page-hero-eyebrow">${escapeHtml(eyebrow)}</span>` : ""}
      <h1 class="page-hero-title">${escapeHtml(title)}</h1>
      ${description ? `<p class="page-hero-desc">${escapeHtml(description)}</p>` : ""}
    </section>`;
}

/* ═══════════════════════════════════════════════════════
   VIEW: Login (#/login)
   ═══════════════════════════════════════════════════════ */

function loginView() {
  return `
    <div class="auth-layout">
      <div class="auth-card">
        <span class="auth-eyebrow">多租户控制台</span>
        <h1 class="auth-title">登录 Clawbot for All</h1>
        <p class="auth-sub">一个入口，统一管理实例启动、模型配置和微信绑定流程。</p>
        <form class="form-stack" data-form="login">
          <label class="form-label">邮箱<input class="form-input" required type="email" name="email" autocomplete="email" inputmode="email" placeholder="team@example.com" /></label>
          <label class="form-label">密码<input class="form-input" required type="password" name="password" autocomplete="current-password" placeholder="请输入密码" /></label>
          <button class="btn btn-primary" type="submit">${state.busyKey === "login" ? "登录中..." : "登录"}</button>
        </form>
        <p class="auth-alt">还没有账号？<a href="#/register">使用邀请码注册</a></p>
      </div>
    </div>`;
}

/* ═══════════════════════════════════════════════════════
   VIEW: Register (#/register)
   ═══════════════════════════════════════════════════════ */

function getInviteCode() {
  return new URLSearchParams(window.location.search).get("invite") || "";
}

function registerView() {
  const invitePrefill = getInviteCode() || state.registerData.inviteCode || "";
  const hasInvite = Boolean(getInviteCode());
  const rd = state.registerData;
  return `
    <div class="auth-layout">
      <div class="auth-card">
        <span class="auth-eyebrow">${hasInvite ? "邀请码注册" : "新用户注册"}</span>
        <h1 class="auth-title">${hasInvite ? "欢迎加入 Clawbot for All" : "注册新账号"}</h1>
        ${hasInvite ? `<p class="auth-sub">你已收到邀请，填写以下信息即可完成注册并开始使用。</p>` : ""}
        <form class="form-stack" data-form="register">
          ${hasInvite
            ? `<input type="hidden" name="inviteCode" value="${escapeHtml(invitePrefill)}" />`
            : `<label class="form-label">邀请码<input class="form-input" required name="inviteCode" autocomplete="off" autocapitalize="off" spellcheck="false" value="${escapeHtml(rd.inviteCode || "")}" /></label>`
          }
          <label class="form-label">昵称<input class="form-input" required name="name" autocomplete="nickname" value="${escapeHtml(rd.name || "")}" /></label>
          <label class="form-label">邮箱<input class="form-input" required type="email" name="email" autocomplete="email" inputmode="email" value="${escapeHtml(rd.email || "")}" /></label>
          <div class="form-row">
            <label class="form-label password-hint-wrap">密码<input class="form-input" required type="password" name="password" autocomplete="new-password" value="${escapeHtml(rd.password || "")}" /><span class="password-hint">至少 8 个字符</span></label>
            <label class="form-label">确认密码<input class="form-input" required type="password" name="confirmPassword" autocomplete="new-password" value="${escapeHtml(rd.confirmPassword || "")}" /></label>
          </div>
          <button class="btn btn-primary" type="submit">${state.busyKey === "register" ? "注册中..." : (hasInvite ? "完成注册" : "注册")}</button>
        </form>
        <p class="auth-alt">已有账号？<a href="#/login">返回登录</a></p>
      </div>
    </div>`;
}

/* ═══════════════════════════════════════════════════════
   VIEW: Change Password (#/change-password)
   ═══════════════════════════════════════════════════════ */

function settingsPasswordView() {
  return `
    ${navBar([], userDropdown())}
    <div class="page-body">
      <div class="onboard-layout">
        <div class="card">
          <span class="section-kicker">账号安全</span>
          <h3 class="card-title">修改密码</h3>
          <p class="section-note">更新后会立即作用到当前账号，建议使用包含大小写和数字的高强度密码。</p>
          <form class="form-stack" data-form="change-password">
            <label class="form-label">当前密码<input class="form-input" required name="currentPassword" type="password" autocomplete="current-password" /></label>
            <div class="form-row">
              <label class="form-label password-hint-wrap">新密码<input class="form-input" required name="newPassword" type="password" autocomplete="new-password" /><span class="password-hint">至少 8 个字符</span></label>
              <label class="form-label">确认新密码<input class="form-input" required name="confirmNewPassword" type="password" autocomplete="new-password" /></label>
            </div>
            <div class="form-actions">
              <button class="btn btn-ghost" type="button" data-action="nav-home">返回</button>
              <button class="btn btn-primary" type="submit">${state.busyKey === "change-password" ? "保存中..." : "更新密码"}</button>
            </div>
          </form>
        </div>
      </div>
    </div>`;
}

/* ═══════════════════════════════════════════════════════
   VIEW: Change Password - forced (#/change-password, mustChangePassword)
   ═══════════════════════════════════════════════════════ */

function changePasswordView() {
  return `
    <div class="auth-layout">
      <div class="auth-card">
        <span class="auth-eyebrow">首次登录</span>
        <h1 class="auth-title">修改密码</h1>
        <p class="auth-sub">首次登录需要修改默认密码后才能继续。</p>
        <form class="form-stack" data-form="change-password">
          <label class="form-label">当前密码<input class="form-input" name="currentPassword" type="password" autocomplete="current-password" placeholder="首次改密可留空" /></label>
          <div class="form-row">
            <label class="form-label">新密码<input class="form-input" required name="newPassword" type="password" autocomplete="new-password" placeholder="至少 8 位" /></label>
            <label class="form-label">确认新密码<input class="form-input" required name="confirmNewPassword" type="password" autocomplete="new-password" placeholder="再次输入" /></label>
          </div>
          <button class="btn btn-primary" type="submit">${state.busyKey === "change-password" ? "保存中..." : "完成改密"}</button>
        </form>
        <button class="btn btn-ghost" data-action="logout">退出登录</button>
      </div>
    </div>`;
}

/* ═══════════════════════════════════════════════════════
   VIEW: Admin Dashboard (#/admin)
   ═══════════════════════════════════════════════════════ */

function adminView() {
  const tabs = [
    { label: "实例总览", action: "admin-tab-instances", active: state.adminTab === "instances" },
    { label: "镜像管理", action: "admin-tab-images", active: state.adminTab === "images" },
    { label: "服务日志", action: "admin-tab-server-logs", active: state.adminTab === "server-logs" },
    { label: "用户管理", action: "admin-tab-users", active: state.adminTab === "users" },
    { label: "邀请码", action: "admin-tab-invites", active: state.adminTab === "invites" },
    { label: "模型预设", action: "admin-tab-presets", active: state.adminTab === "presets" },
  ];

  const runningCount = state.adminInstances.filter((i) => i.status === "running").length;
  const activeInvites = state.invites.filter((i) => inviteLifecycle(i).tone === "good").length;

  return `
    ${navBar(tabs, userDropdown())}
    <div class="page-body">
      ${pageHero({
        eyebrow: "管理员视图",
        title: "租户、邀请码与模型预设总览",
        description: "集中处理多租户实例分发、运行状态和引导配置，减少重复维护成本。",
      })}
      <div class="stats-row">
        <div class="stat-card"><div class="stat-value">${state.adminUsers.length}</div><div class="stat-label">用户数</div></div>
        <div class="stat-card"><div class="stat-value">${state.adminInstances.length}</div><div class="stat-label">实例数</div></div>
        <div class="stat-card"><div class="stat-value">${runningCount}</div><div class="stat-label">运行中</div></div>
        <div class="stat-card"><div class="stat-value">${activeInvites}</div><div class="stat-label">可用邀请码</div></div>
      </div>
      ${state.adminTab === "instances" ? adminInstancesTab() : ""}
      ${state.adminTab === "images" ? adminImagesTab() : ""}
      ${state.adminTab === "server-logs" ? adminServerLogsTab() : ""}
      ${state.adminTab === "users" ? adminUsersTab() : ""}
      ${state.adminTab === "invites" ? adminInvitesTab() : ""}
      ${state.adminTab === "presets" ? adminPresetsTab() : ""}
    </div>`;
}

function adminInstancesTab() {
  if (!state.adminInstances.length) {
    return `<div class="card"><p class="empty-text">暂无实例。</p></div>`;
  }

  return `
    <div class="card">
      <div class="card-header">
        <div>
          <h3 class="card-title">实例总览</h3>
          <p class="section-note">快速查看每个租户实例的运行状态、模型配置和微信绑定情况。</p>
        </div>
      </div>
      <div class="table-wrap">
      <table class="table">
        <thead><tr>
          <th>实例名</th><th>所属用户</th><th>状态</th><th>端口</th><th>模型</th><th>CPU</th><th>内存</th><th>微信</th>
        </tr></thead>
        <tbody>
          ${state.adminInstances.map((i) => {
            const pairedCount = i.wechatBinding?.pairedAccounts?.length || 0;
            return `<tr>
              <td>${escapeHtml(i.name)}</td>
              <td>${escapeHtml(i.userName)}</td>
              <td>${statusBadge(i.status, instanceTone(i))}</td>
              <td>${i.port}</td>
              <td>${i.model ? `${escapeHtml(i.model.providerId)}/${escapeHtml(i.model.modelId)}` : `<span class="text-muted">未配置</span>`}</td>
              <td>${i.stats ? escapeHtml(i.stats.cpuPercent) : "—"}</td>
              <td>${i.stats ? escapeHtml(i.stats.memUsage) : "—"}</td>
              <td>${pairedCount > 0 ? statusBadge(`${pairedCount} 已配对`, "good") : statusBadge("未配对", "muted")}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
      </div>
    </div>`;
}

function adminImagesTab() {
  const image = state.runnerImage;
  const labels = image?.labels || {};
  const digest = image?.repoDigests?.[0] || "";
  const imageId = image?.imageId ? image.imageId.slice(0, 19) : "";

  return `
    <div class="card">
      <div class="card-header">
        <div>
          <h3 class="card-title">Runner 镜像</h3>
          <p class="section-note">Server 启动后会后台检查并预拉取 runner 镜像，不阻塞 HTTP 服务启动。这里展示当前配置镜像在 VPS 上的实际状态。</p>
        </div>
        <div class="form-actions">
          <button class="btn btn-secondary btn-sm" type="button" data-action="refresh-runner-image">${state.busyKey === "runner-image-refresh" ? "刷新中..." : "重新拉取镜像"}</button>
        </div>
      </div>

      <div class="image-overview-grid">
        <div class="image-overview-item">
          <span class="config-section-label">配置镜像</span>
          <code class="inline-code-block">${escapeHtml(image?.image || "—")}</code>
        </div>
        <div class="image-overview-item">
          <span class="config-section-label">状态</span>
          <div>${statusBadge(image?.status || "idle", runnerImageTone(image))}</div>
        </div>
        <div class="image-overview-item">
          <span class="config-section-label">OpenClaw 版本</span>
          <strong>${escapeHtml(image?.openclawVersion || "未知")}</strong>
        </div>
        <div class="image-overview-item">
          <span class="config-section-label">镜像大小</span>
          <strong>${escapeHtml(formatBytes(image?.size || 0))}</strong>
        </div>
      </div>

      <div class="image-detail-grid">
        <div class="image-detail-card">
          <span class="config-section-label">本地缓存</span>
          <strong>${image?.localAvailable ? "已存在" : "未命中"}</strong>
          <span class="text-muted">来源：${escapeHtml(image?.source || "unknown")}</span>
        </div>
        <div class="image-detail-card">
          <span class="config-section-label">镜像 ID</span>
          <code>${escapeHtml(imageId || "—")}</code>
          <span class="text-muted">更新时间：${escapeHtml(formatDateTime(image?.updatedAt))}</span>
        </div>
        <div class="image-detail-card">
          <span class="config-section-label">创建时间</span>
          <strong>${escapeHtml(formatDateTime(image?.createdAt))}</strong>
          <span class="text-muted">开始检查：${escapeHtml(formatDateTime(image?.startedAt))}</span>
        </div>
        <div class="image-detail-card">
          <span class="config-section-label">Digest</span>
          <code>${escapeHtml(digest || "—")}</code>
          <span class="text-muted">RepoTags：${escapeHtml((image?.repoTags || []).join(", ") || "—")}</span>
        </div>
      </div>

      ${image?.message ? `<div class="image-status-panel">${escapeHtml(image.message)}</div>` : ""}
      ${image?.lastError ? `<pre class="log-output small-log">${escapeHtml(image.lastError)}</pre>` : ""}

      <div class="card-header image-metadata-header">
        <div>
          <h4 class="sub-title">镜像标签元数据</h4>
          <p class="section-note">这里可以确认 GitHub 构建出的 runner 镜像是否带上了 OpenClaw 版本和源码修订信息。</p>
        </div>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Label</th><th>Value</th></tr></thead>
          <tbody>
            ${Object.keys(labels).length
              ? Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `<tr><td><code>${escapeHtml(key)}</code></td><td><code>${escapeHtml(value)}</code></td></tr>`).join("")
              : `<tr><td colspan="2"><span class="text-muted">当前镜像未提供额外标签元数据。</span></td></tr>`
            }
          </tbody>
        </table>
      </div>
    </div>`;
}

function adminServerLogsTab() {
  const logs = state.serverLogs || {};
  const currentTail = logs.tail || 400;

  return `
    <div class="card">
      <div class="card-header">
        <div>
          <h3 class="card-title">Server 日志</h3>
          <p class="section-note">这里展示应用服务本身的后台日志，包括启动、runner 镜像预热、实例创建异常和接口错误。日志会同时打印到 VPS 控制台并落盘到本地文件。</p>
        </div>
        <form class="log-controls" data-form="load-server-logs">
          <select class="form-input form-input-sm" name="tail">
            ${LOG_TAIL_OPTIONS.map((v) => `<option value="${v}" ${currentTail === v ? "selected" : ""}>最近 ${v} 行</option>`).join("")}
          </select>
          <button class="btn btn-secondary btn-sm" type="submit">${state.busyKey === "server-logs" ? "刷新中..." : "刷新日志"}</button>
        </form>
      </div>

      <div class="image-detail-grid">
        <div class="image-detail-card">
          <span class="config-section-label">日志文件</span>
          <code>${escapeHtml(logs.path || "—")}</code>
        </div>
        <div class="image-detail-card">
          <span class="config-section-label">日志行数</span>
          <strong>${escapeHtml(String(logs.totalLines || 0))}</strong>
          <span class="text-muted">更新时间：${escapeHtml(formatDateTime(logs.updatedAt))}</span>
        </div>
      </div>

      ${logs.text
        ? `<pre class="log-output">${escapeHtml(logs.text)}</pre>`
        : `<p class="empty-text">当前还没有 server 日志。</p>`
      }
    </div>`;
}

function adminUsersTab() {
  if (!state.adminUsers.length) {
    return `<div class="card"><p class="empty-text">暂无用户。</p></div>`;
  }

  const instancesByUser = {};
  for (const inst of state.adminInstances) {
    instancesByUser[inst.userId] = inst;
  }

  return `
    <div class="card">
      <div class="card-header">
        <div>
          <h3 class="card-title">用户管理</h3>
          <p class="section-note">删除用户会同步清理关联实例，危险操作仍保留二次确认。</p>
        </div>
      </div>
      <div class="table-wrap">
      <table class="table">
        <thead><tr>
          <th>昵称</th><th>邮箱</th><th>角色</th><th>注册时间</th><th>实例状态</th><th>操作</th>
        </tr></thead>
        <tbody>
          ${state.adminUsers.map((u) => {
            const inst = instancesByUser[u.id];
            const instStatus = inst ? statusBadge(inst.status, instanceTone(inst)) : `<span class="text-muted">无实例</span>`;
            const canDelete = u.role !== "admin";
            return `<tr>
              <td>${escapeHtml(u.name)}</td>
              <td>${escapeHtml(u.email)}</td>
              <td>${statusBadge(u.role, u.role === "admin" ? "accent" : "muted")}</td>
              <td>${formatDateTime(u.createdAt)}</td>
              <td>${instStatus}</td>
              <td>${canDelete
                ? `<button class="btn btn-danger btn-sm" data-action="delete-user" data-user-id="${u.id}" data-user-name="${escapeHtml(u.name)}">${state.busyKey === `delete-user:${u.id}` ? "删除中..." : "删除"}</button>`
                : ""
              }</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
      </div>
    </div>`;
}

function adminInvitesTab() {
  const activeInvites = state.invites.filter((i) => inviteLifecycle(i).tone === "good");
  const archivedInvites = state.invites.filter((i) => inviteLifecycle(i).tone !== "good");

  return `
    <div class="card">
      <span class="section-kicker">邀请码分发</span>
      <h3 class="card-title">生成邀请码</h3>
      <p class="section-note">支持一次性邀请码、限次邀请码和带到期时间的邀请码，适合灰度发放。</p>
      <form class="form-stack" data-form="create-invite">
        <div class="form-row">
          <label class="form-label">备注<input class="form-input" name="note" /></label>
          <label class="form-label">最大使用次数<input class="form-input" name="maxUses" type="number" min="1" step="1" value="1" /></label>
        </div>
        <div class="form-row">
          <label class="form-label">过期时间<input class="form-input" name="expiresAt" type="datetime-local" /></label>
          <label class="form-label">自定义邀请码<input class="form-input" name="code" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="留空自动生成" /></label>
        </div>
        <button class="btn btn-primary" type="submit">${state.busyKey === "create-invite" ? "生成中..." : "生成邀请码"}</button>
      </form>
    </div>

    <div class="card">
      <h3 class="card-title">可分发 (${activeInvites.length})</h3>
      ${activeInvites.length
        ? `<div class="table-wrap"><table class="table"><thead><tr><th>Code</th><th>备注</th><th>使用/上限</th><th>到期时间</th><th>创建时间</th><th>操作</th></tr></thead><tbody>${activeInvites.map((inv) => inviteRow(inv, true)).join("")}</tbody></table></div>`
        : `<p class="empty-text">暂无可分发的邀请码。</p>`
      }
    </div>

    <div class="card">
      <h3 class="card-title">已归档 (${archivedInvites.length})</h3>
      ${archivedInvites.length
        ? `<div class="table-wrap"><table class="table"><thead><tr><th>Code</th><th>备注</th><th>使用/上限</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody>${archivedInvites.map((inv) => inviteRow(inv, false)).join("")}</tbody></table></div>`
        : `<p class="empty-text">暂无已归档的邀请码。</p>`
      }
    </div>`;
}

function inviteRow(invite, actionable) {
  const lc = inviteLifecycle(invite);
  return `<tr>
    <td><code>${escapeHtml(invite.code)}</code></td>
    <td>${escapeHtml(invite.note || "—")}</td>
    <td>${invite.uses}/${invite.maxUses}</td>
    <td>${actionable ? (invite.expiresAt ? formatDateTime(invite.expiresAt) : "长期有效") : statusBadge(lc.label, lc.tone)}</td>
    <td>${formatDateTime(invite.createdAt)}</td>
    <td>
      <button class="btn btn-ghost btn-sm" data-action="copy-invite-link" data-copy-value="${escapeHtml(encodeURIComponent(invite.inviteLink || invite.code))}">复制链接</button>
      ${actionable ? `<button class="btn btn-ghost btn-sm" data-action="revoke-invite" data-invite-id="${invite.id}">${state.busyKey === `revoke:${invite.id}` ? "停用中..." : "停用"}</button>` : ""}
    </td>
  </tr>`;
}

function adminPresetsTab() {
  const presets = state.modelPresets || [];
  return `
    <div class="card">
      <span class="section-kicker">模型基线</span>
      <h3 class="card-title">添加模型预设</h3>
      <p class="section-note">预设会直接出现在新用户引导流程中，建议只保留已验证可用的组合。</p>
      <form class="form-stack" data-form="create-preset">
        <div class="form-row">
          <label class="form-label">预设名称<input class="form-input" required name="name" /></label>
          <label class="form-label">Provider ID<input class="form-input" required name="providerId" /></label>
        </div>
        <div class="form-row">
          <label class="form-label">Model ID<input class="form-input" required name="modelId" /></label>
          <label class="form-label">API Mode
            <select class="form-input" name="apiMode">
              ${MODEL_API_MODES.map((m) => `<option value="${m}">${m}</option>`).join("")}
            </select>
          </label>
        </div>
        <div class="form-row">
          <label class="form-label">Base URL<input class="form-input" name="baseUrl" /></label>
          <label class="form-label">API Key<input class="form-input" required type="password" name="apiKey" /></label>
        </div>
        <button class="btn btn-primary" type="submit">${state.busyKey === "create-preset" ? "添加中..." : "添加预设"}</button>
      </form>
    </div>

    <div class="card">
      <h3 class="card-title">已有预设 (${presets.length})</h3>
      ${presets.length ? `
        <div class="table-wrap">
        <table class="table">
          <thead><tr><th>名称</th><th>Provider</th><th>Model</th><th>API Mode</th><th>操作</th></tr></thead>
          <tbody>
            ${presets.map((p) => `<tr>
              <td><strong>${escapeHtml(p.name)}</strong></td>
              <td>${escapeHtml(p.providerId)}</td>
              <td>${escapeHtml(p.modelId)}</td>
              <td>${escapeHtml(p.apiMode)}</td>
              <td><button class="btn btn-danger btn-sm" data-action="delete-preset" data-preset-id="${p.id}">${state.busyKey === `delete-preset:${p.id}` ? "删除中..." : "删除"}</button></td>
            </tr>`).join("")}
          </tbody>
        </table>
        </div>
      ` : `<p class="empty-text">暂无模型预设。用户在注册后的引导流程中将看到这些预设。</p>`}
    </div>`;
}

/* ═══════════════════════════════════════════════════════
   VIEW: Onboard (#/onboard)
   ═══════════════════════════════════════════════════════ */

function onboardView() {
  const step = state.onboardStep;
  return `
    ${navBar([], userDropdown())}
    <div class="page-body">
      <div class="onboard-layout">
        <div class="onboard-header">
          <span class="section-kicker">快速引导</span>
          <h2>创建你的 OpenClaw 实例</h2>
          <p class="section-note onboard-note">先命名，再选择默认模型。整个流程保持最小输入，方便快速开箱。</p>
          <div class="stepper">
            <span class="step ${step >= 1 ? "step-active" : ""}">1. 实例名称</span>
            <span class="step ${step >= 2 ? "step-active" : ""}">2. 选择模型</span>
          </div>
        </div>
        <div class="card onboard-card">
          ${step === 1 ? onboardStep1() : ""}
          ${step === 2 ? onboardStep2() : ""}
        </div>
      </div>
    </div>`;
}

function defaultInstanceName() {
  return state.onboardData.name || `${state.user?.name || "my"}-openclaw`;
}

function onboardStep1() {
  return `
    <h3>为你的实例起个名字</h3>
    <form class="form-stack" data-form="onboard-step1">
      <label class="form-label">实例名称<input class="form-input" required name="name" value="${escapeHtml(defaultInstanceName())}" /></label>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">下一步</button>
      </div>
    </form>`;
}

function onboardStep2() {
  const presets = state.modelPresets || [];
  const selectedPreset = state.onboardData.presetId || "";
  return `
    <h3>选择模型</h3>
    <p class="section-note">选择管理员预配置的模型，或先创建实例，稍后在配置页补齐。</p>
    ${presets.length ? `
      <div class="preset-list">
        ${presets.map((p) => `
          <label class="preset-card ${selectedPreset === p.id ? "preset-selected" : ""}">
            <input type="radio" name="presetId" value="${escapeHtml(p.id)}" ${selectedPreset === p.id ? "checked" : ""} data-action="select-preset" />
            <div class="preset-card-body">
              <strong>${escapeHtml(p.name)}</strong>
              <span class="text-muted">${escapeHtml(p.providerId)}/${escapeHtml(p.modelId)}</span>
            </div>
          </label>
        `).join("")}
      </div>
    ` : `<p class="empty-text">管理员尚未配置模型预设，可跳过后自行添加。</p>`}
    <div class="form-actions">
      <button class="btn btn-ghost" type="button" data-action="onboard-back">上一步</button>
      <button class="btn btn-ghost" type="button" data-action="onboard-create">${state.busyKey === "create-instance" ? "创建中..." : "跳过，稍后配置"}</button>
      ${presets.length ? `<button class="btn btn-primary" type="button" data-action="onboard-create-with-preset" ${!selectedPreset ? "disabled" : ""}>${state.busyKey === "create-instance" ? "创建中..." : "使用所选模型创建"}</button>` : ""}
    </div>`;
}

function parsePercent(str) {
  return parseFloat(String(str || "0").replace("%", "")) || 0;
}

function instanceStatsCard(inst) {
  const stats = state.statsByInstanceId[inst.id];
  if (!stats) {
    return `<div class="stats-card card"><span class="text-muted">正在加载资源监控...</span></div>`;
  }

  const cpuVal = parsePercent(stats.cpuPercent);
  const memVal = parsePercent(stats.memPercent);

  return `
    <div class="stats-card card">
      <div class="stats-card-grid">
        <div class="stats-metric">
          <div class="stats-metric-header">
            <span class="stats-metric-label">CPU</span>
            <span class="stats-metric-value">${escapeHtml(stats.cpuPercent)}</span>
          </div>
          <div class="stats-bar"><div class="stats-bar-fill stats-bar-cpu" style="width:${Math.min(100, cpuVal)}%"></div></div>
        </div>
        <div class="stats-metric">
          <div class="stats-metric-header">
            <span class="stats-metric-label">内存</span>
            <span class="stats-metric-value">${escapeHtml(stats.memPercent)}</span>
          </div>
          <div class="stats-bar"><div class="stats-bar-fill stats-bar-mem" style="width:${Math.min(100, memVal)}%"></div></div>
          <span class="stats-metric-detail">${escapeHtml(stats.memUsage)}</span>
        </div>
        <div class="stats-metric">
          <div class="stats-metric-header">
            <span class="stats-metric-label">网络 I/O</span>
            <span class="stats-metric-value">${escapeHtml(stats.netIO)}</span>
          </div>
        </div>
        <div class="stats-metric">
          <div class="stats-metric-header">
            <span class="stats-metric-label">进程数</span>
            <span class="stats-metric-value">${escapeHtml(stats.pids)}</span>
          </div>
        </div>
      </div>
    </div>`;
}

/* ═══════════════════════════════════════════════════════
   VIEW: Instance management (#/instance)
   ═══════════════════════════════════════════════════════ */

function instanceView() {
  const inst = state.instances[0];
  if (!inst) {
    navigate("#/onboard");
    return "";
  }

  const provisioning = inst.provisioning || {};
  const ready = provisioning.status === "ready";
  const percent = Math.max(0, Math.min(100, Number(provisioning.percent || 0)));

  const tabs = [
    { label: "运行", action: "instance-tab-run", active: state.instanceTab === "run" },
    { label: "配置", action: "instance-tab-config", active: state.instanceTab === "config" },
  ];

  return `
    ${navBar(tabs, userDropdown())}
    <div class="page-body">
      ${!ready ? provisioningBanner(inst, percent, provisioning) : ""}
      ${state.instanceTab === "run" ? instanceRunTab(inst) : ""}
      ${state.instanceTab === "config" ? instanceConfigTab(inst) : ""}
    </div>`;
}

function instanceRunTab(inst) {
  const binding = inst.wechatBinding || {};
  const pairedAccounts = binding.pairedAccounts || [];
  const ready = (inst.provisioning?.status || "ready") === "ready";
  const running = inst.status === "running";
  const starting = state.busyKey === `start:${inst.id}`;

  if (!ready) {
    return `<div class="card"><p class="empty-text">实例正在创建中，请稍候...</p></div>`;
  }

  if (!running && !starting) {
    return `
      <div class="instance-hero">
        <span class="section-kicker">运行面板</span>
        <div class="instance-hero-info">
          <h2>${escapeHtml(inst.name)}</h2>
          ${statusBadge(inst.status, instanceTone(inst))}
          ${inst.model ? `<span class="text-muted">${escapeHtml(inst.model.providerId)}/${escapeHtml(inst.model.modelId)}</span>` : `<span class="text-muted">未配置模型</span>`}
        </div>
        <p class="instance-hero-desc">实例已经就绪。启动后即可拉起容器、进入监控，并开始微信扫码绑定。</p>
        <button class="btn btn-primary btn-lg" data-action="start-instance" data-instance-id="${inst.id}">启动实例</button>
      </div>`;
  }

  if (starting) {
    return `
      <div class="instance-hero">
        <span class="section-kicker">运行面板</span>
        <div class="instance-hero-info">
          <h2>${escapeHtml(inst.name)}</h2>
          ${statusBadge("starting", "accent")}
        </div>
        <div class="starting-animation">
          <div class="spinner"></div>
          <p>正在启动容器...</p>
        </div>
      </div>`;
  }

  return `
    <div class="instance-header">
      <div class="instance-header-info">
        <h2>${escapeHtml(inst.name)}</h2>
        ${statusBadge(inst.status, instanceTone(inst))}
      </div>
      <div class="instance-header-actions">
        <button class="btn btn-secondary btn-sm" data-action="stop-instance" data-instance-id="${inst.id}">${state.busyKey === `stop:${inst.id}` ? "停止中..." : "停止"}</button>
        <button class="btn btn-ghost btn-sm" data-action="restart-gateway" data-instance-id="${inst.id}">${state.busyKey === `gateway:${inst.id}` ? "重启中..." : "重启网关"}</button>
        <a class="btn btn-ghost btn-sm" href="${inst.dashboardUrl}" target="_blank" rel="noreferrer">打开控制台</a>
      </div>
    </div>

    ${instanceStatsCard(inst)}

    <div class="card">
      <div class="card-header">
        <h3 class="card-title">微信绑定</h3>
        ${statusBadge(binding.status || "idle", bindingTone(binding))}
      </div>
      ${bindingContent(inst, binding, pairedAccounts)}
    </div>`;
}

function bindingContent(inst, binding, pairedAccounts) {
  const bindingActive = ["starting", "waiting_scan", "scanned"].includes(binding.status);

  if (binding.status === "starting") {
    return `
      <div class="starting-animation">
        <div class="spinner"></div>
        <p>正在安装微信插件并拉起扫码流程...</p>
      </div>
      ${binding.outputSnippet ? `<pre class="log-output small-log">${escapeHtml(binding.outputSnippet)}</pre>` : ""}`;
  }

  return `
    ${!bindingActive ? `<button class="btn btn-primary btn-sm" data-action="wechat-bind" data-instance-id="${inst.id}">${state.busyKey === `wechat:${inst.id}` ? "生成中..." : "生成配对二维码"}</button>` : ""}
    ${qrMarkup(binding)}
    ${binding.outputSnippet && binding.status !== "connected" ? `<pre class="log-output small-log">${escapeHtml(binding.outputSnippet)}</pre>` : ""}
    ${pairedAccounts.length ? `
      <h4 class="sub-title">已配对账号 (${pairedAccounts.length})</h4>
      <div class="paired-list">${pairedAccounts.map((a) => `
        <div class="paired-item">
          <strong>${escapeHtml(a.accountId)}</strong>
          <span>${escapeHtml(a.userId || "—")}</span>
          <span>${formatDateTime(a.savedAt)}</span>
        </div>`).join("")}</div>` : ""}`;
}

function instanceConfigTab(inst) {
  const logs = state.logsByInstanceId[inst.id];
  const currentTail = state.logTailByInstanceId[inst.id] || 200;
  const presets = state.modelPresets || [];

  return `
    <div class="instance-header">
      <div class="instance-header-info">
        <h2>${escapeHtml(inst.name)}</h2>
        ${statusBadge(inst.status, instanceTone(inst))}
      </div>
      <div class="instance-header-meta">
        <span>端口 ${inst.port}</span>
        ${inst.model ? `<span>${escapeHtml(inst.model.providerId)}/${escapeHtml(inst.model.modelId)}</span>` : `<span class="text-muted">未配置模型</span>`}
      </div>
    </div>

    <div class="card">
      <span class="section-kicker">模型接入</span>
      <h3 class="card-title">模型配置</h3>
      ${!inst.model ? `<p class="section-note">尚未配置模型，选择预设可快速落地，也可以直接填写自定义参数。</p>` : `<p class="section-note">修改后会立即写入实例配置。若只更新 Key，可保留其他字段不变。</p>`}

      ${presets.length ? `
        <div class="config-section-label">使用预设模型</div>
        <div class="preset-list compact">
          ${presets.map((p) => `
            <button class="preset-card-btn" data-action="apply-preset" data-preset-id="${p.id}" data-instance-id="${inst.id}">
              <strong>${escapeHtml(p.name)}</strong>
              <span class="text-muted">${escapeHtml(p.providerId)}/${escapeHtml(p.modelId)}</span>
            </button>
          `).join("")}
        </div>
        <div class="config-section-label">或自定义配置</div>
      ` : ""}

      <form class="form-stack" data-form="update-model" data-instance-id="${inst.id}">
        <div class="form-row">
          <label class="form-label">Provider<input class="form-input" required name="providerId" value="${escapeHtml(inst.model?.providerId || "")}" /></label>
          <label class="form-label">Model<input class="form-input" required name="modelId" value="${escapeHtml(inst.model?.modelId || "")}" /></label>
        </div>
        <div class="form-row">
          <label class="form-label">API Mode
            <select class="form-input" name="apiMode">
              ${MODEL_API_MODES.map((m) => `<option value="${m}" ${(inst.model?.apiMode || "openai-responses") === m ? "selected" : ""}>${m}</option>`).join("")}
            </select>
          </label>
          <label class="form-label">Base URL<input class="form-input" name="baseUrl" spellcheck="false" value="${escapeHtml(inst.model?.baseUrl || "")}" /></label>
        </div>
        <label class="form-label">API Key<input class="form-input" name="apiKey" type="password" ${inst.model ? `placeholder="留空保持当前 ${escapeHtml(inst.model.apiKeyMasked || "")}"` : ""} /></label>
        <button class="btn btn-secondary btn-sm" type="submit">${state.busyKey === `model:${inst.id}` ? "保存中..." : "保存模型配置"}</button>
      </form>
    </div>

    <details class="card collapsible">
      <summary>
        <div>
          <span class="section-kicker">高级配置</span>
          <span class="card-title">插件配置</span>
        </div>
      </summary>
      <form class="form-stack" data-form="update-plugins" data-instance-id="${inst.id}">
        <label class="form-label">插件 JSON<textarea class="form-input form-textarea" name="pluginsJson" spellcheck="false">${escapeHtml(JSON.stringify(inst.plugins || DEFAULT_PLUGIN_TEMPLATE, null, 2))}</textarea></label>
        <button class="btn btn-ghost btn-sm" type="submit">${state.busyKey === `plugins:${inst.id}` ? "保存中..." : "保存插件配置"}</button>
      </form>
    </details>

    <div class="card">
      <div class="card-header">
        <h3 class="card-title">日志</h3>
        <form class="log-controls" data-form="load-logs" data-instance-id="${inst.id}">
          <select class="form-input form-input-sm" name="tail">
            ${LOG_TAIL_OPTIONS.map((v) => `<option value="${v}" ${currentTail === v ? "selected" : ""}>最近 ${v} 行</option>`).join("")}
          </select>
          <button class="btn btn-ghost btn-sm" type="submit">${state.busyKey === `logs:${inst.id}` ? "刷新中..." : "刷新日志"}</button>
        </form>
      </div>
      ${logs ? `<pre class="log-output">${escapeHtml(logs)}</pre>` : `<p class="empty-text">点击刷新查看容器日志。</p>`}
    </div>`;
}

function provisioningBanner(inst, percent, provisioning) {
  return `
    <div class="provisioning-banner">
      <div class="provisioning-info">
        <strong>实例创建中</strong>
        <span>${escapeHtml(provisioning.message || "")}</span>
      </div>
      <div class="progress-bar"><div class="progress-fill" style="width:${percent}%;"></div></div>
    </div>`;
}

function qrMarkup(binding) {
  if (!binding?.qrMode) return "";
  if (binding.qrMode === "image" && binding.qrPayload) {
    return `<div class="qr-display"><img src="${binding.qrPayload}" alt="微信绑定二维码" /></div>`;
  }
  if (binding.qrMode === "ascii" && binding.qrPayload) {
    const src = asciiQrToSvgDataUrl(binding.qrPayload);
    return `<div class="qr-display"><img src="${src}" alt="微信绑定二维码" /></div>`;
  }
  return "";
}

/* ── Render ───────────────────────────────────────────── */

function render() {
  const route = currentRoute();
  let html = flashMarkup();

  if (!state.user) {
    html += route === "#/register" ? registerView() : loginView();
  } else if (state.user.mustChangePassword) {
    html += changePasswordView();
  } else if (route === "#/change-password") {
    html += settingsPasswordView();
  } else if (state.user.role === "admin" && (route === "#/admin" || route.startsWith("#/admin"))) {
    html += adminView();
  } else if (state.instances.length === 0) {
    html += onboardView();
  } else {
    html += instanceView();
  }

  app.innerHTML = html;
}

/* ── Event: form submit ───────────────────────────────── */

document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.dataset.form) return;
  event.preventDefault();
  const type = form.dataset.form;
  const data = Object.fromEntries(new FormData(form).entries());

  try {
    if (type === "register") {
      state.registerData = { ...data };
      if (data.password !== data.confirmPassword) { showToast("两次输入的密码不一致。"); return; }
      if (String(data.password || "").length < 8) { showToast("密码至少需要 8 个字符。"); return; }
      if (!String(data.email || "").trim()) { showToast("请填写邮箱地址。"); return; }
      if (!String(data.name || "").trim()) { showToast("请填写昵称。"); return; }
      if (!String(data.inviteCode || "").trim()) { showToast("请填写邀请码。"); return; }
      setBusy("register");
      try {
        await requestJson("/api/register", {
          method: "POST",
          body: JSON.stringify({ inviteCode: data.inviteCode, name: data.name, email: data.email, password: data.password }),
        });
      } catch (regError) {
        clearBusy();
        showToast(regError.message);
        return;
      }
      state.registerData = {};
      await bootstrap();
      setFlash("注册成功。");
      autoNavigate();
      return;
    }

    if (type === "login") {
      setBusy("login");
      await requestJson("/api/login", { method: "POST", body: JSON.stringify(data) });
      await bootstrap();
      setFlash("登录成功。");
      autoNavigate();
      return;
    }

    if (type === "change-password") {
      if (data.newPassword !== data.confirmNewPassword) throw new Error("两次输入的新密码不一致。");
      setBusy("change-password");
      const payload = await requestJson("/api/change-password", {
        method: "POST",
        body: JSON.stringify({ currentPassword: data.currentPassword, newPassword: data.newPassword }),
      });
      state.user = payload.user;
      if (!state.user.mustChangePassword) {
        await loadInstances();
        autoNavigate();
      }
      setFlash("密码已更新。");
      return;
    }

    if (type === "create-invite") {
      setBusy("create-invite");
      await requestJson("/api/invites", { method: "POST", body: JSON.stringify(data) });
      await loadInvites();
      form.reset();
      setFlash("邀请码已生成。");
      return;
    }

    if (type === "create-preset") {
      setBusy("create-preset");
      await requestJson("/api/admin/model-presets", { method: "POST", body: JSON.stringify(data) });
      await loadModelPresets();
      form.reset();
      setFlash("模型预设已添加。");
      return;
    }

    if (type === "onboard-step1") {
      state.onboardData.name = String(data.name || "").trim();
      if (!state.onboardData.name) throw new Error("请输入实例名称。");
      state.onboardStep = 2;
      loadModelPresets().catch(() => {});
      render();
      return;
    }

    if (type === "update-model") {
      const instanceId = form.dataset.instanceId;
      setBusy(`model:${instanceId}`);
      await requestJson(`/api/instances/${instanceId}/model`, { method: "PUT", body: JSON.stringify(data) });
      await loadInstances();
      setFlash("模型配置已保存。");
      return;
    }

    if (type === "update-plugins") {
      const instanceId = form.dataset.instanceId;
      setBusy(`plugins:${instanceId}`);
      let pluginsPayload;
      try { pluginsPayload = JSON.parse(String(data.pluginsJson || "{}")); } catch { throw new Error("插件配置必须是合法 JSON。"); }
      await requestJson(`/api/instances/${instanceId}/plugins`, { method: "PUT", body: JSON.stringify(pluginsPayload) });
      await loadInstances();
      setFlash("插件配置已保存。");
      return;
    }

    if (type === "load-logs") {
      const instanceId = form.dataset.instanceId;
      const tail = Number(data.tail || 200);
      setBusy(`logs:${instanceId}`);
      await loadLogs(instanceId, tail);
      setFlash("日志已刷新。");
      return;
    }

    if (type === "load-server-logs") {
      const tail = Number(data.tail || 400);
      setBusy("server-logs");
      await loadAdminServerLogs(tail);
      setFlash("Server 日志已刷新。");
      return;
    }
  } catch (error) {
    syncPasswordGate(error);
    setFlash(error.message, "error");
  } finally {
    clearBusy();
  }
});

/* ── Event: click actions ─────────────────────────────── */

document.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  // Close user dropdown when clicking outside
  const menu = document.getElementById("user-menu");
  const trigger = document.querySelector(".user-dropdown-trigger");
  if (menu?.classList.contains("open") && !target.closest(".user-dropdown")) {
    menu.classList.remove("open");
    if (trigger) trigger.setAttribute("aria-expanded", "false");
  }

  const actionEl = target.closest("[data-action]");
  if (!actionEl) return;

  const action = actionEl.getAttribute("data-action");
  const instanceId = actionEl.getAttribute("data-instance-id");

  try {
    if (action === "dismiss-flash") {
      state.flash = null;
      render();
      return;
    }

    if (action === "toggle-user-menu") {
      const menu = document.getElementById("user-menu");
      if (menu) {
        const isOpen = menu.classList.toggle("open");
        actionEl.setAttribute("aria-expanded", String(isOpen));
      }
      return;
    }

    if (action === "instance-tab-run") {
      state.instanceTab = "run";
      render();
      return;
    }

    if (action === "instance-tab-config") {
      state.instanceTab = "config";
      loadModelPresets().catch(() => {});
      render();
      return;
    }

    if (action === "apply-preset") {
      const presetId = actionEl.getAttribute("data-preset-id");
      const iid = actionEl.getAttribute("data-instance-id");
      setBusy(`model:${iid}`);
      await requestJson(`/api/instances/${iid}/model`, {
        method: "PUT",
        body: JSON.stringify({ presetId }),
      });
      await loadInstances();
      setFlash("已应用预设模型配置。");
      return;
    }

    if (action === "nav-home") {
      autoNavigate();
      return;
    }

    if (action === "logout") {
      setBusy("logout");
      await requestJson("/api/logout", { method: "POST" });
      state.user = null;
      state.instances = [];
      state.invites = [];
      state.adminUsers = [];
      state.adminInstances = [];
      state.runnerImage = null;
      state.serverLogs = { text: "", path: "", totalLines: 0, updatedAt: null, tail: 400 };
      state.logsByInstanceId = {};
      state.statsByInstanceId = {};
      state.onboardStep = 1;
      state.onboardData = {};
      state.registerData = {};
      state.modelPresets = [];
      state.instanceTab = "run";
      updatePolling();
      navigate("#/login");
      setFlash("已退出登录。");
      return;
    }

    if (action === "admin-tab-instances") {
      state.adminTab = "instances";
      await loadAdminInstances();
      render();
      return;
    }

    if (action === "admin-tab-images") {
      state.adminTab = "images";
      await loadAdminRunnerImage();
      render();
      return;
    }

    if (action === "admin-tab-server-logs") {
      state.adminTab = "server-logs";
      await loadAdminServerLogs();
      render();
      return;
    }

    if (action === "admin-tab-users") {
      state.adminTab = "users";
      await Promise.all([loadAdminUsers(), loadAdminInstances()]);
      render();
      return;
    }

    if (action === "admin-tab-invites") {
      state.adminTab = "invites";
      await loadInvites();
      render();
      return;
    }

    if (action === "admin-tab-presets") {
      state.adminTab = "presets";
      await loadModelPresets();
      render();
      return;
    }

    if (action === "delete-preset") {
      const presetId = actionEl.getAttribute("data-preset-id");
      setBusy(`delete-preset:${presetId}`);
      await requestJson(`/api/admin/model-presets/${presetId}`, { method: "DELETE" });
      await loadModelPresets();
      setFlash("模型预设已删除。");
      return;
    }

    if (action === "refresh-runner-image") {
      setBusy("runner-image-refresh");
      const payload = await requestJson("/api/admin/runner-image/refresh", { method: "POST" });
      state.runnerImage = payload.image || null;
      setFlash("Runner 镜像已刷新。");
      render();
      return;
    }

    if (action === "delete-user") {
      const userId = actionEl.getAttribute("data-user-id");
      const userName = actionEl.getAttribute("data-user-name");
      if (!confirm(`确定要删除用户「${userName}」吗？其实例和容器也会一并清理。`)) return;
      setBusy(`delete-user:${userId}`);
      await requestJson(`/api/admin/users/${userId}`, { method: "DELETE" });
      await Promise.all([loadAdminUsers(), loadAdminInstances()]);
      setFlash("用户已删除。");
      return;
    }

    if (action === "copy-invite-link" || action === "copy-invite-code") {
      const encoded = actionEl.getAttribute("data-copy-value") || "";
      const text = decodeURIComponent(encoded);
      await copyText(text, action === "copy-invite-code" ? "邀请码已复制。" : "邀请链接已复制。");
      return;
    }

    if (action === "revoke-invite") {
      const inviteId = actionEl.getAttribute("data-invite-id");
      setBusy(`revoke:${inviteId}`);
      await requestJson(`/api/invites/${inviteId}/revoke`, { method: "POST" });
      await loadInvites();
      setFlash("邀请码已停用。");
      return;
    }

    if (action === "onboard-back") {
      if (state.onboardStep > 1) {
        state.onboardStep--;
        render();
      }
      return;
    }

    if (action === "select-preset") {
      state.onboardData.presetId = actionEl.value || "";
      render();
      return;
    }

    if (action === "onboard-create" || action === "onboard-create-with-preset") {
      const payload = { name: state.onboardData.name };
      if (action === "onboard-create-with-preset" && state.onboardData.presetId) {
        payload.presetId = state.onboardData.presetId;
      }
      setBusy("create-instance");
      await requestJson("/api/instances", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      await loadInstances();
      state.onboardStep = 1;
      state.onboardData = {};
      navigate("#/instance");
      setFlash(action === "onboard-create" ? "实例已创建，可在下方配置模型。" : "实例已创建，正在启动中。");
      return;
    }

    if (action === "start-instance" && instanceId) {
      setBusy(`start:${instanceId}`);
      await requestJson(`/api/instances/${instanceId}/start`, { method: "POST" });
      await loadInstances();
      setFlash("容器已启动。");
      return;
    }

    if (action === "stop-instance" && instanceId) {
      setBusy(`stop:${instanceId}`);
      await requestJson(`/api/instances/${instanceId}/stop`, { method: "POST" });
      await loadInstances();
      setFlash("容器已停止。");
      return;
    }

    if (action === "restart-gateway" && instanceId) {
      setBusy(`gateway:${instanceId}`);
      await requestJson(`/api/instances/${instanceId}/restart-gateway`, { method: "POST" });
      await loadInstances();
      setFlash("网关已重启。");
      return;
    }

    if (action === "wechat-bind" && instanceId) {
      setBusy(`wechat:${instanceId}`);
      await requestJson(`/api/instances/${instanceId}/wechat-bind`, { method: "POST" });
      await loadInstances();
      setFlash("微信绑定流程已启动。");
      return;
    }
  } catch (error) {
    syncPasswordGate(error);
    setFlash(error.message, "error");
  } finally {
    clearBusy();
  }
});

/* ── Hash change routing ──────────────────────────────── */

window.addEventListener("hashchange", async () => {
  const route = currentRoute();

  if (state.user?.role === "admin" && route === "#/admin") {
    await Promise.all([loadAdminInstances(), loadAdminUsers(), loadInvites(), loadModelPresets(), loadAdminRunnerImage(), loadAdminServerLogs()]);
  }

  render();
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;

  const menu = document.getElementById("user-menu");
  const trigger = document.querySelector(".user-dropdown-trigger");
  if (menu?.classList.contains("open")) {
    menu.classList.remove("open");
    if (trigger) trigger.setAttribute("aria-expanded", "false");
  }

  const toast = document.querySelector(".toast-overlay");
  if (toast) toast.remove();
});

/* ── Init ─────────────────────────────────────────────── */

bootstrap().catch((error) => {
  setFlash(error.message || "初始化失败", "error");
});
