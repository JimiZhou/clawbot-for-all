import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword, verifyPassword } from "./auth.mjs";
import {
  createInstanceRecord,
  getInstancePaths,
  writeInstanceFiles,
} from "./openclaw-config.mjs";
import {
  buildProviderConfigFromModel,
  getModelProviderDefinition,
  listModelProviders,
  normalizeModelSelection,
  sanitizeModelSelectionPayload,
} from "./model-providers.mjs";
import { withWechatPluginEnabled } from "./wechat-plugin.mjs";
import {
  execInstanceShell,
  getRunnerImageStatus,
  getInstanceLogs,
  getInstanceStats,
  inspectInstance,
  refreshRunnerImage,
  restartInstance,
  sendInteractiveInput,
  setRuntimeLogger,
  startInstance,
  startInteractiveInstanceCommand,
  startWechatBindJob,
  stopInstance,
  warmRunnerImageInBackground,
} from "./runtime.mjs";
import { getServerLogPath, initServerLogger, logServer, readServerLogs } from "./server-log.mjs";
import { createSessionRecord, ensureDatabase, loadDatabase, mutateDatabase } from "./store.mjs";
import {
  buildRequestOrigin,
  ensureDir,
  guessContentType,
  nowIso,
  parseCookies,
  parseRequestBody,
  publicInstanceForHost,
  publicInvite,
  publicUser,
  randomId,
  readJsonFile,
  sanitizeEmail,
  sanitizeName,
  sendJson,
  setCookieHeader,
  trimTo,
} from "./utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const publicDir = path.join(projectRoot, "public");
const dataDir = path.join(projectRoot, "data");
const sessionCookieName = "clawbot_session";
const port = Number(process.env.PORT || 4300);
const host = process.env.HOST || "0.0.0.0";
const sessionTtlDays = Number(process.env.SESSION_TTL_DAYS || 14);
const publicOrigin = String(process.env.PUBLIC_ORIGIN || "").trim();
const rawAdminEmail = String(process.env.ADMIN_EMAIL || "");
const rawAdminName = String(process.env.ADMIN_NAME || "");
const rawAdminPassword = String(process.env.ADMIN_PASSWORD || "");
const adminEmail = sanitizeEmail(rawAdminEmail);
const adminName = sanitizeName(rawAdminName || "平台管理员");
const adminPassword = String(rawAdminPassword);

ensureDir(dataDir);
ensureDatabase(dataDir);
initServerLogger(dataDir);
setRuntimeLogger(logServer);

const wechatJobs = new Map();
const provisioningJobs = new Map();
const modelAuthJobs = new Map();

function validatePassword(password) {
  return String(password || "").length >= 8;
}

function sanitizeInviteCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function buildInviteCode() {
  return `INV-${randomId(4).toUpperCase()}`;
}

function sanitizeInvitePayload(payload = {}) {
  const note = trimTo(sanitizeName(payload.note || ""), 60);
  const maxUsesRaw = Number(payload.maxUses || 1);
  const maxUses = Number.isInteger(maxUsesRaw) && maxUsesRaw > 0 ? maxUsesRaw : 1;
  const expiresAtRaw = String(payload.expiresAt || "").trim();
  const code = payload.code ? sanitizeInviteCode(payload.code) : buildInviteCode();

  if (!code) {
    throw new Error("邀请码格式无效。");
  }

  let expiresAt = null;
  if (expiresAtRaw) {
    const parsed = new Date(expiresAtRaw);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error("邀请码过期时间格式不正确。");
    }
    if (parsed.getTime() <= Date.now()) {
      throw new Error("邀请码过期时间必须晚于当前时间。");
    }
    expiresAt = parsed.toISOString();
  }

  return {
    code,
    note,
    maxUses,
    expiresAt,
  };
}

function sanitizeModelPayload(payload, existingModel = null) {
  return sanitizeModelSelectionPayload(payload, existingModel);
}

function sanitizePluginsPayload(payload, existingPlugins = null) {
  const next = {
    allow: Array.isArray(existingPlugins?.allow) ? [...existingPlugins.allow] : [],
    entries: existingPlugins?.entries && typeof existingPlugins.entries === "object"
      ? { ...existingPlugins.entries }
      : {},
  };

  if ("allow" in payload) {
    if (!Array.isArray(payload.allow)) {
      throw new Error("plugins.allow 必须是字符串数组。");
    }

    next.allow = [...new Set(
      payload.allow
        .map((item) => String(item || "").trim())
        .filter(Boolean),
    )];
  }

  if ("entries" in payload) {
    if (!payload.entries || typeof payload.entries !== "object" || Array.isArray(payload.entries)) {
      throw new Error("plugins.entries 必须是对象。");
    }

    next.entries = payload.entries;
  }

  return withWechatPluginEnabled(next);
}

function ensureAdminAccount() {
  const adminEnvProvided = Boolean(rawAdminEmail || rawAdminName || rawAdminPassword);
  if (!adminEnvProvided) {
    return;
  }

  if (!adminEmail || !adminName || !validatePassword(adminPassword)) {
    throw new Error("管理员账号环境变量无效。请配置 ADMIN_EMAIL、ADMIN_NAME、ADMIN_PASSWORD，且密码至少 8 位。");
  }

  mutateDatabase(dataDir, (draft) => {
    let user = draft.users.find((record) => record.email === adminEmail);
    if (user) {
      user.role = "admin";
      user.name = user.name || adminName;
      user.updatedAt = nowIso();
      return;
    }

    const passwordRecord = hashPassword(adminPassword);
    const createdAt = nowIso();
    draft.users.push({
      id: `user_${Date.now().toString(36)}`,
      email: adminEmail,
      name: adminName,
      role: "admin",
      mustChangePassword: true,
      passwordHash: passwordRecord.hash,
      passwordSalt: passwordRecord.salt,
      createdAt,
      updatedAt: createdAt,
    });
  });
}

ensureAdminAccount();
logServer("info", "Server 初始化完成。", {
  dataDir,
  serverLogPath: getServerLogPath(),
});

function resolveRequestHost(request) {
  return request.headers["x-forwarded-host"] || request.headers.host || "";
}

function resolveRequestOrigin(request) {
  return publicOrigin || buildRequestOrigin(request);
}

function getSessionUser(request) {
  const cookies = parseCookies(request.headers.cookie || "");
  const sessionId = cookies[sessionCookieName];
  if (!sessionId) {
    return null;
  }

  const database = loadDatabase(dataDir);
  const session = database.sessions.find((record) => record.id === sessionId);
  if (!session) {
    return null;
  }

  if (new Date(session.expiresAt).getTime() < Date.now()) {
    mutateDatabase(dataDir, (draft) => {
      draft.sessions = draft.sessions.filter((record) => record.id !== session.id);
    });
    return null;
  }

  return database.users.find((record) => record.id === session.userId) || null;
}

