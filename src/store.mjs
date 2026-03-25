import path from "node:path";
import { normalizeModelChain, normalizeModelSelection } from "./model-providers.mjs";
import { ensureDir, nowIso, randomId, readJsonFile, writeJsonFile } from "./utils.mjs";
import { withWechatPluginEnabled } from "./wechat-plugin.mjs";

const DB_FILENAME = "db.json";

function createEmptyDatabase() {
  return {
    version: 2,
    createdAt: nowIso(),
    users: [],
    sessions: [],
    instances: [],
    invites: [],
    modelPresets: [],
  };
}

function normalizeUser(user) {
  return {
    role: "user",
    mustChangePassword: false,
    updatedAt: user.createdAt || nowIso(),
    ...user,
  };
}

function normalizeInstance(instance) {
  const modelChain = normalizeModelChain(instance.modelChain, instance.model);
  return {
    ...instance,
    model: modelChain[0] || normalizeModelSelection(instance.model),
    modelChain,
    provisioning: instance.provisioning || {
      status: "ready",
      percent: 100,
      stage: "ready",
      message: "实例已就绪。",
      updatedAt: instance.updatedAt || instance.createdAt || nowIso(),
    },
    plugins: withWechatPluginEnabled(instance.plugins),
    modelAuth: instance.modelAuth || {
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
      runtimeReady: false,
      runtimeStatus: "idle",
      runtimeMessage: "",
      runtimeUpdatedAt: null,
      ...(instance.wechatBinding || {}),
    },
  };
}

function normalizeInvite(invite) {
  return {
    uses: 0,
    maxUses: 1,
    revoked: false,
    ...invite,
  };
}

function normalizeModelPreset(preset) {
  if (!preset || typeof preset !== "object") {
    return preset;
  }

  const normalizedModel = normalizeModelSelection(preset);
  return {
    isDefault: false,
    ...preset,
    ...(normalizedModel || {}),
  };
}

export function normalizeDatabase(database) {
  const normalized = {
    ...createEmptyDatabase(),
    ...database,
  };

  normalized.users = Array.isArray(normalized.users) ? normalized.users.map(normalizeUser) : [];
  normalized.sessions = Array.isArray(normalized.sessions) ? normalized.sessions : [];
  normalized.instances = Array.isArray(normalized.instances)
    ? normalized.instances.map(normalizeInstance)
    : [];
  normalized.invites = Array.isArray(normalized.invites) ? normalized.invites.map(normalizeInvite) : [];
  normalized.modelPresets = Array.isArray(normalized.modelPresets)
    ? normalized.modelPresets.map(normalizeModelPreset)
    : [];
  normalized.version = 2;
  return normalized;
}

export function getDatabasePath(dataDir) {
  return path.join(dataDir, DB_FILENAME);
}

export function ensureDatabase(dataDir) {
  ensureDir(dataDir);
  const databasePath = getDatabasePath(dataDir);
  const database = readJsonFile(databasePath, null);

  if (!database) {
    writeJsonFile(databasePath, createEmptyDatabase());
    return;
  }

  const normalized = normalizeDatabase(database);
  if (JSON.stringify(normalized) !== JSON.stringify(database)) {
    writeJsonFile(databasePath, normalized);
  }
}

export function loadDatabase(dataDir) {
  ensureDatabase(dataDir);
  return normalizeDatabase(readJsonFile(getDatabasePath(dataDir), createEmptyDatabase()));
}

export function saveDatabase(dataDir, database) {
  writeJsonFile(getDatabasePath(dataDir), database);
}

export function mutateDatabase(dataDir, mutator) {
  const database = loadDatabase(dataDir);
  const result = mutator(database) ?? database;
  saveDatabase(dataDir, database);
  return result;
}

export function createSessionRecord(userId, ttlDays) {
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + ttlDays * 24 * 60 * 60 * 1000);
  return {
    id: randomId(24),
    userId,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}
