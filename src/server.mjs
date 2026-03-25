import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword, verifyPassword } from "./auth.mjs";
import {
  buildOpenClawConfig,
  createInstanceRecord,
  getInstancePaths,
  INSTANCE_BASE_PORT,
  writeInstanceFiles,
} from "./openclaw-config.mjs";
import {
  buildProviderConfigFromModel,
  getModelProviderDefinition,
  listModelProviders,
  normalizeModelChain,
  normalizeModelSelection,
  sanitizeModelSelectionPayload,
} from "./model-providers.mjs";
import {
  isModelPresetConfigured,
  normalizeModelPresetPayload,
  resolveModelPresetForRuntime,
} from "./model-presets.mjs";
import { withWechatPluginEnabled } from "./wechat-plugin.mjs";
import {
  execInstanceShell,
  getRunnerImageStatus,
  getInstanceLogs,
  getInstanceStats,
  inspectInstanceBindMounts,
  inspectInstance,
  refreshRunnerImage,
  resolveHostBindPath,
  resolveInstanceProxyTarget,
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
  shellEscape,
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

function syncInstanceModelChainShape(instance) {
  if (!instance) return instance;
  const modelChain = normalizeModelChain(instance.modelChain, instance.model);
  instance.modelChain = modelChain;
  instance.model = modelChain[0] || null;
  return instance;
}

function replaceInstanceModelChain(instance, nextModelChain, { keepUpdatedAt = false } = {}) {
  syncInstanceModelChainShape(instance);
  instance.modelChain = normalizeModelChain(nextModelChain, null);
  instance.model = instance.modelChain[0] || null;
  if (!keepUpdatedAt) {
    instance.updatedAt = nowIso();
  }
  return instance;
}

function parseBooleanFlag(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function sortModelPresets(presets = []) {
  return [...presets].sort((left, right) => {
    const defaultDelta = Number(Boolean(right?.isDefault)) - Number(Boolean(left?.isDefault));
    if (defaultDelta !== 0) return defaultDelta;
    return new Date(right?.createdAt || 0).getTime() - new Date(left?.createdAt || 0).getTime();
  });
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
void (async () => {
  await repairInstancesMissingModelInBackground();
  await repairInstanceConfigDriftInBackground();
  await repairInstanceMountDriftInBackground();
})();

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

function getWechatStateDir(instance) {
  const { homeDir } = getInstancePaths(dataDir, instance.id);
  return path.join(homeDir, ".openclaw", "openclaw-weixin");
}

function createIdleWechatBinding(message = "") {
  return {
    status: "idle",
    updatedAt: message ? nowIso() : null,
    qrMode: null,
    qrPayload: "",
    qrLink: "",
    outputSnippet: message,
    pairedAccounts: [],
  };
}

function mergeWechatPairedAccounts(instance) {
  const pairedAccounts = readWechatPairedAccounts(instance);
  const binding = instance.wechatBinding || {};
  instance.wechatBinding = {
    status: pairedAccounts.length && binding.status !== "error" ? "connected" : binding.status || "idle",
    updatedAt: binding.updatedAt || (pairedAccounts.length ? nowIso() : null),
    qrMode: binding.qrMode || null,
    qrPayload: binding.qrPayload || "",
    qrLink: binding.qrLink || "",
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

      const ensured = ensureInstanceDefaultModel(initialInstance);
      if (!ensured.instance) {
        return;
      }
      if (ensured.error) {
        throw new Error(ensured.error);
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

      const runtimeState = await startInstanceWithPortRecovery(latestInstance);

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

function hasInstanceConfigDrift(instance) {
  if (!instance) {
    return false;
  }

  syncInstanceModelChainShape(instance);
  const current = readInstanceOpenClawConfig(instance.id);
  const expected = buildOpenClawConfig(instance);
  return JSON.stringify(current || null) !== JSON.stringify(expected);
}

function syncInstanceModelProviderConfig(instanceId) {
  mutateDatabase(dataDir, (draft) => {
    const target = draft.instances.find((record) => record.id === instanceId);
    syncInstanceModelChainShape(target);
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

    const nextPrimary = {
      ...model,
      providerConfig: providerConfig && typeof providerConfig === "object" ? providerConfig : buildProviderConfigFromModel(model),
      modelId: typeof primaryModel === "string" && primaryModel.startsWith(`${model.providerId}/`)
        ? primaryModel.slice(model.providerId.length + 1)
        : model.modelId,
    };
    replaceInstanceModelChain(target, [nextPrimary, ...target.modelChain.slice(1)], { keepUpdatedAt: true });
    target.updatedAt = nowIso();
  });
}

function applyInstancePort(instance, portNumber) {
  instance.port = portNumber;
  instance.dashboardUrl = `http://127.0.0.1:${portNumber}/`;
  instance.updatedAt = nowIso();
  return instance;
}

function isInstancePortConflictError(error) {
  const text = String(error?.message || error || "").toLowerCase();
  return (
    text.includes("failed to set up container networking")
    || text.includes("external connectivity")
    || text.includes("port is already allocated")
    || text.includes("address already in use")
    || text.includes("bind for 0.0.0.0:")
  );
}

function isTcpPortAvailable(portNumber) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    const finalize = (available) => {
      try {
        probe.close(() => resolve(available));
      } catch {
        resolve(available);
      }
    };

    probe.once("error", (error) => {
      if (error?.code === "EADDRINUSE" || error?.code === "EACCES") {
        resolve(false);
        return;
      }
      resolve(false);
    });

    probe.once("listening", () => finalize(true));
    probe.listen(portNumber, "0.0.0.0");
  });
}

async function findAvailableInstancePort(database, { excludeInstanceId = "", startPort = INSTANCE_BASE_PORT + 1 } = {}) {
  const normalizedStartPort = Math.max(INSTANCE_BASE_PORT + 1, Number(startPort) || (INSTANCE_BASE_PORT + 1));
  const usedPorts = new Set(
    (database.instances || [])
      .filter((record) => record && record.id !== excludeInstanceId)
      .map((record) => Number(record.port))
      .filter((value) => Number.isInteger(value) && value > 0),
  );

  const tryPort = async (candidate) => {
    if (usedPorts.has(candidate)) {
      return null;
    }
    return (await isTcpPortAvailable(candidate)) ? candidate : null;
  };

  for (let candidate = normalizedStartPort; candidate < normalizedStartPort + 5000; candidate += 1) {
    const available = await tryPort(candidate);
    if (available) {
      return available;
    }
  }

  for (let candidate = INSTANCE_BASE_PORT + 1; candidate < normalizedStartPort; candidate += 1) {
    const available = await tryPort(candidate);
    if (available) {
      return available;
    }
  }

  throw new Error("未找到可用实例端口。请检查宿主机端口占用情况。");
}

async function reassignInstancePort(instance, startPort = INSTANCE_BASE_PORT + 1) {
  const database = loadDatabase(dataDir);
  const nextPort = await findAvailableInstancePort(database, {
    excludeInstanceId: instance.id,
    startPort,
  });

  if (nextPort === instance.port) {
    return false;
  }

  applyInstancePort(instance, nextPort);

  mutateDatabase(dataDir, (draft) => {
    const target = draft.instances.find((record) => record.id === instance.id);
    if (!target) {
      return;
    }
    applyInstancePort(target, nextPort);
  });

  return true;
}

async function startInstanceWithPortRecovery(instance) {
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const paths = writeInstanceFiles(dataDir, instance);
      return await startInstance(projectRoot, paths, instance);
    } catch (error) {
      lastError = error;
      if (attempt > 0 || !isInstancePortConflictError(error)) {
        throw error;
      }

      const previousPort = instance.port;
      const reassigned = await reassignInstancePort(instance, previousPort + 1);
      if (!reassigned) {
        throw error;
      }

      logServer("warn", `实例端口冲突，已自动切换端口后重试：${instance.id}`, {
        previousPort,
        nextPort: instance.port,
      });
    }
  }

  throw lastError;
}

async function restartManagedInstance(instance) {
  writeInstanceFiles(dataDir, instance);
  await stopInstance(instance);
  await startInstanceWithPortRecovery(instance);
  instance.status = "running";
  instance.updatedAt = nowIso();

  mutateDatabase(dataDir, (draft) => {
    const target = draft.instances.find((record) => record.id === instance.id);
    if (!target) {
      return;
    }
    Object.assign(target, {
      port: instance.port,
      dashboardUrl: instance.dashboardUrl,
      status: instance.status,
      updatedAt: instance.updatedAt,
    });
  });

  return instance;
}

async function ensureInstanceRunning(instance) {
  writeInstanceFiles(dataDir, instance);
  const runtimeState = await inspectInstance(instance);
  if (runtimeState.running) {
    return instance;
  }

  await startInstanceWithPortRecovery(instance);
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
  const presets = sortModelPresets(Array.isArray(database?.modelPresets) ? database.modelPresets : []);
  if (!presets.length) {
    return null;
  }

  const markedDefault = presets.find((preset) => preset?.isDefault);
  if (markedDefault) {
    return markedDefault;
  }

  return presets[0] || null;
}

function resolveDefaultRuntimeModel(database) {
  const defaultPreset = pickDefaultModelPreset(database);
  if (!defaultPreset) {
    return {
      preset: null,
      model: null,
      error: "当前实例没有默认模型。请先由管理员配置并设为默认，再启动实例或绑定微信。",
    };
  }

  try {
    return {
      preset: defaultPreset,
      model: resolveModelPresetForRuntime(defaultPreset),
      error: "",
    };
  } catch (error) {
    return {
      preset: defaultPreset,
      model: null,
      error: error.message || "默认模型预设不可用。",
    };
  }
}

function ensureInstanceDefaultModel(instance) {
  if (!instance) {
    return {
      instance: null,
      changed: false,
      error: "",
    };
  }

  syncInstanceModelChainShape(instance);
  if (instance.model) {
    return {
      instance,
      changed: false,
      error: "",
    };
  }

  const database = loadDatabase(dataDir);
  const resolved = resolveDefaultRuntimeModel(database);
  if (!resolved.model) {
    return {
      instance,
      changed: false,
      error: resolved.error,
    };
  }

  replaceInstanceModelChain(instance, [resolved.model]);

  mutateDatabase(dataDir, (draft) => {
    const target = draft.instances.find((record) => record.id === instance.id);
    if (!target) {
      return;
    }
    syncInstanceModelChainShape(target);
    if (target.model) {
      return;
    }
    target.model = instance.model;
    target.modelChain = instance.modelChain;
    target.updatedAt = instance.updatedAt;
  });

  return {
    instance,
    changed: true,
    error: "",
  };
}

async function repairInstancesMissingModelInBackground() {
  const database = loadDatabase(dataDir);
  const candidates = (database.instances || []).filter((instance) => {
    syncInstanceModelChainShape(instance);
    return !instance.model;
  });

  if (!candidates.length) {
    return;
  }

  const resolved = resolveDefaultRuntimeModel(database);
  if (!resolved.model) {
    logServer("warn", "检测到空模型实例，但当前没有可用默认模型，跳过自动修复。", {
      instanceIds: candidates.map((item) => item.id),
      error: resolved.error,
    });
    return;
  }

  for (const candidate of candidates) {
    try {
      replaceInstanceModelChain(candidate, [resolved.model]);

      mutateDatabase(dataDir, (draft) => {
        const target = draft.instances.find((record) => record.id === candidate.id);
        if (!target) {
          return;
        }
        syncInstanceModelChainShape(target);
        if (target.model) {
          return;
        }
        target.model = candidate.model;
        target.modelChain = candidate.modelChain;
        target.updatedAt = candidate.updatedAt;
      });

      writeInstanceFiles(dataDir, candidate);
      const runtimeState = await inspectInstance(candidate);
      if (runtimeState.running) {
        await restartManagedInstance(candidate);
      }

      logServer("info", `已自动修复空模型实例：${candidate.id}`, {
        runtimeStatus: runtimeState.status,
        primaryModel: `${candidate.model.providerId}/${candidate.model.modelId}`,
      });
    } catch (error) {
      logServer("error", `自动修复空模型实例失败：${candidate.id}`, error);
    }
  }
}

async function repairInstanceConfigDriftInBackground() {
  const database = loadDatabase(dataDir);
  const candidates = (database.instances || []).filter((instance) => hasInstanceConfigDrift(instance));

  if (!candidates.length) {
    return;
  }

  for (const candidate of candidates) {
    try {
      writeInstanceFiles(dataDir, candidate);
      const runtimeState = await inspectInstance(candidate);
      if (runtimeState.running) {
        await restartManagedInstance(candidate);
      }

      logServer("info", `已自动修复实例配置漂移：${candidate.id}`, {
        runtimeStatus: runtimeState.status,
        primaryModel: candidate.model ? `${candidate.model.providerId}/${candidate.model.modelId}` : null,
      });
    } catch (error) {
      logServer("error", `自动修复实例配置漂移失败：${candidate.id}`, error);
    }
  }
}

async function repairInstanceMountDriftInBackground() {
  const database = loadDatabase(dataDir);

  for (const candidate of database.instances || []) {
    try {
      const runtimeState = await inspectInstance(candidate);
      if (!runtimeState.running) {
        continue;
      }

      const paths = getInstancePaths(dataDir, candidate.id);
      const expectedHomeDir = await resolveHostBindPath(paths.homeDir);
      const expectedWorkspaceDir = await resolveHostBindPath(paths.workspaceDir);
      const actualMounts = await inspectInstanceBindMounts(candidate);

      const homeMismatch = String(actualMounts["/var/lib/openclaw"] || "") !== expectedHomeDir;
      const workspaceMismatch = String(actualMounts["/workspace"] || "") !== expectedWorkspaceDir;
      if (!homeMismatch && !workspaceMismatch) {
        continue;
      }

      await restartManagedInstance(candidate);
      logServer("info", `已自动修复实例挂载漂移：${candidate.id}`, {
        expectedHomeDir,
        expectedWorkspaceDir,
        actualHomeDir: actualMounts["/var/lib/openclaw"] || null,
        actualWorkspaceDir: actualMounts["/workspace"] || null,
      });
    } catch (error) {
      logServer("error", `自动修复实例挂载漂移失败：${candidate.id}`, error);
    }
  }
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
    try {
      model = resolveModelPresetForRuntime(preset);
    } catch (error) {
      sendJson(response, 400, { error: error.message });
      return;
    }
  } else if (body.providerKey || body.providerId || body.modelId || body.apiKey) {
    try {
      model = sanitizeModelPayload(body);
    } catch (error) {
      sendJson(response, 400, { error: error.message });
      return;
    }
  } else {
    const resolvedDefault = resolveDefaultRuntimeModel(database);
    if (resolvedDefault.error) {
      sendJson(response, 400, { error: resolvedDefault.error });
      return;
    }
    model = resolvedDefault.model;
  }

  if (!model) {
    sendJson(response, 400, {
      error: "当前没有可用的默认模型预设。请先由管理员配置一个默认预设，或手动提交模型配置。",
    });
    return;
  }

  const existingCount = database.instances.filter((record) => record.userId === user.id).length;
  if (existingCount >= 1) {
    sendJson(response, 409, { error: "每个用户只能创建一个实例。" });
    return;
  }

  const nextIndex = database.instances.length + 1;
  const assignedPort = await findAvailableInstancePort(database);
  const instance = createInstanceRecord({
    userId: user.id,
    name,
    model,
    nextIndex,
    port: assignedPort,
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

async function handleRecreateInstance(request, response, instanceId) {
  const user = requireUser(request, response);
  if (!user) {
    return;
  }

  if (provisioningJobs.has(instanceId)) {
    sendJson(response, 409, { error: "实例正在创建中，请稍后再试。" });
    return;
  }

  const database = loadDatabase(dataDir);
  const instance = database.instances.find((record) => record.id === instanceId && record.userId === user.id);
  if (!instance) {
    sendJson(response, 404, { error: "实例不存在。" });
    return;
  }

  syncInstanceModelChainShape(instance);
  if ((instance.provisioning?.status || "") !== "error") {
    sendJson(response, 409, { error: "当前实例不处于创建失败状态，无需重新创建。" });
    return;
  }

  await stopInstance(instance);

  const nextPort = await findAvailableInstancePort(database, {
    excludeInstanceId: instance.id,
    startPort: Number(instance.port || 0) + 1,
  });

  applyInstancePort(instance, nextPort);
  instance.status = "stopped";
  instance.provisioning = {
    status: "running",
    percent: 5,
    stage: "queued",
    message: "正在重新创建实例目录与默认配置。",
    updatedAt: nowIso(),
  };
  instance.wechatBinding = {
    status: "idle",
    updatedAt: null,
    qrMode: null,
    qrPayload: "",
    qrLink: "",
    outputSnippet: "",
    pairedAccounts: [],
  };
  instance.modelAuth = {
    status: "idle",
    updatedAt: null,
    message: "",
    outputSnippet: "",
    authUrl: "",
    promptLabel: "",
    needsInput: false,
  };
  instance.updatedAt = nowIso();

  mutateDatabase(dataDir, (draft) => {
    const target = draft.instances.find((record) => record.id === instance.id);
    if (!target) {
      return;
    }
    syncInstanceModelChainShape(target);
    Object.assign(target, instance);
  });

  startProvisioningJob(instance.id, instance);

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
  syncInstanceModelChainShape(instance);
  const previousFallbacks = instance.modelChain.slice(1);

  let nextPrimary;
  if (body.presetId) {
    const preset = (database.modelPresets || []).find((p) => p.id === body.presetId);
    if (!preset) {
      sendJson(response, 400, { error: "所选模型预设不存在。" });
      return;
    }
    try {
      nextPrimary = resolveModelPresetForRuntime(preset, instance.model);
    } catch (error) {
      sendJson(response, 400, { error: error.message });
      return;
    }
  } else {
    try {
      nextPrimary = sanitizeModelPayload(body, instance.model);
    } catch (error) {
      sendJson(response, 400, { error: error.message });
      return;
    }
  }
  replaceInstanceModelChain(instance, [nextPrimary, ...previousFallbacks]);

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
  const runtimeState = await inspectInstance(instance);

  if (runtimeState.running) {
    await startInstanceWithPortRecovery(instance);
    instance.status = "running";
  } else {
    writeInstanceFiles(dataDir, instance);
    instance.status = runtimeState.status;
  }

  mutateDatabase(dataDir, (draft) => {
    const target = draft.instances.find((record) => record.id === instance.id);
    if (!target) {
      return;
    }
    syncInstanceModelChainShape(target);
    Object.assign(target, instance);
  });

  sendJson(response, 200, {
    instance: publicInstanceForHost(instance, resolveRequestHost(request)),
  });
}

async function persistInstanceModelConfig(instance) {
  syncInstanceModelChainShape(instance);
  const runtimeState = await inspectInstance(instance);

  if (runtimeState.running) {
    await startInstanceWithPortRecovery(instance);
    instance.status = "running";
  } else {
    writeInstanceFiles(dataDir, instance);
    instance.status = runtimeState.status;
  }

  mutateDatabase(dataDir, (draft) => {
    const target = draft.instances.find((record) => record.id === instance.id);
    if (!target) {
      return;
    }
    syncInstanceModelChainShape(target);
    Object.assign(target, instance);
  });

  return instance;
}

async function handleAddInstanceModel(request, response, instanceId) {
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

  syncInstanceModelChainShape(instance);

  let nextModel;
  if (body.presetId) {
    const preset = (database.modelPresets || []).find((p) => p.id === body.presetId);
    if (!preset) {
      sendJson(response, 400, { error: "所选模型预设不存在。" });
      return;
    }
    try {
      nextModel = resolveModelPresetForRuntime(preset);
    } catch (error) {
      sendJson(response, 400, { error: error.message });
      return;
    }
  } else {
    try {
      nextModel = sanitizeModelPayload(body);
    } catch (error) {
      sendJson(response, 400, { error: error.message });
      return;
    }
  }

  const asPrimary = parseBooleanFlag(body.makePrimary, false) || instance.modelChain.length === 0;
  const nextChain = asPrimary
    ? [nextModel, ...instance.modelChain]
    : [...instance.modelChain, nextModel];

  replaceInstanceModelChain(instance, nextChain);
  instance.modelAuth = {
    status: "idle",
    updatedAt: nowIso(),
    message: "",
    outputSnippet: "",
    authUrl: "",
    promptLabel: "",
    needsInput: false,
  };

  await persistInstanceModelConfig(instance);

  sendJson(response, 200, {
    instance: publicInstanceForHost(instance, resolveRequestHost(request)),
  });
}

async function handleSetPrimaryModel(request, response, instanceId, modelIndex) {
  const user = requireUser(request, response);
  if (!user) {
    return;
  }

  const instance = findOwnedInstance(user, instanceId);
  if (!instance) {
    sendJson(response, 404, { error: "实例不存在。" });
    return;
  }

  syncInstanceModelChainShape(instance);
  const index = Number(modelIndex);
  if (!Number.isInteger(index) || index < 0 || index >= instance.modelChain.length) {
    sendJson(response, 400, { error: "模型索引无效。" });
    return;
  }
  if (instance.modelChain.length <= 1) {
    sendJson(response, 400, { error: "至少需要保留一个默认模型。" });
    return;
  }

  const nextChain = [...instance.modelChain];
  const [selected] = nextChain.splice(index, 1);
  nextChain.unshift(selected);
  replaceInstanceModelChain(instance, nextChain);
  await persistInstanceModelConfig(instance);

  sendJson(response, 200, {
    instance: publicInstanceForHost(instance, resolveRequestHost(request)),
  });
}

async function handleReorderInstanceModel(request, response, instanceId) {
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

  const instance = findOwnedInstance(user, instanceId);
  if (!instance) {
    sendJson(response, 404, { error: "实例不存在。" });
    return;
  }

  syncInstanceModelChainShape(instance);
  const index = Number(body.index);
  const direction = String(body.direction || "").trim().toLowerCase();
  if (!Number.isInteger(index) || index < 0 || index >= instance.modelChain.length) {
    sendJson(response, 400, { error: "模型索引无效。" });
    return;
  }

  const delta = direction === "up" ? -1 : direction === "down" ? 1 : 0;
  const targetIndex = index + delta;
  if (!delta || targetIndex < 0 || targetIndex >= instance.modelChain.length) {
    sendJson(response, 400, { error: "无法继续移动当前模型。" });
    return;
  }

  const nextChain = [...instance.modelChain];
  const [selected] = nextChain.splice(index, 1);
  nextChain.splice(targetIndex, 0, selected);
  replaceInstanceModelChain(instance, nextChain);
  await persistInstanceModelConfig(instance);

  sendJson(response, 200, {
    instance: publicInstanceForHost(instance, resolveRequestHost(request)),
  });
}

async function handleDeleteInstanceModel(request, response, instanceId, modelIndex) {
  const user = requireUser(request, response);
  if (!user) {
    return;
  }

  const instance = findOwnedInstance(user, instanceId);
  if (!instance) {
    sendJson(response, 404, { error: "实例不存在。" });
    return;
  }

  syncInstanceModelChainShape(instance);
  const index = Number(modelIndex);
  if (!Number.isInteger(index) || index < 0 || index >= instance.modelChain.length) {
    sendJson(response, 400, { error: "模型索引无效。" });
    return;
  }
  if (instance.modelChain.length <= 1) {
    sendJson(response, 400, { error: "至少需要保留一个默认模型。" });
    return;
  }

  const nextChain = [...instance.modelChain];
  nextChain.splice(index, 1);
  replaceInstanceModelChain(instance, nextChain);
  await persistInstanceModelConfig(instance);

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
    await restartManagedInstance(instance);
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

  syncInstanceModelChainShape(instance);
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
          const latest = loadDatabase(dataDir).instances.find((record) => record.id === instance.id) || instance;
          await restartManagedInstance(latest);
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

  const ensured = ensureInstanceDefaultModel(findOwnedInstance(user, instanceId));
  const instance = ensured.instance;
  if (!instance) {
    sendJson(response, 404, { error: "实例不存在。" });
    return;
  }
  if (ensured.error) {
    sendJson(response, 409, { error: ensured.error });
    return;
  }

  if (instance.provisioning?.status === "running") {
    sendJson(response, 409, { error: "实例仍在创建中，请稍后再试。" });
    return;
  }

  const runtimeState = await startInstanceWithPortRecovery(instance);

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

  const ensured = ensureInstanceDefaultModel(findOwnedInstance(user, instanceId));
  const instance = ensured.instance;
  if (!instance) {
    sendJson(response, 404, { error: "实例不存在。" });
    return;
  }
  if (ensured.error) {
    sendJson(response, 409, { error: ensured.error });
    return;
  }

  const runtimeState = await inspectInstance(instance);
  if (!runtimeState.running) {
    sendJson(response, 409, { error: "请先启动实例，再重启网关。" });
    return;
  }

  writeInstanceFiles(dataDir, instance);
  await restartManagedInstance(instance);
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
  const url = new URL(request.url || "", "http://localhost");
  const forceRegenerate = parseBooleanFlag(url.searchParams.get("force"), false);

  const ensured = ensureInstanceDefaultModel(findOwnedInstance(user, instanceId));
  const instance = ensured.instance;
  if (!instance) {
    sendJson(response, 404, { error: "实例不存在。" });
    return;
  }
  if (ensured.error) {
    sendJson(response, 409, { error: ensured.error });
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

  if (ensured.changed) {
    writeInstanceFiles(dataDir, instance);
    await restartManagedInstance(instance);
  }

  if (wechatJobs.has(instance.id) && !forceRegenerate) {
    const latest = await refreshInstanceRuntimeState(instance.id);
    sendJson(response, 200, {
      instance: publicInstanceForHost(latest || instance, resolveRequestHost(request)),
    });
    return;
  }

  if (wechatJobs.has(instance.id) && forceRegenerate) {
    wechatJobs.get(instance.id)?.cancel?.();
  }

  writeInstanceFiles(dataDir, instance);

  patchWechatState(instance.id, {
    status: "starting",
    updatedAt: nowIso(),
    qrMode: null,
    qrPayload: "",
    qrLink: "",
    outputSnippet: "已进入容器，正在检查预装微信插件并拉起扫码登录流程。",
  });

  const runId = randomId(8);
  const job = startWechatBindJob(instance, {
    onUpdate: (patch) => {
      if (wechatJobs.get(instance.id)?.runId !== runId) {
        return;
      }
      patchWechatState(instance.id, patch);
    },
    onExit: (patch) => {
      if (wechatJobs.get(instance.id)?.runId !== runId) {
        return;
      }
      patchWechatState(instance.id, patch);
      wechatJobs.delete(instance.id);
    },
  });

  wechatJobs.set(instance.id, {
    runId,
    child: job,
    cancel: () => job.kill("SIGTERM"),
  });

  const latest = loadDatabase(dataDir).instances.find((record) => record.id === instance.id) || instance;
  sendJson(response, 202, {
    instance: publicInstanceForHost(latest, resolveRequestHost(request)),
  });
}

async function handleWechatUnbind(request, response, instanceId) {
  const user = requireUser(request, response);
  if (!user) {
    return;
  }

  const instance = findOwnedInstance(user, instanceId);
  if (!instance) {
    sendJson(response, 404, { error: "实例不存在。" });
    return;
  }

  const runningJob = wechatJobs.get(instance.id);
  if (runningJob) {
    runningJob.cancel?.();
    wechatJobs.delete(instance.id);
  }

  const runtimeState = await inspectInstance(instance);
  const pairedAccounts = readWechatPairedAccounts(instance);
  const wechatStateDir = getWechatStateDir(instance);

  if (runtimeState.running) {
    for (const account of pairedAccounts) {
      try {
        await execInstanceShell(
          instance,
          `openclaw channels logout --channel openclaw-weixin --account ${shellEscape(account.accountId)}`,
          { timeoutMs: 20 * 1000 },
        );
      } catch (error) {
        logServer("warn", `微信账号登出失败，继续执行本地解绑：${instance.id}/${account.accountId}`, error);
      }
    }

    try {
      await execInstanceShell(instance, "rm -rf /var/lib/openclaw/.openclaw/openclaw-weixin", {
        timeoutMs: 20 * 1000,
      });
    } catch (error) {
      logServer("warn", `清理容器内微信状态目录失败：${instance.id}`, error);
    }
  }

  try {
    fs.rmSync(wechatStateDir, { recursive: true, force: true });
  } catch (error) {
    logServer("warn", `清理宿主机微信状态目录失败：${instance.id}`, error);
  }

  instance.wechatBinding = createIdleWechatBinding("当前微信配对已解除，可重新生成二维码。");
  instance.updatedAt = nowIso();

  mutateDatabase(dataDir, (draft) => {
    const target = draft.instances.find((record) => record.id === instance.id);
    if (!target) {
      return;
    }

    target.wechatBinding = createIdleWechatBinding("当前微信配对已解除，可重新生成二维码。");
    target.updatedAt = instance.updatedAt;
  });

  if (runtimeState.running) {
    await restartManagedInstance(instance);
  } else {
    instance.status = runtimeState.status;
  }

  const latest = await refreshInstanceRuntimeState(instance.id);
  sendJson(response, 200, {
    instance: publicInstanceForHost(latest || instance, resolveRequestHost(request)),
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

async function proxyRequest(request, response, instance, subPath, queryString) {
  const target = await resolveInstanceProxyTarget(instance);
  const targetPath = `/${subPath}${queryString ? `?${queryString}` : ""}`;

  const headers = { ...request.headers };
  delete headers.cookie;
  if (request.headers.host) {
    headers.host = request.headers.host;
    headers["x-forwarded-host"] = request.headers.host;
  }
  if (!headers["x-forwarded-proto"]) {
    headers["x-forwarded-proto"] = request.socket.encrypted ? "https" : "http";
  }
  headers.authorization = `Bearer ${instance.gatewayToken}`;

  const proxyReq = http.request(
    {
      hostname: target.host,
      port: target.port,
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

    const instanceModelsMatch = pathname.match(/^\/api\/instances\/([^/]+)\/models$/);
    if (instanceModelsMatch && request.method === "POST") {
      const [, instanceId] = instanceModelsMatch;
      await handleAddInstanceModel(request, response, instanceId);
      return;
    }

    const instanceModelsReorderMatch = pathname.match(/^\/api\/instances\/([^/]+)\/models\/reorder$/);
    if (instanceModelsReorderMatch && request.method === "POST") {
      const [, instanceId] = instanceModelsReorderMatch;
      await handleReorderInstanceModel(request, response, instanceId);
      return;
    }

    const instanceModelItemMatch = pathname.match(/^\/api\/instances\/([^/]+)\/models\/(\d+)$/);
    if (instanceModelItemMatch && request.method === "DELETE") {
      const [, instanceId, modelIndex] = instanceModelItemMatch;
      await handleDeleteInstanceModel(request, response, instanceId, modelIndex);
      return;
    }

    const instanceModelPrimaryMatch = pathname.match(/^\/api\/instances\/([^/]+)\/models\/(\d+)\/primary$/);
    if (instanceModelPrimaryMatch && request.method === "POST") {
      const [, instanceId, modelIndex] = instanceModelPrimaryMatch;
      await handleSetPrimaryModel(request, response, instanceId, modelIndex);
      return;
    }

    const instanceMatch = pathname.match(/^\/api\/instances\/([^/]+)\/(model|start|stop|wechat-bind|wechat-unbind|logs|plugins|restart-gateway|stats|recreate)$/);
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

      if (request.method === "POST" && action === "recreate") {
        await handleRecreateInstance(request, response, instanceId);
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

      if (request.method === "POST" && action === "wechat-unbind") {
        await handleWechatUnbind(request, response, instanceId);
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
      const presets = sortModelPresets(database.modelPresets || []).map((p) => ({
        id: p.id,
        name: p.name,
        isDefault: Boolean(p.isDefault),
        isConfigured: isModelPresetConfigured(p),
        providerKey: p.providerKey,
        providerId: p.providerId,
        modelId: p.modelId,
        apiMode: p.apiMode,
        authType: p.authType,
        authProviderId: p.authProviderId,
        authMethodId: p.authMethodId,
        baseUrl: p.baseUrl || "",
        hasBaseUrl: Boolean(String(p.baseUrl || "").trim()),
        hasApiKey: Boolean(String(p.apiKey || "").trim()),
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
      try { model = normalizeModelPresetPayload(body); } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      const database = loadDatabase(dataDir);
      const existingPresets = Array.isArray(database.modelPresets) ? database.modelPresets : [];
      const preset = {
        id: `preset_${Date.now().toString(36)}`,
        name,
        isDefault: parseBooleanFlag(body.isDefault, existingPresets.length === 0),
        ...model,
        createdAt: nowIso(),
      };
      mutateDatabase(dataDir, (draft) => {
        if (!draft.modelPresets) draft.modelPresets = [];
        if (preset.isDefault) {
          for (const item of draft.modelPresets) {
            item.isDefault = false;
          }
        }
        draft.modelPresets.push(preset);
      });
      sendJson(response, 201, { preset: { ...preset, apiKey: undefined } });
      return;
    }

    const presetDefaultMatch = pathname.match(/^\/api\/admin\/model-presets\/([^/]+)\/default$/);
    if (presetDefaultMatch && request.method === "POST") {
      const user = requireUser(request, response, { requireAdmin: true });
      if (!user) return;
      const [, presetId] = presetDefaultMatch;
      const database = loadDatabase(dataDir);
      if (!(database.modelPresets || []).some((preset) => preset.id === presetId)) {
        sendJson(response, 404, { error: "预设不存在。" });
        return;
      }
      mutateDatabase(dataDir, (draft) => {
        for (const item of draft.modelPresets || []) {
          item.isDefault = item.id === presetId;
        }
      });
      sendJson(response, 200, { ok: true });
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
      try { model = normalizeModelPresetPayload(body, existingPreset); } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      const preset = {
        ...existingPreset,
        name,
        isDefault: parseBooleanFlag(body.isDefault, Boolean(existingPreset.isDefault)),
        ...model,
      };
      mutateDatabase(dataDir, (draft) => {
        if (preset.isDefault) {
          for (const item of draft.modelPresets || []) {
            item.isDefault = false;
          }
        }
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
        const deletingDefault = (draft.modelPresets || []).find((p) => p.id === presetId)?.isDefault;
        draft.modelPresets = (draft.modelPresets || []).filter((p) => p.id !== presetId);
        if (deletingDefault && draft.modelPresets.length && !draft.modelPresets.some((p) => p.isDefault)) {
          const fallbackPreset = pickDefaultModelPreset(draft) || draft.modelPresets[0];
          const target = (draft.modelPresets || []).find((p) => p.id === fallbackPreset?.id);
          if (target) {
            target.isDefault = true;
          }
        }
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
      await proxyRequest(request, response, instance, subPath, url.search.slice(1));
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

    void (async () => {
      const proxyTarget = await resolveInstanceProxyTarget(instance);
      const target = net.connect(proxyTarget.port, proxyTarget.host, () => {
        const headers = { ...request.headers };
        delete headers.cookie;
        headers.host = request.headers.host || `${proxyTarget.host}:${proxyTarget.port}`;
        headers["x-forwarded-host"] = request.headers.host || headers.host;
        if (!headers["x-forwarded-proto"]) {
          headers["x-forwarded-proto"] = request.socket.encrypted ? "https" : "http";
        }
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
    })().catch((error) => {
      logServer("error", `WebSocket 代理目标解析失败：${proxyInstanceId}`, error);
      socket.destroy();
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