function requireUser(request, response, options = {}) {
  const user = getSessionUser(request);
  if (!user) {
    sendJson(response, 401, { error: "请先登录。" });
    return null;
  }

  if (!options.allowMustChangePassword && user.mustChangePassword) {
    sendJson(response, 403, {
      error: "首次登录后必须先修改密码。",
      requirePasswordChange: true,
      user: publicUser(user),
    });
    return null;
  }

  if (options.requireAdmin && user.role !== "admin") {
    sendJson(response, 403, { error: "需要管理员权限。" });
    return null;
  }

  return user;
}

function findOwnedInstance(user, instanceId) {
  const database = loadDatabase(dataDir);
  return database.instances.find((record) => record.id === instanceId && record.userId === user.id) || null;
}

function getInviteValidationError(invite) {
  if (!invite) {
    return "邀请码无效。";
  }

  if (invite.revoked) {
    return "邀请码已失效。";
  }

  if (invite.expiresAt && new Date(invite.expiresAt).getTime() <= Date.now()) {
    return "邀请码已过期。";
  }

  if ((invite.uses || 0) >= (invite.maxUses || 1)) {
    return "邀请码已达到使用次数上限。";
  }

  return "";
}

function listWechatAccountIds(stateDir) {
  const indexed = readJsonFile(path.join(stateDir, "accounts.json"), []);
  const accountsDir = path.join(stateDir, "accounts");
  const accountIds = new Set(Array.isArray(indexed) ? indexed.filter(Boolean).map(String) : []);

  if (fs.existsSync(accountsDir) && fs.statSync(accountsDir).isDirectory()) {
    for (const entry of fs.readdirSync(accountsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      accountIds.add(entry.name.replace(/\.json$/i, ""));
    }
  }

  return [...accountIds];
}

function readWechatPairedAccounts(instance) {
  const { homeDir } = getInstancePaths(dataDir, instance.id);
  const stateDir = path.join(homeDir, ".openclaw", "openclaw-weixin");
  if (!fs.existsSync(stateDir)) {
    return [];
  }

  return listWechatAccountIds(stateDir)
    .map((accountId) => {
      const payload = readJsonFile(path.join(stateDir, "accounts", `${accountId}.json`), {});
      return {
        accountId,
        userId: typeof payload?.userId === "string" ? payload.userId : "",
        baseUrl: typeof payload?.baseUrl === "string" ? payload.baseUrl : "",
        savedAt: payload?.savedAt || null,
      };
    })
    .filter((record) => record.accountId);
}

function mergeWechatPairedAccounts(instance) {
  const pairedAccounts = readWechatPairedAccounts(instance);
  const binding = instance.wechatBinding || {};
  instance.wechatBinding = {
    status: pairedAccounts.length && binding.status !== "error" ? "connected" : binding.status || "idle",
    updatedAt: binding.updatedAt || (pairedAccounts.length ? nowIso() : null),
    qrMode: binding.qrMode || null,
    qrPayload: binding.qrPayload || "",
    outputSnippet: binding.outputSnippet || "",
    pairedAccounts,
  };
  return instance;
}

async function refreshInstanceRuntimeState(instanceId) {
  const database = loadDatabase(dataDir);
  const instance = database.instances.find((record) => record.id === instanceId);
  if (!instance) {
    return null;
  }

  const runtimeState = await inspectInstance(instance);
  instance.status = runtimeState.status;
  mergeWechatPairedAccounts(instance);
  instance.updatedAt = nowIso();

  mutateDatabase(dataDir, (draft) => {
    const target = draft.instances.find((record) => record.id === instance.id);
    if (!target) {
      return;
    }

    target.status = instance.status;
    target.updatedAt = instance.updatedAt;
    target.wechatBinding = instance.wechatBinding;
  });

  return instance;
}

async function listUserInstances(user, request) {
  const database = loadDatabase(dataDir);
  const userInstances = database.instances.filter((record) => record.userId === user.id);
  await Promise.all(userInstances.map((instance) => refreshInstanceRuntimeState(instance.id)));

  const latestDatabase = loadDatabase(dataDir);
  return latestDatabase.instances
    .filter((record) => record.userId === user.id)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
    .map((record) => publicInstanceForHost(record, resolveRequestHost(request)));
}

function updateProvisioning(instanceId, patch) {
  mutateDatabase(dataDir, (draft) => {
    const target = draft.instances.find((record) => record.id === instanceId);
    if (!target) {
      return;
    }

    target.provisioning = {
      ...(target.provisioning || {}),
      ...patch,
      updatedAt: nowIso(),
    };
    target.updatedAt = nowIso();
  });
}

function startProvisioningJob(instanceId, instanceSnapshot = null) {
  if (provisioningJobs.has(instanceId)) {
    return provisioningJobs.get(instanceId);
  }

  const job = (async () => {
    try {
      const initialInstance = instanceSnapshot
        || loadDatabase(dataDir).instances.find((record) => record.id === instanceId);
      if (!initialInstance) {
        return;
      }

      updateProvisioning(instanceId, {
        status: "running",
        percent: 18,
        stage: "writing-config",
        message: "正在写入实例目录、令牌和 OpenClaw 配置。",
      });

      writeInstanceFiles(dataDir, initialInstance);

      updateProvisioning(instanceId, {
        status: "running",
        percent: 56,
        stage: "starting-container",
        message: "正在拉起专属 OpenClaw 容器。",
      });

      const latestDatabase = loadDatabase(dataDir);
      const latestInstance = latestDatabase.instances.find((record) => record.id === instanceId);
      if (!latestInstance) {
        return;
      }

      const paths = getInstancePaths(dataDir, latestInstance.id);
      const runtimeState = await startInstance(projectRoot, paths, latestInstance);

      mutateDatabase(dataDir, (draft) => {
        const target = draft.instances.find((record) => record.id === instanceId);
        if (!target) {
          return;
        }

        target.status = runtimeState.status;
        target.provisioning = {
          status: "ready",
          percent: 100,
          stage: "ready",
          message: "实例已就绪，可以直接绑定微信或继续配置。",
          updatedAt: nowIso(),
        };
        target.updatedAt = nowIso();
      });
    } catch (error) {
      logServer("error", `实例创建失败：${instanceId}`, error);
      updateProvisioning(instanceId, {
        status: "error",
        percent: 100,
        stage: "error",
        message: trimTo(error.message || String(error), 240),
      });
    } finally {
      provisioningJobs.delete(instanceId);
    }
  })();

  provisioningJobs.set(instanceId, job);
  return job;
}

function patchWechatState(instanceId, patch) {
  mutateDatabase(dataDir, (draft) => {
    const target = draft.instances.find((record) => record.id === instanceId);
    if (!target) {
      return;
    }

    const merged = {
      ...(target.wechatBinding || {}),
      ...patch,
    };

    target.wechatBinding = merged;
    mergeWechatPairedAccounts(target);
    target.updatedAt = nowIso();
  });
}

function patchModelAuthState(instanceId, patch) {
  mutateDatabase(dataDir, (draft) => {
    const target = draft.instances.find((record) => record.id === instanceId);
    if (!target) {
      return;
    }

    target.modelAuth = {
      ...(target.modelAuth || {}),
      ...patch,
      updatedAt: nowIso(),
    };
    target.updatedAt = nowIso();
  });
}

function extractLastUrl(text) {
  const matches = String(text || "").match(/https?:\/\/[^\s"'<>]+/g);
  return matches?.length ? matches.at(-1) : "";
}

function extractPromptLabel(text) {
  const matches = [...String(text || "").matchAll(/◆\s+([^\n\r]+)/g)];
  if (matches.length) {
    return String(matches.at(-1)?.[1] || "").trim();
  }

  const fallback = [...String(text || "").matchAll(/(Paste [^\n\r]+|Enter [^\n\r]+)$/gim)];
  return fallback.length ? String(fallback.at(-1)?.[1] || "").trim() : "";
}

function inferModelAuthState(output, definition, current = {}) {
  const text = String(output || "");
  const promptLabel = extractPromptLabel(text);
  const authUrl = extractLastUrl(text);
  const needsInput =
    Boolean(promptLabel) ||
    /paste .*below/i.test(text) ||
    /paste .*redirect/i.test(text) ||
    /paste .*token/i.test(text) ||
    /enter the redirect url/i.test(text);

  let message = current.message || "正在执行登录流程。";
  if (definition?.authType === "device_code" && authUrl) {
    message = "请在浏览器完成授权，CLI 会自动轮询结果。";
  } else if (needsInput) {
    message = "CLI 正在等待输入。";
  }

  return {
    status: needsInput ? "waiting_input" : "running",
    message,
    outputSnippet: trimTo(text, 4000),
    authUrl,
    promptLabel,
    needsInput,
  };
}

function buildModelAuthCommand(definition) {
  return `openclaw models auth login --provider ${definition.authProviderId} --method ${definition.authMethodId}`;
}

function readInstanceOpenClawConfig(instanceId) {
  const { homeDir } = getInstancePaths(dataDir, instanceId);
  return readJsonFile(path.join(homeDir, "openclaw.json"), null);
}

function syncInstanceModelProviderConfig(instanceId) {
  mutateDatabase(dataDir, (draft) => {
    const target = draft.instances.find((record) => record.id === instanceId);
    if (!target?.model) {
      return;
    }

    const model = normalizeModelSelection(target.model);
    if (!model) {
      return;
    }

    const config = readInstanceOpenClawConfig(instanceId) || {};
    const providerConfig = config?.models?.providers?.[model.providerId];
    const primaryModel = config?.agents?.defaults?.model?.primary;

    target.model = {
      ...model,
      providerConfig: providerConfig && typeof providerConfig === "object" ? providerConfig : buildProviderConfigFromModel(model),
      modelId: typeof primaryModel === "string" && primaryModel.startsWith(`${model.providerId}/`)
        ? primaryModel.slice(model.providerId.length + 1)
        : model.modelId,
    };
    target.updatedAt = nowIso();
  });
}

async function ensureInstanceRunning(instance) {
  const runtimeState = await inspectInstance(instance);
  if (runtimeState.running) {
    return instance;
  }

  const paths = writeInstanceFiles(dataDir, instance);
  await startInstance(projectRoot, paths, instance);
  instance.status = "running";
  instance.updatedAt = nowIso();

  mutateDatabase(dataDir, (draft) => {
    const target = draft.instances.find((record) => record.id === instance.id);
    if (!target) {
      return;
    }

    target.status = "running";
    target.updatedAt = instance.updatedAt;
  });

  return instance;
}

function pickDefaultModelPreset(database) {
  const presets = Array.isArray(database?.modelPresets) ? database.modelPresets : [];
  if (!presets.length) {
    return null;
  }

  const exactOpenAIGpt54 = presets.find((preset) =>
    preset?.providerId === "openai" &&
    String(preset?.modelId || "").trim().toLowerCase() === "gpt-5.4",
  );
  if (exactOpenAIGpt54) {
    return exactOpenAIGpt54;
  }

  return presets[0] || null;
}

function ensureInstanceDefaultModel(instance) {
  if (instance?.model) {
    return instance;
  }

  const database = loadDatabase(dataDir);
  const defaultPreset = pickDefaultModelPreset(database);
  if (!defaultPreset) {
    return instance;
  }

  instance.model = sanitizeModelPayload(defaultPreset);
  instance.updatedAt = nowIso();

  mutateDatabase(dataDir, (draft) => {
    const target = draft.instances.find((record) => record.id === instance.id);
    if (!target || target.model) {
      return;
    }

    target.model = instance.model;
    target.updatedAt = instance.updatedAt;
  });

  return instance;
}

async function handleRegister(request, response) {
  let body;
  try {
    body = await parseRequestBody(request);
  } catch {
    sendJson(response, 400, { error: "请求体不是合法 JSON。" });
    return;
  }

  const email = sanitizeEmail(body.email);
  const name = sanitizeName(body.name);
  const password = String(body.password || "");
  const inviteCode = sanitizeInviteCode(body.inviteCode);

  if (!email || !name || !validatePassword(password) || !inviteCode) {
    sendJson(response, 400, { error: "注册信息不完整，请填写昵称、邮箱、邀请码，且密码至少 8 位。" });
    return;
  }

  const database = loadDatabase(dataDir);
  if (database.users.some((record) => record.email === email)) {
    sendJson(response, 409, { error: "该邮箱已注册。" });
    return;
  }

  const invite = database.invites.find((record) => record.code === inviteCode);
  const inviteError = getInviteValidationError(invite);
  if (inviteError) {
    sendJson(response, 400, { error: inviteError });
    return;
  }

  const passwordRecord = hashPassword(password);
  const createdAt = nowIso();
  const user = {
    id: `user_${Date.now().toString(36)}`,
    email,
    name,
    role: "user",
    mustChangePassword: false,
    passwordHash: passwordRecord.hash,
    passwordSalt: passwordRecord.salt,
    createdAt,
    updatedAt: createdAt,
  };
  const session = createSessionRecord(user.id, sessionTtlDays);

  mutateDatabase(dataDir, (draft) => {
    const targetInvite = draft.invites.find((record) => record.code === inviteCode);
    const targetInviteError = getInviteValidationError(targetInvite);
    if (targetInviteError) {
      throw new Error(targetInviteError);
    }

    targetInvite.uses = (targetInvite.uses || 0) + 1;
    draft.users.push(user);
    draft.sessions.push(session);
  });

  sendJson(
    response,
    201,
    { user: publicUser(user) },
    {
      "Set-Cookie": setCookieHeader(sessionCookieName, session.id, {
        maxAge: sessionTtlDays * 24 * 60 * 60,
      }),
    },
  );
}

async function handleLogin(request, response) {
  let body;
  try {
    body = await parseRequestBody(request);
  } catch {
    sendJson(response, 400, { error: "请求体不是合法 JSON。" });
    return;
  }

  const email = sanitizeEmail(body.email);
  const password = String(body.password || "");
  const database = loadDatabase(dataDir);
  const user = database.users.find((record) => record.email === email);

  if (!user || !verifyPassword(password, user)) {
    sendJson(response, 401, { error: "邮箱或密码错误。" });
    return;
  }

  const session = createSessionRecord(user.id, sessionTtlDays);
  mutateDatabase(dataDir, (draft) => {
    draft.sessions.push(session);
  });

  sendJson(
    response,
    200,
    { user: publicUser(user) },
    {
      "Set-Cookie": setCookieHeader(sessionCookieName, session.id, {
        maxAge: sessionTtlDays * 24 * 60 * 60,
      }),
    },
  );
}

async function handleLogout(request, response) {
  const cookies = parseCookies(request.headers.cookie || "");
  const sessionId = cookies[sessionCookieName];

  if (sessionId) {
    mutateDatabase(dataDir, (draft) => {
      draft.sessions = draft.sessions.filter((record) => record.id !== sessionId);
    });
  }

  sendJson(
    response,
    200,
    { ok: true },
    {
      "Set-Cookie": setCookieHeader(sessionCookieName, "", { maxAge: 0 }),
    },
  );
}

async function handleSession(request, response) {
  const user = getSessionUser(request);
  sendJson(response, 200, {
    user: publicUser(user),
  });
}

async function handleChangePassword(request, response) {
  const user = requireUser(request, response, { allowMustChangePassword: true });
  if (!user) {
    return;
  }

  let body;
  try {
    body = await parseRequestBody(request);
  } catch {
    sendJson(response, 400, { error: "请求体不是合法 JSON。" });
    return;
  }

  const currentPassword = String(body.currentPassword || "");
  const nextPassword = String(body.newPassword || "");

  if (!validatePassword(nextPassword)) {
    sendJson(response, 400, { error: "新密码至少 8 位。" });
    return;
  }

  if (!user.mustChangePassword && !verifyPassword(currentPassword, user)) {
    sendJson(response, 400, { error: "当前密码不正确。" });
    return;
  }

  const passwordRecord = hashPassword(nextPassword);

  mutateDatabase(dataDir, (draft) => {
    const target = draft.users.find((record) => record.id === user.id);
    if (!target) {
      return;
    }

    target.passwordHash = passwordRecord.hash;
    target.passwordSalt = passwordRecord.salt;
    target.mustChangePassword = false;
    target.updatedAt = nowIso();
  });

  const latestUser = loadDatabase(dataDir).users.find((record) => record.id === user.id);
  sendJson(response, 200, {
    user: publicUser(latestUser),
  });
}

async function handleListInvites(request, response) {
  const user = requireUser(request, response, { requireAdmin: true });
  if (!user) {
    return;
  }

  const database = loadDatabase(dataDir);
  const origin = resolveRequestOrigin(request);
  const invites = [...database.invites]
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
    .map((invite) => publicInvite(invite, origin));

  sendJson(response, 200, { invites });
}

async function handleCreateInvite(request, response) {
  const user = requireUser(request, response, { requireAdmin: true });
  if (!user) {
    return;
  }

  let body;
  try {
    body = await parseRequestBody(request);
  } catch {
    sendJson(response, 400, { error: "请求体不是合法 JSON。" });
    return;
  }

  let payload;
  try {
    payload = sanitizeInvitePayload(body);
  } catch (error) {
    sendJson(response, 400, { error: error.message });
    return;
  }

  const database = loadDatabase(dataDir);
  if (database.invites.some((record) => record.code === payload.code)) {
    sendJson(response, 409, { error: "邀请码已存在，请更换 code。" });
    return;
  }

  const invite = {
    id: `invite_${Date.now().toString(36)}`,
    code: payload.code,
    note: payload.note,
    createdBy: user.id,
    createdAt: nowIso(),
    expiresAt: payload.expiresAt,
    maxUses: payload.maxUses,
    uses: 0,
    revoked: false,
  };

  mutateDatabase(dataDir, (draft) => {
    draft.invites.push(invite);
  });

  sendJson(response, 201, {
    invite: publicInvite(invite, resolveRequestOrigin(request)),
  });
}

async function handleRevokeInvite(request, response, inviteId) {
  const user = requireUser(request, response, { requireAdmin: true });
  if (!user) {
    return;
  }

  const database = loadDatabase(dataDir);
  const invite = database.invites.find((record) => record.id === inviteId);
  if (!invite) {
    sendJson(response, 404, { error: "邀请码不存在。" });
    return;
  }

  if (invite.revoked) {
    sendJson(response, 200, {
      invite: publicInvite(invite, resolveRequestOrigin(request)),
    });
    return;
  }

  mutateDatabase(dataDir, (draft) => {
    const target = draft.invites.find((record) => record.id === inviteId);
    if (!target) {
      return;
    }

    target.revoked = true;
  });

  const latest = loadDatabase(dataDir).invites.find((record) => record.id === inviteId) || invite;
  sendJson(response, 200, {
    invite: publicInvite(latest, resolveRequestOrigin(request)),
  });
}

async function handleListInstances(request, response) {
  const user = requireUser(request, response);
  if (!user) {
    return;
  }

  sendJson(response, 200, {
    instances: await listUserInstances(user, request),
  });
}

async function handleCreateInstance(request, response) {
  const user = requireUser(request, response);
  if (!user) {
    return;
  }

  let body;
  try {
    body = await parseRequestBody(request);
  } catch {
    sendJson(response, 400, { error: "请求体不是合法 JSON。" });
    return;
  }

  const name = sanitizeName(body.name);
  if (!name) {
    sendJson(response, 400, { error: "实例名称不能为空。" });
    return;
  }

  let model = null;
  const database = loadDatabase(dataDir);
  if (body.presetId) {
    const preset = (database.modelPresets || []).find((p) => p.id === body.presetId);
    if (!preset) {
      sendJson(response, 400, { error: "所选模型预设不存在。" });
      return;
    }
    model = sanitizeModelPayload(preset);
  } else if (body.providerKey || body.providerId || body.modelId || body.apiKey) {
    try {
      model = sanitizeModelPayload(body);
    } catch (error) {
      sendJson(response, 400, { error: error.message });
      return;
    }
  } else {
    const defaultPreset = pickDefaultModelPreset(database);
    if (defaultPreset) {
      model = sanitizeModelPayload(defaultPreset);
    }
  }

  const existingCount = database.instances.filter((record) => record.userId === user.id).length;
  if (existingCount >= 1) {
    sendJson(response, 409, { error: "每个用户只能创建一个实例。" });
    return;
  }

  const nextIndex = database.instances.length + 1;
      const instance = createInstanceRecord({
        userId: user.id,
        name,
        model,
        nextIndex,
      });

  mutateDatabase(dataDir, (draft) => {
    draft.instances.push(instance);
  });

  startProvisioningJob(instance.id, instance);
  logServer("info", `用户已提交实例创建：${instance.id}`, {
    userId: user.id,
    instanceName: instance.name,
    runnerImage: getRunnerImageStatus().image,
  });

  sendJson(response, 202, {
    instance: publicInstanceForHost(instance, resolveRequestHost(request)),
  });
}

async function handleUpdateModel(request, response, instanceId) {
  const user = requireUser(request, response);
  if (!user) {
    return;
  }

  if (modelAuthJobs.has(instanceId)) {
    sendJson(response, 409, { error: "模型登录任务进行中，暂时不能修改模型配置。" });
    return;
  }

  let body;
  try {
    body = await parseRequestBody(request);
  } catch {
    sendJson(response, 400, { error: "请求体不是合法 JSON。" });
    return;
  }

  const database = loadDatabase(dataDir);
  const instance = database.instances.find((record) => record.id === instanceId && record.userId === user.id);
  if (!instance) {
    sendJson(response, 404, { error: "实例不存在。" });
    return;
  }

  if (body.presetId) {
    const preset = (database.modelPresets || []).find((p) => p.id === body.presetId);
    if (!preset) {
      sendJson(response, 400, { error: "所选模型预设不存在。" });
      return;
    }
    instance.model = sanitizeModelPayload(preset, instance.model);
  } else {
    try {
      instance.model = sanitizeModelPayload(body, instance.model);
    } catch (error) {
      sendJson(response, 400, { error: error.message });
      return;
    }
  }

  instance.modelAuth = {
    status: "idle",
    updatedAt: nowIso(),
    message: "",
    outputSnippet: "",
    authUrl: "",
    promptLabel: "",
    needsInput: false,
  };

  instance.updatedAt = nowIso();
  const paths = writeInstanceFiles(dataDir, instance);
  const runtimeState = await inspectInstance(instance);

  if (runtimeState.running) {
    await restartInstance(projectRoot, paths, instance);
    instance.status = "running";
  } else {
    instance.status = runtimeState.status;
  }

  mutateDatabase(dataDir, (draft) => {
    const target = draft.instances.find((record) => record.id === instance.id);
    if (!target) {
      return;
    }
    Object.assign(target, instance);
  });

  sendJson(response, 200, {
    instance: publicInstanceForHost(instance, resolveRequestHost(request)),
  });
}

async function handleUpdatePlugins(request, response, instanceId) {
  const user = requireUser(request, response);
  if (!user) {
    return;
  }

  let body;
  try {
    body = await parseRequestBody(request);
  } catch {
    sendJson(response, 400, { error: "请求体不是合法 JSON。" });
    return;
  }

  const database = loadDatabase(dataDir);
  const instance = database.instances.find((record) => record.id === instanceId && record.userId === user.id);
  if (!instance) {
    sendJson(response, 404, { error: "实例不存在。" });
    return;
  }

  try {
    instance.plugins = sanitizePluginsPayload(body, instance.plugins);
  } catch (error) {
    sendJson(response, 400, { error: error.message });
    return;
  }

  instance.updatedAt = nowIso();
  writeInstanceFiles(dataDir, instance);

  const runtimeState = await inspectInstance(instance);
  instance.status = runtimeState.status;
  if (runtimeState.running) {
    await execInstanceShell(instance, "openclaw gateway restart", { timeoutMs: 60 * 1000 });
  }

  mutateDatabase(dataDir, (draft) => {
    const target = draft.instances.find((record) => record.id === instance.id);
    if (!target) {
      return;
    }
    Object.assign(target, instance);
  });

  sendJson(response, 200, {
    instance: publicInstanceForHost(instance, resolveRequestHost(request)),
  });
}

async function handleListModelProviders(request, response) {
  const user = requireUser(request, response);
  if (!user) {
    return;
  }

  sendJson(response, 200, {
    providers: listModelProviders(),
  });
}

async function handleStartModelAuth(request, response, instanceId) {
  const user = requireUser(request, response);
  if (!user) {
    return;
  }

  if (modelAuthJobs.has(instanceId)) {
    sendJson(response, 409, { error: "当前实例已有模型登录任务在执行中。" });
    return;
  }

  const instance = findOwnedInstance(user, instanceId);
  if (!instance) {
    sendJson(response, 404, { error: "实例不存在。" });
    return;
  }

  instance.model = normalizeModelSelection(instance.model);
  if (!instance.model) {
    sendJson(response, 400, { error: "请先保存模型配置。" });
    return;
  }

  const definition = getModelProviderDefinition(instance.model.providerKey);
  if (!definition?.supportsInteractiveAuth) {
    sendJson(response, 400, { error: "当前模型不需要交互式登录。" });
    return;
  }

  await ensureInstanceRunning(instance);

  patchModelAuthState(instance.id, {
    status: "starting",
    message: "正在启动模型登录流程。",
    outputSnippet: "",
    authUrl: "",
    promptLabel: "",
    needsInput: false,
  });

  const command = buildModelAuthCommand(definition);
  const runtimeEnv = definition.forceRemoteOAuth
    ? {
        SSH_CONNECTION: "127.0.0.1 2222 2222",
        SSH_CLIENT: "127.0.0.1 2222 2222",
        SSH_TTY: "/dev/pts/1",
      }
    : {};

  const job = startInteractiveInstanceCommand(instance, command, {
    env: runtimeEnv,
    timeoutMs: 15 * 60 * 1000,
  }, {
    onUpdate: ({ output }) => {
      patchModelAuthState(instance.id, inferModelAuthState(output, definition));
    },
    onExit: async ({ code, signal, timedOut, output }) => {
      const modelJob = modelAuthJobs.get(instance.id);
      const cancelled = Boolean(modelJob?.cancelRequested);
      modelAuthJobs.delete(instance.id);

      if (timedOut) {
        patchModelAuthState(instance.id, {
          status: "error",
          message: "模型登录超时，请重试。",
          outputSnippet: trimTo(output, 4000),
          needsInput: false,
        });
        return;
      }

      if (cancelled || signal === "SIGTERM") {
        patchModelAuthState(instance.id, {
          status: "cancelled",
          message: "模型登录已取消。",
          outputSnippet: trimTo(output, 4000),
          needsInput: false,
        });
        return;
      }

      if (code === 0) {
        syncInstanceModelProviderConfig(instance.id);
        try {
          await execInstanceShell(instance, "openclaw gateway restart", { timeoutMs: 60 * 1000 });
        } catch {}
        patchModelAuthState(instance.id, {
          status: "success",
          message: "模型登录已完成。",
          outputSnippet: trimTo(output, 4000),
          needsInput: false,
          promptLabel: "",
        });
        return;
      }

      patchModelAuthState(instance.id, {
        status: "error",
        message: "模型登录失败，请查看输出信息。",
        outputSnippet: trimTo(output, 4000),
        needsInput: false,
      });
    },
  });

  modelAuthJobs.set(instance.id, {
    ...job,
    cancelRequested: false,
  });

  const latest = loadDatabase(dataDir).instances.find((record) => record.id === instance.id) || instance;
  sendJson(response, 202, {
    instance: publicInstanceForHost(latest, resolveRequestHost(request)),
  });
}

async function handleModelAuthInput(request, response, instanceId) {
  const user = requireUser(request, response);
  if (!user) {
    return;
  }

  const instance = findOwnedInstance(user, instanceId);
  if (!instance) {
    sendJson(response, 404, { error: "实例不存在。" });
    return;
  }

  const job = modelAuthJobs.get(instance.id);
  if (!job) {
    sendJson(response, 409, { error: "当前没有等待输入的模型登录任务。" });
    return;
  }

  let body;
  try {
    body = await parseRequestBody(request);
  } catch {
    sendJson(response, 400, { error: "请求体不是合法 JSON。" });
    return;
  }

  const text = String(body.text || "").trim();
  if (!text) {
    sendJson(response, 400, { error: "请输入要提交给 CLI 的内容。" });
    return;
  }

  sendInteractiveInput(job, `${text}\n`);
  patchModelAuthState(instance.id, {
    status: "running",
    message: "输入已发送，等待 CLI 继续处理。",
    needsInput: false,
  });

  const latest = loadDatabase(dataDir).instances.find((record) => record.id === instance.id) || instance;
  sendJson(response, 202, {
    instance: publicInstanceForHost(latest, resolveRequestHost(request)),
  });
}

async function handleCancelModelAuth(request, response, instanceId) {
  const user = requireUser(request, response);
  if (!user) {
    return;
  }

  const instance = findOwnedInstance(user, instanceId);
  if (!instance) {
    sendJson(response, 404, { error: "实例不存在。" });
    return;
  }

  const job = modelAuthJobs.get(instance.id);
  if (!job) {
    sendJson(response, 409, { error: "当前没有进行中的模型登录任务。" });
    return;
  }

  job.cancelRequested = true;
  job.cancel();

  sendJson(response, 200, { ok: true });
}

async function handleStartInstance(request, response, instanceId) {
  const user = requireUser(request, response);
  if (!user) {
    return;
  }

  const instance = ensureInstanceDefaultModel(findOwnedInstance(user, instanceId));
  if (!instance) {
    sendJson(response, 404, { error: "实例不存在。" });
    return;
  }

  if (instance.provisioning?.status === "running") {
    sendJson(response, 409, { error: "实例仍在创建中，请稍后再试。" });
    return;
  }

  const paths = writeInstanceFiles(dataDir, instance);
  const runtimeState = await startInstance(projectRoot, paths, instance);

  mutateDatabase(dataDir, (draft) => {
    const target = draft.instances.find((record) => record.id === instance.id);
    if (!target) {
      return;
    }

    target.status = runtimeState.status;
    target.updatedAt = nowIso();
  });

  const latest = await refreshInstanceRuntimeState(instance.id);
  sendJson(response, 200, {
    instance: publicInstanceForHost(latest || instance, resolveRequestHost(request)),
  });
}

async function handleStopInstance(request, response, instanceId) {
  const user = requireUser(request, response);
  if (!user) {
    return;
  }

  const instance = findOwnedInstance(user, instanceId);
  if (!instance) {
    sendJson(response, 404, { error: "实例不存在。" });
    return;
  }

  await stopInstance(instance);

  mutateDatabase(dataDir, (draft) => {
    const target = draft.instances.find((record) => record.id === instance.id);
    if (!target) {
      return;
    }

    target.status = "stopped";
    target.updatedAt = nowIso();
  });

  const latest = loadDatabase(dataDir).instances.find((record) => record.id === instance.id) || instance;
  sendJson(response, 200, {
    instance: publicInstanceForHost(latest, resolveRequestHost(request)),
  });
}

async function handleInstanceLogs(request, response, instanceId, url) {
  const user = requireUser(request, response);
  if (!user) {
    return;
  }

  const instance = findOwnedInstance(user, instanceId);
  if (!instance) {
    sendJson(response, 404, { error: "实例不存在。" });
    return;
  }

  const tailRaw = Number(url.searchParams.get("tail") || 200);
  const tail = Number.isFinite(tailRaw) ? Math.max(20, Math.min(2000, Math.floor(tailRaw))) : 200;
  const logs = await getInstanceLogs(instance, tail);

  sendJson(response, 200, {
    logs,
    tail,
  });
}

async function handleRestartGateway(request, response, instanceId) {
  const user = requireUser(request, response);
  if (!user) {
    return;
  }

  const instance = findOwnedInstance(user, instanceId);
  if (!instance) {
    sendJson(response, 404, { error: "实例不存在。" });
    return;
  }

  const runtimeState = await inspectInstance(instance);
  if (!runtimeState.running) {
    sendJson(response, 409, { error: "请先启动实例，再重启网关。" });
    return;
  }

  await execInstanceShell(instance, "openclaw gateway restart", { timeoutMs: 60 * 1000 });
  const latest = await refreshInstanceRuntimeState(instance.id);

  sendJson(response, 200, {
    instance: publicInstanceForHost(latest || instance, resolveRequestHost(request)),
  });
}

async function handleWechatBind(request, response, instanceId) {
  const user = requireUser(request, response);
  if (!user) {
    return;
  }

  const instance = ensureInstanceDefaultModel(findOwnedInstance(user, instanceId));
  if (!instance) {
    sendJson(response, 404, { error: "实例不存在。" });
    return;
  }

  if (instance.provisioning?.status !== "ready") {
    sendJson(response, 409, { error: "实例尚未创建完成，请等待实例就绪后再绑定微信。" });
    return;
  }

  const runtimeState = await inspectInstance(instance);
  if (!runtimeState.running) {
    sendJson(response, 409, { error: "请先启动该用户的 OpenClaw 容器，再进行微信绑定。" });
    return;
  }

  if (wechatJobs.has(instance.id)) {
    const latest = await refreshInstanceRuntimeState(instance.id);
    sendJson(response, 200, {
      instance: publicInstanceForHost(latest || instance, resolveRequestHost(request)),
    });
    return;
  }

  writeInstanceFiles(dataDir, instance);

  patchWechatState(instance.id, {
    status: "starting",
    updatedAt: nowIso(),
    qrMode: null,
    qrPayload: "",
    outputSnippet: "已进入容器，正在检查预装微信插件并拉起扫码登录流程。",
  });

  const job = startWechatBindJob(instance, {
    onUpdate: (patch) => {
      patchWechatState(instance.id, patch);
    },
    onExit: (patch) => {
      patchWechatState(instance.id, patch);
      wechatJobs.delete(instance.id);
    },
  });

  wechatJobs.set(instance.id, job);

  const latest = loadDatabase(dataDir).instances.find((record) => record.id === instance.id) || instance;
  sendJson(response, 202, {
    instance: publicInstanceForHost(latest, resolveRequestHost(request)),
  });
}

function findInstanceForProxy(user, instanceId) {
  const database = loadDatabase(dataDir);
  const instance = database.instances.find((record) => record.id === instanceId);
  if (!instance) {
    return null;
  }

  if (user.role === "admin" || instance.userId === user.id) {
    return instance;
  }

  return null;
}

function proxyRequest(request, response, instance, subPath, queryString) {
  const targetPort = instance.port;
  const targetPath = `/${subPath}${queryString ? `?${queryString}` : ""}`;

  const headers = { ...request.headers };
  delete headers.host;
  delete headers.cookie;
  headers.authorization = `Bearer ${instance.gatewayToken}`;

  const proxyReq = http.request(
    {
      hostname: "127.0.0.1",
      port: targetPort,
      path: targetPath,
      method: request.method,
      headers,
      timeout: 30_000,
    },
    (proxyRes) => {
      response.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(response, { end: true });
    },
  );

  proxyReq.on("timeout", () => {
    proxyReq.destroy();
    if (!response.headersSent) {
      sendJson(response, 502, { error: "代理请求超时。" });
    }
  });

  proxyReq.on("error", (error) => {
    logServer("error", `代理请求失败：${request.method} ${targetPath}`, error);
    if (!response.headersSent) {
      sendJson(response, 502, { error: "无法连接到实例服务。" });
    }
  });

  request.pipe(proxyReq, { end: true });
}

function serveStaticFile(requestPath, response) {
  const targetPath = path.join(publicDir, requestPath === "/" ? "index.html" : requestPath.slice(1));
  const resolvedPath = path.resolve(targetPath);
  if (!resolvedPath.startsWith(publicDir)) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  const filePath = fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()
    ? resolvedPath
    : path.join(publicDir, "index.html");

  response.writeHead(200, {
    "Content-Type": guessContentType(filePath),
  });
  fs.createReadStream(filePath).pipe(response);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
    const pathname = url.pathname;

    if (request.method === "GET" && pathname === "/api/health") {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && pathname === "/api/session") {
      await handleSession(request, response);
      return;
    }

    if (request.method === "POST" && pathname === "/api/register") {
      await handleRegister(request, response);
      return;
    }

    if (request.method === "POST" && pathname === "/api/login") {
      await handleLogin(request, response);
      return;
    }

    if (request.method === "POST" && pathname === "/api/logout") {
      await handleLogout(request, response);
      return;
    }

    if (request.method === "POST" && pathname === "/api/change-password") {
      await handleChangePassword(request, response);
      return;
    }

    if (request.method === "GET" && pathname === "/api/invites") {
      await handleListInvites(request, response);
      return;
    }

    if (request.method === "POST" && pathname === "/api/invites") {
      await handleCreateInvite(request, response);
      return;
    }

    const inviteMatch = pathname.match(/^\/api\/invites\/([^/]+)\/revoke$/);
    if (inviteMatch) {
      const [, inviteId] = inviteMatch;
      if (request.method === "POST") {
        await handleRevokeInvite(request, response, inviteId);
        return;
      }
    }

    if (request.method === "GET" && pathname === "/api/instances") {
      await handleListInstances(request, response);
      return;
    }

    if (request.method === "GET" && pathname === "/api/model-providers") {
      await handleListModelProviders(request, response);
      return;
    }

    if (request.method === "POST" && pathname === "/api/instances") {
      await handleCreateInstance(request, response);
      return;
    }

    const instanceMatch = pathname.match(/^\/api\/instances\/([^/]+)\/(model|start|stop|wechat-bind|logs|plugins|restart-gateway|stats)$/);
    if (instanceMatch) {
      const [, instanceId, action] = instanceMatch;

      if (request.method === "PUT" && action === "model") {
        await handleUpdateModel(request, response, instanceId);
        return;
      }

      if (request.method === "PUT" && action === "plugins") {
        await handleUpdatePlugins(request, response, instanceId);
        return;
      }

      if (request.method === "POST" && action === "start") {
        await handleStartInstance(request, response, instanceId);
        return;
      }

      if (request.method === "POST" && action === "stop") {
        await handleStopInstance(request, response, instanceId);
        return;
      }

      if (request.method === "POST" && action === "wechat-bind") {
        await handleWechatBind(request, response, instanceId);
        return;
      }

      if (request.method === "POST" && action === "restart-gateway") {
        await handleRestartGateway(request, response, instanceId);
        return;
      }

      if (request.method === "GET" && action === "logs") {
        await handleInstanceLogs(request, response, instanceId, url);
        return;
      }

      if (request.method === "GET" && action === "stats") {
        const user = requireUser(request, response);
        if (!user) return;
        const instance = findOwnedInstance(user, instanceId);
        if (!instance) {
          sendJson(response, 404, { error: "实例不存在。" });
          return;
        }
        const runtimeState = await inspectInstance(instance);
        if (!runtimeState.running) {
          sendJson(response, 200, { stats: null });
          return;
        }
        const stats = await getInstanceStats(instance);
        sendJson(response, 200, { stats });
        return;
      }
    }

    const instanceModelAuthMatch = pathname.match(/^\/api\/instances\/([^/]+)\/model-auth\/(start|input|cancel)$/);
    if (instanceModelAuthMatch) {
      const [, instanceId, action] = instanceModelAuthMatch;

      if (request.method === "POST" && action === "start") {
        await handleStartModelAuth(request, response, instanceId);
        return;
      }

      if (request.method === "POST" && action === "input") {
        await handleModelAuthInput(request, response, instanceId);
        return;
      }

      if (request.method === "POST" && action === "cancel") {
        await handleCancelModelAuth(request, response, instanceId);
        return;
      }
    }

    if (request.method === "GET" && pathname === "/api/admin/users") {
      const user = requireUser(request, response, { requireAdmin: true });
      if (!user) {
        return;
      }

      const database = loadDatabase(dataDir);
      const users = database.users.map((record) => publicUser(record));
      sendJson(response, 200, { users });
      return;
    }

    if (request.method === "GET" && pathname === "/api/admin/instances") {
      const user = requireUser(request, response, { requireAdmin: true });
      if (!user) {
        return;
      }

      const database = loadDatabase(dataDir);
      const usersById = Object.fromEntries(database.users.map((record) => [record.id, record]));
      await Promise.all(database.instances.map((instance) => refreshInstanceRuntimeState(instance.id)));
      const latestDatabase = loadDatabase(dataDir);
      const statsResults = await Promise.all(
        latestDatabase.instances.map(async (record) => {
          if (record.status === "running") {
            return getInstanceStats(record);
          }
          return null;
        }),
      );
      const instances = latestDatabase.instances.map((record, index) => ({
        ...publicInstanceForHost(record, resolveRequestHost(request)),
        userName: usersById[record.userId]?.name || "未知用户",
        userId: record.userId,
        stats: statsResults[index],
      }));
      sendJson(response, 200, { instances });
      return;
    }

    if (request.method === "GET" && pathname === "/api/admin/runner-image") {
      const user = requireUser(request, response, { requireAdmin: true });
      if (!user) {
        return;
      }

      sendJson(response, 200, { image: getRunnerImageStatus() });
      return;
    }

    if (request.method === "POST" && pathname === "/api/admin/runner-image/refresh") {
      const user = requireUser(request, response, { requireAdmin: true });
      if (!user) {
        return;
      }

      logServer("info", "管理员手动刷新 runner 镜像。", {
        adminUserId: user.id,
        image: getRunnerImageStatus().image,
      });
      const image = await refreshRunnerImage();
      sendJson(response, 200, { image });
      return;
    }

    if (request.method === "GET" && pathname === "/api/admin/server-logs") {
      const user = requireUser(request, response, { requireAdmin: true });
      if (!user) {
        return;
      }

      const tail = Math.max(50, Math.min(2000, Number(url.searchParams.get("tail") || 400)));
      const logs = readServerLogs(tail);
      sendJson(response, 200, { logs: { ...logs, tail } });
      return;
    }

    const adminUserMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
    if (adminUserMatch && request.method === "DELETE") {
      const user = requireUser(request, response, { requireAdmin: true });
      if (!user) {
        return;
      }

      const [, targetUserId] = adminUserMatch;
      const database = loadDatabase(dataDir);
      const targetUser = database.users.find((record) => record.id === targetUserId);
      if (!targetUser) {
        sendJson(response, 404, { error: "用户不存在。" });
        return;
      }

      if (targetUser.role === "admin") {
        sendJson(response, 403, { error: "不能删除管理员账号。" });
        return;
      }

      const userInstances = database.instances.filter((record) => record.userId === targetUserId);
      for (const instance of userInstances) {
        try {
          await stopInstance(instance);
        } catch {}
      }

      mutateDatabase(dataDir, (draft) => {
        draft.instances = draft.instances.filter((record) => record.userId !== targetUserId);
        draft.sessions = draft.sessions.filter((record) => record.userId !== targetUserId);
        draft.users = draft.users.filter((record) => record.id !== targetUserId);
      });

      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && pathname === "/api/model-presets") {
      const user = requireUser(request, response);
      if (!user) return;
      const database = loadDatabase(dataDir);
      const presets = (database.modelPresets || []).map((p) => ({
        id: p.id,
        name: p.name,
        providerKey: p.providerKey,
        providerId: p.providerId,
        modelId: p.modelId,
        apiMode: p.apiMode,
        authType: p.authType,
        authProviderId: p.authProviderId,
        authMethodId: p.authMethodId,
        baseUrl: p.baseUrl || "",
        createdAt: p.createdAt,
      }));
      sendJson(response, 200, { presets });
      return;
    }

    if (request.method === "POST" && pathname === "/api/admin/model-presets") {
      const user = requireUser(request, response, { requireAdmin: true });
      if (!user) return;
      let body;
      try { body = await parseRequestBody(request); } catch {
        sendJson(response, 400, { error: "请求体不是合法 JSON。" });
        return;
      }
      const name = sanitizeName(body.name);
      if (!name) { sendJson(response, 400, { error: "预设名称不能为空。" }); return; }
      let model;
      try { model = sanitizeModelPayload(body); } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      const preset = {
        id: `preset_${Date.now().toString(36)}`,
        name,
        ...model,
        createdAt: nowIso(),
      };
      mutateDatabase(dataDir, (draft) => {
        if (!draft.modelPresets) draft.modelPresets = [];
        draft.modelPresets.push(preset);
      });
      sendJson(response, 201, { preset: { ...preset, apiKey: undefined } });
      return;
    }

    const presetDeleteMatch = pathname.match(/^\/api\/admin\/model-presets\/([^/]+)$/);
    if (presetDeleteMatch && request.method === "PUT") {
      const user = requireUser(request, response, { requireAdmin: true });
      if (!user) return;
      const [, presetId] = presetDeleteMatch;
      let body;
      try { body = await parseRequestBody(request); } catch {
        sendJson(response, 400, { error: "请求体不是合法 JSON。" });
        return;
      }
      const name = sanitizeName(body.name);
      if (!name) { sendJson(response, 400, { error: "预设名称不能为空。" }); return; }
      const database = loadDatabase(dataDir);
      const existingPreset = (database.modelPresets || []).find((preset) => preset.id === presetId);
      if (!existingPreset) {
        sendJson(response, 404, { error: "预设不存在。" });
        return;
      }
      let model;
      try { model = sanitizeModelPayload(body, existingPreset); } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      const preset = {
        ...existingPreset,
        name,
        ...model,
      };
      mutateDatabase(dataDir, (draft) => {
        const target = (draft.modelPresets || []).find((item) => item.id === presetId);
        if (!target) return;
        Object.assign(target, preset);
      });
      sendJson(response, 200, { preset: { ...preset, apiKey: undefined } });
      return;
    }

    if (presetDeleteMatch && request.method === "DELETE") {
      const user = requireUser(request, response, { requireAdmin: true });
      if (!user) return;
      const [, presetId] = presetDeleteMatch;
      const database = loadDatabase(dataDir);
      if (!(database.modelPresets || []).some((p) => p.id === presetId)) {
        sendJson(response, 404, { error: "预设不存在。" });
        return;
      }
      mutateDatabase(dataDir, (draft) => {
        draft.modelPresets = (draft.modelPresets || []).filter((p) => p.id !== presetId);
      });
      sendJson(response, 200, { ok: true });
      return;
    }

    const proxyMatch = pathname.match(/^\/proxy\/([^/]+)(\/.*)?$/);
    if (proxyMatch) {
      const [, proxyInstanceId, rest] = proxyMatch;
      const user = getSessionUser(request);
      if (!user) {
        sendJson(response, 401, { error: "请先登录。" });
        return;
      }

      const instance = findInstanceForProxy(user, proxyInstanceId);
      if (!instance) {
        sendJson(response, 403, { error: "无权访问此实例。" });
        return;
      }

      const subPath = (rest || "/").slice(1);
      proxyRequest(request, response, instance, subPath, url.search.slice(1));
      return;
    }

    serveStaticFile(pathname, response);
  } catch (error) {
    logServer("error", `请求处理失败：${request.method} ${request.url || ""}`, error);
    sendJson(response, 500, {
      error: String(error.message || error),
    });
  }
});

server.on("upgrade", (request, socket, head) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
    const proxyMatch = url.pathname.match(/^\/proxy\/([^/]+)(\/.*)?$/);
    if (!proxyMatch) {
      socket.destroy();
      return;
    }

    const [, proxyInstanceId, rest] = proxyMatch;
    const user = getSessionUser(request);
    if (!user) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const instance = findInstanceForProxy(user, proxyInstanceId);
    if (!instance) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    const subPath = (rest || "/").slice(1);
    const targetPath = `/${subPath}${url.search}`;

    const target = net.connect(instance.port, "127.0.0.1", () => {
      const headers = { ...request.headers };
      delete headers.cookie;
      headers.host = `127.0.0.1:${instance.port}`;
      headers.authorization = `Bearer ${instance.gatewayToken}`;

      let rawHeader = `${request.method} ${targetPath} HTTP/1.1\r\n`;
      for (const [key, value] of Object.entries(headers)) {
        rawHeader += `${key}: ${value}\r\n`;
      }
      rawHeader += "\r\n";

      target.write(rawHeader);
      if (head.length > 0) {
        target.write(head);
      }
      socket.pipe(target);
      target.pipe(socket);
    });

    target.on("error", (error) => {
      logServer("error", `WebSocket 代理连接失败：${proxyInstanceId}`, error);
      socket.destroy();
    });

    socket.on("error", () => {
      target.destroy();
    });
  } catch (error) {
    logServer("error", "WebSocket upgrade 处理失败", error);
    socket.destroy();
  }
});

server.listen(port, host, () => {
  logServer("info", `Clawbot for All running at http://${host}:${port}`);
  logServer("info", "开始后台预热 runner 镜像。", {
    image: getRunnerImageStatus().image,
  });
  warmRunnerImageInBackground();
});
