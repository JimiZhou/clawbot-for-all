import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword, verifyPassword } from "./auth.mjs";
import {
  createInstanceRecord,
  getInstancePaths,
  writeInstanceFiles,
} from "./openclaw-config.mjs";
import {
  execInstanceShell,
  getInstanceLogs,
  inspectInstance,
  restartInstance,
  startInstance,
  startWechatBindJob,
  stopInstance,
} from "./runtime.mjs";
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

const wechatJobs = new Map();
const provisioningJobs = new Map();

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
  const providerId = String(payload.providerId || existingModel?.providerId || "openai")
    .trim()
    .toLowerCase();
  const modelId = String(payload.modelId || existingModel?.modelId || "").trim();
  const apiMode = String(payload.apiMode || existingModel?.apiMode || "openai-responses").trim();
  const baseUrl = String(payload.baseUrl || existingModel?.baseUrl || "").trim();
  const apiKey = String(payload.apiKey || "").trim() || existingModel?.apiKey || "";

  if (!providerId || !modelId || !apiMode || !apiKey) {
    throw new Error("模型配置不完整，请填写 provider、model、api 模式和 key。");
  }

  return {
    providerId,
    modelId,
    apiMode,
    baseUrl,
    apiKey,
  };
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

  return next;
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

function startProvisioningJob(instanceId) {
  if (provisioningJobs.has(instanceId)) {
    return provisioningJobs.get(instanceId);
  }

  const job = (async () => {
    try {
      const initialDatabase = loadDatabase(dataDir);
      const initialInstance = initialDatabase.instances.find((record) => record.id === instanceId);
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

  let model;
  try {
    model = sanitizeModelPayload(body);
  } catch (error) {
    sendJson(response, 400, { error: error.message });
    return;
  }

  const database = loadDatabase(dataDir);
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

  startProvisioningJob(instance.id);

  sendJson(response, 202, {
    instance: publicInstanceForHost(instance, resolveRequestHost(request)),
  });
}

async function handleUpdateModel(request, response, instanceId) {
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
    instance.model = sanitizeModelPayload(body, instance.model);
  } catch (error) {
    sendJson(response, 400, { error: error.message });
    return;
  }

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

async function handleStartInstance(request, response, instanceId) {
  const user = requireUser(request, response);
  if (!user) {
    return;
  }

  const instance = findOwnedInstance(user, instanceId);
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

  const instance = findOwnedInstance(user, instanceId);
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

  patchWechatState(instance.id, {
    status: "starting",
    updatedAt: nowIso(),
    qrMode: null,
    qrPayload: "",
    outputSnippet: "已进入容器，正在安装 / 更新微信插件并拉起扫码登录流程。",
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

    if (request.method === "GET" && pathname === "/api/instances") {
      await handleListInstances(request, response);
      return;
    }

    if (request.method === "POST" && pathname === "/api/instances") {
      await handleCreateInstance(request, response);
      return;
    }

    const instanceMatch = pathname.match(/^\/api\/instances\/([^/]+)\/(model|start|stop|wechat-bind|logs|plugins|restart-gateway)$/);
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
    }

    serveStaticFile(pathname, response);
  } catch (error) {
    sendJson(response, 500, {
      error: String(error.message || error),
    });
  }
});

server.listen(port, host, () => {
  console.log(`Clawbot for All running at http://${host}:${port}`);
});
