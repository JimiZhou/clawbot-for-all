import fs from "node:fs";
import path from "node:path";
import { buildProviderConfigFromModel, normalizeModelSelection } from "./model-providers.mjs";
import { ensureDir, nowIso, slugify, writeJsonFile } from "./utils.mjs";
import { withWechatPluginEnabled } from "./wechat-plugin.mjs";

export const INSTANCE_BASE_PORT = 19000;

export function getInstancePaths(dataDir, instanceId) {
  const baseDir = path.join(dataDir, "instances", instanceId);
  return {
    baseDir,
    homeDir: path.join(baseDir, "home"),
    workspaceDir: path.join(baseDir, "workspace"),
    logsDir: path.join(baseDir, "logs"),
  };
}

export function createInstanceRecord({ userId, name, model, nextIndex }) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = nowIso();
  const port = INSTANCE_BASE_PORT + nextIndex;
  const baseSlug = slugify(name);
  const normalizedModel = normalizeModelSelection(model);
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
    model: normalizedModel,
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

export function buildOpenClawConfig(instance) {
  const normalizedModel = normalizeModelSelection(instance.model);
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
      },
    },
  };

  if (normalizedModel) {
    const providerId = normalizedModel.providerId;
    const modelId = normalizedModel.modelId;
    const providerConfig = buildProviderConfigFromModel(normalizedModel);

    config.agents = {
      defaults: {
        workspace: "/workspace",
        model: {
          primary: `${providerId}/${modelId}`,
        },
      },
    };

    if (providerConfig) {
      config.models = {
        mode: "merge",
        providers: {
          [providerId]: providerConfig,
        },
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
