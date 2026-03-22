const state = {
  user: null,
  instances: [],
  invites: [],
  logsByInstanceId: {},
  selectedInstanceId: null,
  flash: null,
  busyKey: "",
  invitePrefill: new URLSearchParams(window.location.search).get("invite") || "",
};

const app = document.querySelector("#app");
let pollingTimer = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function asciiQrToSvgDataUrl(payload) {
  const lines = String(payload || "")
    .split(/\r?\n/)
    .filter((line) => line.length > 0);

  if (!lines.length) {
    return "";
  }

  const width = Math.max(...lines.map((line) => line.length));
  const bitmapRows = [];

  for (const rawLine of lines) {
    const line = rawLine.padEnd(width, " ");
    const upper = [];
    const lower = [];

    for (const cell of line) {
      switch (cell) {
        case "█":
          upper.push(1);
          lower.push(1);
          break;
        case "▀":
          upper.push(1);
          lower.push(0);
          break;
        case "▄":
          upper.push(0);
          lower.push(1);
          break;
        case "▌":
        case "▐":
        case "▓":
        case "▒":
          upper.push(1);
          lower.push(1);
          break;
        default:
          upper.push(0);
          lower.push(0);
      }
    }

    bitmapRows.push(upper, lower);
  }

  const quietZone = 2;
  const svgWidth = width + quietZone * 2;
  const svgHeight = bitmapRows.length + quietZone * 2;
  const darkModules = [];

  for (let y = 0; y < bitmapRows.length; y += 1) {
    for (let x = 0; x < bitmapRows[y].length; x += 1) {
      if (bitmapRows[y][x]) {
        darkModules.push(`M${x + quietZone} ${y + quietZone}h1v1h-1z`);
      }
    }
  }

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgWidth} ${svgHeight}" shape-rendering="crispEdges">
      <rect width="${svgWidth}" height="${svgHeight}" fill="#fffaf2"/>
      <path d="${darkModules.join("")}" fill="#111111"/>
    </svg>
  `.trim();

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || "请求失败");
    error.payload = payload;
    throw error;
  }

  return payload;
}

function selectedInstance() {
  return state.instances.find((item) => item.id === state.selectedInstanceId) || state.instances[0] || null;
}

function formatDateTime(value) {
  if (!value) {
    return "未记录";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function toDatetimeLocalValue(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const pad = (part) => String(part).padStart(2, "0");
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
    render();
  }
}

function updatePolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }

  const needsPolling =
    state.user &&
    !state.user.mustChangePassword &&
    state.instances.some((instance) =>
      instance.provisioning?.status === "running" ||
      ["starting", "waiting_scan", "scanned"].includes(instance.wechatBinding?.status),
    );

  if (!needsPolling) {
    return;
  }

  pollingTimer = setInterval(() => {
    loadInstances().catch(() => {});
  }, 3000);
}

async function loadSession() {
  const payload = await request("/api/session", { method: "GET" });
  state.user = payload.user;
}

async function loadInstances() {
  if (!state.user || state.user.mustChangePassword) {
    state.instances = [];
    state.selectedInstanceId = null;
    updatePolling();
    render();
    return;
  }

  const payload = await request("/api/instances", { method: "GET" });
  state.instances = payload.instances;

  if (!state.instances.some((item) => item.id === state.selectedInstanceId)) {
    state.selectedInstanceId = state.instances[0]?.id || null;
  }

  updatePolling();
  render();
}

async function loadInvites() {
  if (!state.user || state.user.mustChangePassword || state.user.role !== "admin") {
    state.invites = [];
    render();
    return;
  }

  const payload = await request("/api/invites", { method: "GET" });
  state.invites = payload.invites;
  render();
}

async function loadLogs(instanceId, tail = 200) {
  const payload = await request(`/api/instances/${instanceId}/logs?tail=${tail}`, { method: "GET" });
  state.logsByInstanceId[instanceId] = payload.logs || "";
  render();
}

async function bootstrap() {
  await loadSession();
  await Promise.all([loadInstances(), loadInvites()]);
  render();
}

function metricsMarkup() {
  const running = state.instances.filter((item) => item.status === "running").length;
  const paired = state.instances.filter((item) => (item.wechatBinding?.pairedAccounts || []).length > 0).length;
  return `
    <div class="stat-strip">
      <div class="stat"><strong>${state.instances.length}</strong><span>实例总数</span></div>
      <div class="stat"><strong>${running}</strong><span>运行中网关</span></div>
      <div class="stat"><strong>${paired}</strong><span>已完成微信配对</span></div>
    </div>
  `;
}

function authView() {
  const inviteHint = state.invitePrefill
    ? `<p class="mini-note">已从邀请链接带入邀请码：<strong>${escapeHtml(state.invitePrefill)}</strong></p>`
    : `<p class="mini-note">当前系统为邀请制注册，没有邀请码无法创建账号。</p>`;

  return `
    <section class="panel-grid">
      <article class="hero-panel">
        <div class="panel-header">
          <div>
            <p class="panel-title">Fabric Entry</p>
            <p class="panel-subtitle">
              这是一个真正会拉起实例的入口台。管理员投放邀请码，用户注册后拥有自己的
              OpenClaw 容器、模型配置、微信绑定与后续运维面板。
            </p>
          </div>
        </div>
        ${metricsMarkup()}
        <div class="hero-notes">
          <div class="note-card">
            <strong>邀请码准入</strong>
            <span>注册链接可直达，并自动预填邀请码。</span>
          </div>
          <div class="note-card">
            <strong>首登改密</strong>
            <span>管理员账号首次登录后会被强制要求修改密码。</span>
          </div>
          <div class="note-card">
            <strong>实例闭环</strong>
            <span>创建、日志、插件、网关重启与微信扫码都在同一界面完成。</span>
          </div>
        </div>
      </article>

      <section class="panel">
        <div class="panel-header">
          <div>
            <p class="panel-title">Access</p>
            <p class="panel-subtitle">登录用于进入工作台，注册必须附带管理员发放的邀请码。</p>
          </div>
        </div>
        <div class="auth-split">
          <form class="auth-card stack" data-form="register">
            <h2>邀请码注册</h2>
            ${inviteHint}
            <label>邀请码<input required name="inviteCode" value="${escapeHtml(state.invitePrefill)}" placeholder="例如：INV-9A1C2D3E" /></label>
            <label>昵称<input required name="name" placeholder="例如：杭州客服 A 组" /></label>
            <label>邮箱<input required type="email" name="email" placeholder="team@example.com" /></label>
            <label>密码<input required type="password" name="password" placeholder="至少 8 位" /></label>
            <button class="button-primary" type="submit">${state.busyKey === "register" ? "注册中..." : "注册并进入控制台"}</button>
          </form>

          <form class="auth-card stack" data-form="login">
            <h2>已有账号登录</h2>
            <label>邮箱<input required type="email" name="email" placeholder="team@example.com" /></label>
            <label>密码<input required type="password" name="password" placeholder="请输入密码" /></label>
            <button class="button-secondary" type="submit">${state.busyKey === "login" ? "登录中..." : "登录"}</button>
          </form>
        </div>
      </section>
    </section>
  `;
}

function passwordGateView() {
  return `
    <section class="panel-grid">
      <article class="hero-panel">
        <div class="panel-header">
          <div>
            <p class="panel-title">Security Gate</p>
            <p class="panel-subtitle">
              当前账号已登录，但系统要求先完成密码更新。改密完成前，不开放邀请码管理和实例操作。
            </p>
          </div>
          <button class="button-ghost" type="button" data-action="logout">退出登录</button>
        </div>
        <div class="hero-notes">
          <div class="note-card">
            <strong>${escapeHtml(state.user?.name || "当前账号")}</strong>
            <span>${escapeHtml(state.user?.email || "")}</span>
          </div>
          <div class="note-card">
            <strong>角色</strong>
            <span>${escapeHtml(state.user?.role || "user")}</span>
          </div>
        </div>
      </article>

      <section class="panel">
        <div class="panel-header">
          <div>
            <p class="panel-title">First Password Reset</p>
            <p class="panel-subtitle">管理员首次登录必须完成改密。普通用户也可以在进入工作台后再次修改密码。</p>
          </div>
        </div>
        ${passwordFormMarkup(true)}
      </section>
    </section>
  `;
}

function instanceListMarkup() {
  if (!state.instances.length) {
    return `
      <div class="detail-block">
        <p class="empty-copy">
          还没有实例。右侧直接提交第一个 OpenClaw 工作单元，系统会异步完成目录准备、配置写入和容器启动。
        </p>
      </div>
    `;
  }

  return `
    <div class="instance-list">
      ${state.instances
        .map((instance) => {
          const active = instance.id === state.selectedInstanceId ? "active" : "";
          const pairedCount = instance.wechatBinding?.pairedAccounts?.length || 0;
          return `
            <button type="button" class="instance-card ${active}" data-instance-select="${instance.id}">
              <strong>${escapeHtml(instance.name)}</strong>
              <div class="instance-meta">
                <span class="badge ${escapeHtml(instance.status)}">${escapeHtml(instance.status)}</span>
                <span class="badge ${escapeHtml(instance.provisioning?.status || "ready")}">${escapeHtml(instance.provisioning?.stage || "ready")}</span>
                <span class="badge">端口 ${instance.port}</span>
                <span class="badge">${pairedCount} 个微信账号</span>
              </div>
            </button>
          `;
        })
        .join("")}
    </div>
  `;
}

function progressMarkup(instance) {
  const provisioning = instance.provisioning || {};
  const percent = Math.max(0, Math.min(100, Number(provisioning.percent || 0)));

  return `
    <div class="detail-block">
      <h3>创建进度</h3>
      <div class="progress-meta">
        <span class="badge ${escapeHtml(provisioning.status || "ready")}">${escapeHtml(provisioning.status || "ready")}</span>
        <span>${escapeHtml(provisioning.stage || "ready")}</span>
        <span>${percent}%</span>
      </div>
      <div class="progress-shell" aria-hidden="true">
        <div class="progress-bar" style="width: ${percent}%"></div>
      </div>
      <p class="status-line">${escapeHtml(provisioning.message || "实例已就绪。")}</p>
    </div>
  `;
}

function qrMarkup(binding) {
  if (!binding || !binding.qrMode) {
    return `<p class="muted">点击按钮后，系统会进入对应用户容器执行微信接入命令，并在这里展示二维码图片。</p>`;
  }

  if (binding.qrMode === "image" && binding.qrPayload) {
    return `
      <div class="qr-frame">
        <img src="${binding.qrPayload}" alt="微信绑定二维码" />
      </div>
    `;
  }

  if (binding.qrMode === "ascii" && binding.qrPayload) {
    const imageSrc = asciiQrToSvgDataUrl(binding.qrPayload);
    return `
      <div class="qr-frame">
        <img src="${imageSrc}" alt="微信绑定二维码" />
      </div>
    `;
  }

  return "";
}

function pairedAccountsMarkup(binding) {
  const pairedAccounts = binding?.pairedAccounts || [];
  if (!pairedAccounts.length) {
    return `<p class="mini-note">配对成功后，这里会展示保存下来的账号信息。</p>`;
  }

  return `
    <div class="paired-grid">
      ${pairedAccounts
        .map(
          (account) => `
            <article class="paired-card">
              <strong>${escapeHtml(account.accountId)}</strong>
              <span>${escapeHtml(account.userId || "未记录 userId")}</span>
              <span>${escapeHtml(account.baseUrl || "未记录 baseUrl")}</span>
              <span>${escapeHtml(formatDateTime(account.savedAt))}</span>
            </article>
          `,
        )
        .join("")}
    </div>
  `;
}

function logsMarkup(instance) {
  const logs = state.logsByInstanceId[instance.id];
  return `
    <div class="detail-block">
      <div class="inline-head">
        <h3>实例日志</h3>
        <button class="button-ghost" type="button" data-action="load-logs" data-instance-id="${instance.id}">
          ${state.busyKey === `logs:${instance.id}` ? "刷新中..." : "刷新最近 200 行"}
        </button>
      </div>
      ${
        logs
          ? `
            <div class="log-frame">
              <pre>${escapeHtml(logs)}</pre>
            </div>
          `
          : `<p class="mini-note">点击按钮后读取最近 200 行容器日志。</p>`
      }
    </div>
  `;
}

function modelFormMarkup(instance) {
  return `
    <form class="detail-block stack" data-form="update-model" data-instance-id="${instance.id}">
      <h3>模型配置</h3>
      <div class="detail-two">
        <label>Provider ID<input required name="providerId" value="${escapeHtml(instance.model.providerId)}" /></label>
        <label>Model ID<input required name="modelId" value="${escapeHtml(instance.model.modelId)}" /></label>
        <label>
          API Mode
          <select name="apiMode">
            ${["openai-responses", "openai-completions", "anthropic-messages", "google-generative-ai"]
              .map(
                (mode) =>
                  `<option value="${mode}" ${instance.model.apiMode === mode ? "selected" : ""}>${mode}</option>`,
              )
              .join("")}
          </select>
        </label>
        <label>Base URL<input name="baseUrl" value="${escapeHtml(instance.model.baseUrl || "")}" placeholder="可留空" /></label>
      </div>
      <label>
        API Key
        <input name="apiKey" type="password" placeholder="留空则保持当前 ${escapeHtml(instance.model.apiKeyMasked || "")}" />
      </label>
      <button class="button-primary" type="submit">
        ${state.busyKey === `model:${instance.id}` ? "保存中..." : "保存并重载实例"}
      </button>
    </form>
  `;
}

function pluginsFormMarkup(instance) {
  const pluginsText = escapeHtml(JSON.stringify(instance.plugins || { allow: [], entries: {} }, null, 2));
  return `
    <form class="detail-block stack" data-form="update-plugins" data-instance-id="${instance.id}">
      <h3>插件配置</h3>
      <p class="mini-note">填写 JSON 对象，支持 <code>allow</code> 和 <code>entries</code>。保存后若实例运行中，将自动执行网关重启。</p>
      <label>
        Plugins JSON
        <textarea name="pluginsJson" spellcheck="false">${pluginsText}</textarea>
      </label>
      <button class="button-secondary" type="submit">
        ${state.busyKey === `plugins:${instance.id}` ? "保存中..." : "保存插件配置"}
      </button>
    </form>
  `;
}

function createInstanceFormMarkup() {
  return `
    <form class="stack" data-form="create-instance">
      <label>实例名称<input required name="name" placeholder="例如：客服机器人 A 线" /></label>
      <div class="detail-two">
        <label>Provider ID<input required name="providerId" value="openai" /></label>
        <label>Model ID<input required name="modelId" value="gpt-4.1" /></label>
        <label>
          API Mode
          <select name="apiMode">
            <option value="openai-responses">openai-responses</option>
            <option value="openai-completions">openai-completions</option>
            <option value="anthropic-messages">anthropic-messages</option>
            <option value="google-generative-ai">google-generative-ai</option>
          </select>
        </label>
        <label>Base URL<input name="baseUrl" placeholder="如接代理网关可填写" /></label>
      </div>
      <label>API Key<input required type="password" name="apiKey" placeholder="输入该实例自己的模型密钥" /></label>
      <button class="button-primary" type="submit">
        ${state.busyKey === "create-instance" ? "创建中..." : "创建实例并启动容器"}
      </button>
    </form>
  `;
}

function passwordFormMarkup(forceMode = false) {
  return `
    <form class="stack" data-form="change-password">
      <label>
        当前密码
        <input name="currentPassword" type="password" placeholder="${forceMode ? "首次登录可留空" : "请输入当前密码"}" />
      </label>
      <label>新密码<input required name="newPassword" type="password" placeholder="至少 8 位" /></label>
      <button class="button-primary" type="submit">
        ${state.busyKey === "change-password" ? "保存中..." : forceMode ? "完成首次改密" : "更新密码"}
      </button>
    </form>
  `;
}

function inviteAdminMarkup() {
  if (state.user?.role !== "admin" || state.user.mustChangePassword) {
    return "";
  }

  return `
    <section class="panel admin-panel">
      <div class="panel-header">
        <div>
          <p class="panel-title">Invites</p>
          <p class="panel-subtitle">管理员在这里创建邀请码或邀请链接。注册链接可直接发给新用户。</p>
        </div>
      </div>

      <div class="admin-grid">
        <form class="detail-block stack" data-form="create-invite">
          <h3>创建邀请码</h3>
          <label>备注<input name="note" placeholder="例如：华东客服团队 3 月批次" /></label>
          <div class="detail-two">
            <label>最大使用次数<input name="maxUses" type="number" min="1" step="1" value="1" /></label>
            <label>过期时间<input name="expiresAt" type="datetime-local" /></label>
          </div>
          <label>自定义 code<input name="code" placeholder="留空则自动生成" /></label>
          <button class="button-primary" type="submit">
            ${state.busyKey === "create-invite" ? "生成中..." : "生成邀请码"}
          </button>
        </form>

        <div class="detail-block invite-list">
          <div class="inline-head">
            <h3>已发放邀请码</h3>
            <span class="mini-note">${state.invites.length} 条</span>
          </div>
          ${
            state.invites.length
              ? state.invites
                  .map(
                    (invite) => `
                      <article class="invite-card">
                        <div class="invite-code-row">
                          <strong>${escapeHtml(invite.code)}</strong>
                          <button
                            class="button-ghost button-compact"
                            type="button"
                            data-action="copy-invite"
                            data-copy-text="${escapeHtml(encodeURIComponent(invite.inviteLink || invite.code))}"
                          >
                            复制链接
                          </button>
                        </div>
                        <p class="mini-note">${escapeHtml(invite.note || "无备注")}</p>
                        <div class="instance-meta">
                          <span class="badge">${invite.uses}/${invite.maxUses}</span>
                          <span class="badge">${invite.expiresAt ? `到期 ${escapeHtml(formatDateTime(invite.expiresAt))}` : "长期有效"}</span>
                        </div>
                        <p class="invite-link">${escapeHtml(invite.inviteLink || invite.code)}</p>
                      </article>
                    `,
                  )
                  .join("")
              : `<p class="mini-note">还没有邀请码。创建后会在这里出现邀请链接。</p>`
          }
        </div>
      </div>
    </section>
  `;
}

function selectedDetailMarkup() {
  const instance = selectedInstance();
  if (!instance) {
    return `
      <section class="panel">
        <div class="panel-header">
          <div>
            <p class="panel-title">First Instance</p>
            <p class="panel-subtitle">创建一个实例后，这里会出现进度、模型配置、微信绑定、日志和插件面板。</p>
          </div>
        </div>
        <div class="detail-grid">
          <div class="detail-block accent-block">
            <h3>准备第一条工作通道</h3>
            <p class="mini-note">提交后系统会先写目录与配置，再自动拉起 OpenClaw 容器。</p>
          </div>
          <div class="detail-block">${createInstanceFormMarkup()}</div>
        </div>
      </section>
    `;
  }

  const binding = instance.wechatBinding || {};
  const isProvisioningReady = instance.provisioning?.status === "ready";

  return `
    <section class="panel detail-grid">
      <div class="topline">
        <div class="workspace-head">
          <div>
            <p class="panel-title">Selected Instance</p>
            <h2>${escapeHtml(instance.name)}</h2>
            <p class="panel-subtitle">
              独立 home、独立 workspace、独立网关端口。这里同时承载模型配置、插件配置和微信接入。
            </p>
          </div>
        </div>
        <a class="anchor-link" href="${instance.dashboardUrl}" target="_blank" rel="noreferrer">
          打开 OpenClaw Control UI
        </a>
      </div>

      ${progressMarkup(instance)}

      <div class="detail-block">
        <h3>实例控制</h3>
        <p class="status-line">
          当前状态：<strong>${escapeHtml(instance.status)}</strong> · 创建阶段：<strong>${escapeHtml(instance.provisioning?.stage || "ready")}</strong>
        </p>
        <div class="button-cluster">
          <button class="button-primary" type="button" data-action="start-instance" data-instance-id="${instance.id}" ${!isProvisioningReady ? "disabled" : ""}>
            ${state.busyKey === `start:${instance.id}` ? "启动中..." : "启动容器"}
          </button>
          <button class="button-secondary" type="button" data-action="stop-instance" data-instance-id="${instance.id}" ${!isProvisioningReady ? "disabled" : ""}>
            ${state.busyKey === `stop:${instance.id}` ? "停止中..." : "停止容器"}
          </button>
          <button class="button-ghost" type="button" data-action="restart-gateway" data-instance-id="${instance.id}" ${instance.status !== "running" ? "disabled" : ""}>
            ${state.busyKey === `gateway:${instance.id}` ? "重启中..." : "重启网关"}
          </button>
        </div>
      </div>

      ${logsMarkup(instance)}
      ${modelFormMarkup(instance)}
      ${pluginsFormMarkup(instance)}

      <div class="detail-block">
        <h3>微信绑定</h3>
        <p class="mini-note">点击后会进入该用户实例容器执行接入命令，并把二维码直接回显成图片。</p>
        <div class="button-cluster">
          <button class="button-primary" type="button" data-action="wechat-bind" data-instance-id="${instance.id}" ${instance.status !== "running" ? "disabled" : ""}>
            ${state.busyKey === `wechat:${instance.id}` ? "拉起中..." : "生成微信绑定二维码"}
          </button>
        </div>
        <p class="status-line">
          绑定状态：<strong>${escapeHtml(binding.status || "idle")}</strong>
          ${binding.updatedAt ? ` · 最近更新：${escapeHtml(formatDateTime(binding.updatedAt))}` : ""}
        </p>
        ${
          ["starting", "waiting_scan", "scanned"].includes(binding.status)
            ? `<p class="mini-note">二维码阶段会自动轮询刷新，无需手动重载页面。</p>`
            : ""
        }
        ${qrMarkup(binding)}
        ${binding.outputSnippet ? `<div class="log-frame"><pre>${escapeHtml(binding.outputSnippet)}</pre></div>` : ""}
        <div class="inline-head">
          <h3>已配对账号</h3>
          <span class="mini-note">${(binding.pairedAccounts || []).length} 条</span>
        </div>
        ${pairedAccountsMarkup(binding)}
      </div>

      <div class="detail-block">
        <h3>新建更多实例</h3>
        ${createInstanceFormMarkup()}
      </div>
    </section>
  `;
}

function dashboardView() {
  return `
    ${inviteAdminMarkup()}
    <section class="workspace-shell">
      <aside class="panel sidebar-stack">
        <div class="panel-header">
          <div>
            <p class="panel-title">Roster</p>
            <p class="panel-subtitle">
              当前用户：${escapeHtml(state.user.name)} · ${escapeHtml(state.user.email)}
            </p>
          </div>
          <button class="button-ghost" type="button" data-action="logout">退出登录</button>
        </div>
        <div class="account-ribbon">
          <span class="badge">${escapeHtml(state.user.role || "user")}</span>
          <span class="badge">创建于 ${escapeHtml(formatDateTime(state.user.createdAt))}</span>
        </div>
        ${metricsMarkup()}
        <div class="detail-block security-block">
          <h3>账户安全</h3>
          <p class="mini-note">普通用户在这里修改密码。管理员首登的强制改密会在登录后单独拦截。</p>
          ${passwordFormMarkup(false)}
        </div>
        ${instanceListMarkup()}
      </aside>
      ${selectedDetailMarkup()}
    </section>
  `;
}

function render() {
  app.innerHTML = `
    ${state.flash ? `<div class="flash ${state.flash.tone === "error" ? "error" : ""}">${escapeHtml(state.flash.message)}</div>` : ""}
    ${
      !state.user
        ? authView()
        : state.user.mustChangePassword
          ? passwordGateView()
          : dashboardView()
    }
  `;
}

document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) {
    return;
  }

  const type = form.dataset.form;
  if (!type) {
    return;
  }

  event.preventDefault();
  const data = Object.fromEntries(new FormData(form).entries());

  try {
    if (type === "register") {
      setBusy("register");
      await request("/api/register", { method: "POST", body: JSON.stringify(data) });
      await bootstrap();
      setFlash("注册成功，已进入控制台。");
      return;
    }

    if (type === "login") {
      setBusy("login");
      await request("/api/login", { method: "POST", body: JSON.stringify(data) });
      await bootstrap();
      setFlash("登录成功。");
      return;
    }

    if (type === "change-password") {
      setBusy("change-password");
      const payload = await request("/api/change-password", {
        method: "POST",
        body: JSON.stringify(data),
      });
      state.user = payload.user;
      await bootstrap();
      setFlash("密码已更新。");
      return;
    }

    if (type === "create-invite") {
      setBusy("create-invite");
      await request("/api/invites", { method: "POST", body: JSON.stringify(data) });
      await loadInvites();
      form.reset();
      setFlash("邀请码已生成。");
      return;
    }

    if (type === "create-instance") {
      setBusy("create-instance");
      const payload = await request("/api/instances", { method: "POST", body: JSON.stringify(data) });
      state.selectedInstanceId = payload.instance.id;
      await loadInstances();
      setFlash("实例已进入创建流程，页面会自动刷新进度。");
      return;
    }

    if (type === "update-model") {
      const instanceId = form.dataset.instanceId;
      setBusy(`model:${instanceId}`);
      await request(`/api/instances/${instanceId}/model`, {
        method: "PUT",
        body: JSON.stringify(data),
      });
      await loadInstances();
      setFlash("模型配置已更新。");
      return;
    }

    if (type === "update-plugins") {
      const instanceId = form.dataset.instanceId;
      setBusy(`plugins:${instanceId}`);
      let pluginsPayload;
      try {
        pluginsPayload = JSON.parse(String(data.pluginsJson || "{}"));
      } catch {
        throw new Error("插件配置必须是合法 JSON。");
      }

      if (!pluginsPayload || typeof pluginsPayload !== "object" || Array.isArray(pluginsPayload)) {
        throw new Error("插件配置必须是 JSON 对象。");
      }

      await request(`/api/instances/${instanceId}/plugins`, {
        method: "PUT",
        body: JSON.stringify(pluginsPayload),
      });
      await loadInstances();
      setFlash("插件配置已保存。");
    }
  } catch (error) {
    syncPasswordGate(error);
    setFlash(error.message, "error");
  } finally {
    clearBusy();
  }
});

document.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const instanceButton = target.closest("[data-instance-select]");
  if (instanceButton) {
    state.selectedInstanceId = instanceButton.getAttribute("data-instance-select");
    render();
    return;
  }

  const actionButton = target.closest("[data-action]");
  if (!actionButton) {
    return;
  }

  const action = actionButton.getAttribute("data-action");
  const instanceId = actionButton.getAttribute("data-instance-id");

  try {
    if (action === "logout") {
      setBusy("logout");
      await request("/api/logout", { method: "POST" });
      state.user = null;
      state.instances = [];
      state.invites = [];
      state.logsByInstanceId = {};
      state.selectedInstanceId = null;
      updatePolling();
      render();
      setFlash("已退出登录。");
      return;
    }

    if (action === "copy-invite") {
      const encoded = actionButton.getAttribute("data-copy-text") || "";
      const text = decodeURIComponent(encoded);
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        setFlash("邀请链接已复制。");
      } else {
        setFlash(`请手动复制：${text}`);
      }
      return;
    }

    if (action === "start-instance" && instanceId) {
      setBusy(`start:${instanceId}`);
      await request(`/api/instances/${instanceId}/start`, { method: "POST" });
      await loadInstances();
      setFlash("容器已启动。");
      return;
    }

    if (action === "stop-instance" && instanceId) {
      setBusy(`stop:${instanceId}`);
      await request(`/api/instances/${instanceId}/stop`, { method: "POST" });
      await loadInstances();
      setFlash("容器已停止。");
      return;
    }

    if (action === "restart-gateway" && instanceId) {
      setBusy(`gateway:${instanceId}`);
      await request(`/api/instances/${instanceId}/restart-gateway`, { method: "POST" });
      await loadInstances();
      setFlash("网关已重启。");
      return;
    }

    if (action === "wechat-bind" && instanceId) {
      setBusy(`wechat:${instanceId}`);
      await request(`/api/instances/${instanceId}/wechat-bind`, { method: "POST" });
      await loadInstances();
      setFlash("微信绑定流程已启动，二维码区域会持续刷新。");
      return;
    }

    if (action === "load-logs" && instanceId) {
      setBusy(`logs:${instanceId}`);
      await loadLogs(instanceId, 200);
      setFlash("日志已刷新。");
    }
  } catch (error) {
    syncPasswordGate(error);
    setFlash(error.message, "error");
  } finally {
    clearBusy();
  }
});

bootstrap().catch((error) => {
  setFlash(error.message || "初始化失败", "error");
});
