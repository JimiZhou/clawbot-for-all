import path from "node:path";
import { ensureDir, nowIso, randomId, readJsonFile, writeJsonFile } from "./utils.mjs";

const DB_FILENAME = "db.json";

function createEmptyDatabase() {
  return {
    version: 2,
    createdAt: nowIso(),
    users: [],
    sessions: [],
    instances: [],
    invites: [],
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
  return {
    provisioning: {
      status: "ready",
      percent: 100,
      stage: "ready",
      message: "实例已就绪。",
      updatedAt: instance.updatedAt || instance.createdAt || nowIso(),
    },
    plugins: {
      allow: [],
      entries: {},
    },
    wechatBinding: {
      status: "idle",
      updatedAt: null,
      qrMode: null,
      qrPayload: "",
      outputSnippet: "",
      pairedAccounts: [],
    },
    ...instance,
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
