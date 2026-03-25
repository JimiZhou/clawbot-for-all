import fs from "node:fs";
import path from "node:path";
import { buildProviderConfigFromModel, normalizeModelChain, normalizeModelSelection } from "./model-providers.mjs";
import { ensureDir, nowIso, slugify, writeJsonFile } from "./utils.mjs";
import { withWechatPluginEnabled } from "./wechat-plugin.mjs";

export const INSTANCE_BASE_PORT = 19000;
export const OPENCLAW_CONTROL_UI_ROOT = "/usr/local/lib/node_modules/openclaw/dist/control-ui";

export function getInstancePaths(dataDir, instanceId) {
  const baseDir = path.join(dataDir, "instances", instanceId);
  return {
    baseDir,
    homeDir: path.join(baseDir, "home"),
    workspaceDir: path.join(baseDir, "workspace"),
    logsDir: path.join(baseDir, "logs"),
  };
}

export function createInstanceRecord({ userId, name, model, nextIndex, port: assignedPort = null }) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = nowIso();
  const port = Number.isInteger(assignedPort) && assignedPort > INSTANCE_BASE_PORT
    ? assignedPort
    : INSTANCE_BASE_PORT + nextIndex;
  const baseSlug = slugify(name);
  const normalizedModel = normalizeModelSelection(model);
  const modelChain = normalizeModelChain(normalizedModel ? [normalizedModel] : [], normalizedModel);
  return {
    id,
    userId,
    name,
    slug: baseSlug === "instance" ? `instance-${id.slice(-6)}` : baseSlug,
    status: "stopped",
    port,
    dashboardUrl: `http://127.0.0.1:${port}/`,
    containerName: `clawbot-openclaw-${id}`,
    gatewayToken: `${id}-${Math.random().toString(36).slice(2, 12)}`,
    createdAt,
    updatedAt: createdAt,
    provisioning: {
      status: "running",
      percent: 5,
      stage: "queued",
      message: "正在创建实例目录与默认配置。",
      updatedAt: createdAt,
    },
    model: modelChain[0] || null,
    modelChain,
    plugins: withWechatPluginEnabled(),
    modelAuth: {
      status: "idle",
      updatedAt: null,
      message: "",
      outputSnippet: "",
      authUrl: "",
      promptLabel: "",
      needsInput: false,
    },
    wechatBinding: {
      status: "idle",
      updatedAt: null,
      qrMode: null,
      qrPayload: "",
      qrLink: "",
      outputSnippet: "",
      pairedAccounts: [],
    },
  };
}

export function ensureInstanceLayout(paths) {
  ensureDir(paths.baseDir);
  ensureDir(paths.homeDir);
  ensureDir(paths.workspaceDir);
  ensureDir(paths.logsDir);
}

function mergeProviderConfigs(modelChain) {
  const providers = {};

  for (const model of modelChain) {
    const providerId = String(model?.providerId || "").trim();
    if (!providerId) continue;
    const providerConfig = buildProviderConfigFromModel(model);
    if (!providerConfig || typeof providerConfig !== "object") continue;

    if (!providers[providerId]) {
      providers[providerId] = {
        ...providerConfig,
        models: Array.isArray(providerConfig.models) ? [...providerConfig.models] : [],
      };
      continue;
    }

    const target = providers[providerId];
    for (const [key, value] of Object.entries(providerConfig)) {
      if (key === "models") continue;
      if ((target[key] === undefined || target[key] === null || target[key] === "") && value !== undefined) {
        target[key] = value;
      }
    }

    const existingIds = new Set((target.models || []).map((entry) => String(entry?.id || "")));
    for (const modelEntry of providerConfig.models || []) {
      const modelId = String(modelEntry?.id || "");
      if (!modelId || existingIds.has(modelId)) continue;
      existingIds.add(modelId);
      target.models.push(modelEntry);
    }
  }

  return providers;
}

export function buildOpenClawConfig(instance) {
  const modelChain = normalizeModelChain(instance.modelChain, instance.model);
  const normalizedModel = modelChain[0] || null;
  const config = {
    gateway: {
      bind: "lan",
      port: 18789,
      auth: {
        mode: "token",
        token: instance.gatewayToken,
      },
      controlUi: {
        enabled: true,
        root: OPENCLAW_CONTROL_UI_ROOT,
        allowInsecureAuth: true,
        dangerouslyDisableDeviceAuth: true,
        dangerouslyAllowHostHeaderOriginFallback: true,
      },
    },
  };

  if (normalizedModel) {
    const providerId = normalizedModel.providerId;
    const modelId = normalizedModel.modelId;
    const primaryModelRef = `${providerId}/${modelId}`;
    const providers = mergeProviderConfigs(modelChain);
    const fallbacks = modelChain
      .slice(1)
      .map((item) => `${item.providerId}/${item.modelId}`);

    // 同时写入 legacy agent.model，避免不同 OpenClaw 版本读取路径差异导致回落到内置默认模型。
    config.agent = {
      model: primaryModelRef,
    };
    config.agents = {
      defaults: {
        workspace: "/workspace",
        model: {
          primary: primaryModelRef,
          ...(fallbacks.length ? { fallbacks } : {}),
        },
      },
    };

    if (Object.keys(providers).length) {
      config.models = {
        mode: "merge",
        providers,
      };
    }
  } else {
    config.agents = {
      defaults: {
        workspace: "/workspace",
      },
    };
  }

  const normalizedPlugins = withWechatPluginEnabled(instance.plugins);

  if (normalizedPlugins.allow?.length || Object.keys(normalizedPlugins.entries || {}).length) {
    config.plugins = {
      ...(normalizedPlugins.allow?.length ? { allow: normalizedPlugins.allow } : {}),
      ...(Object.keys(normalizedPlugins.entries || {}).length ? { entries: normalizedPlugins.entries } : {}),
    };
  }

  return config;
}

export function writeInstanceFiles(dataDir, instance) {
  const paths = getInstancePaths(dataDir, instance.id);
  ensureInstanceLayout(paths);

  writeJsonFile(path.join(paths.homeDir, "openclaw.json"), buildOpenClawConfig(instance));

  const readmePath = path.join(paths.baseDir, "README.txt");
  const lines = [
    `OpenClaw instance: ${instance.name}`,
    `Updated at: ${instance.updatedAt}`,
    `Home: ${paths.homeDir}`,
    `Workspace: ${paths.workspaceDir}`,
    `Dashboard: ${instance.dashboardUrl}`,
  ];
  fs.writeFileSync(readmePath, `${lines.join("\n")}\n`, "utf8");

  return paths;
}
