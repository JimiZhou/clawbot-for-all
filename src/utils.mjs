import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function randomId(size = 16) {
  return crypto.randomBytes(size).toString("hex");
}

export function nowIso() {
  return new Date().toISOString();
}

export function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }

    throw error;
  }
}

export function writeJsonFile(filePath, value) {
  const dirName = path.dirname(filePath);
  ensureDir(dirName);
  const tempPath = `${filePath}.${randomId(4)}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

export function slugify(input) {
  return String(input)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "instance";
}

export function parseCookies(cookieHeader = "") {
  return cookieHeader
    .split(";")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .reduce((accumulator, pair) => {
      const separatorIndex = pair.indexOf("=");
      if (separatorIndex === -1) {
        return accumulator;
      }

      const key = decodeURIComponent(pair.slice(0, separatorIndex));
      const value = decodeURIComponent(pair.slice(separatorIndex + 1));
      accumulator[key] = value;
      return accumulator;
    }, {});
}

export function setCookieHeader(name, value, options = {}) {
  const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`];
  if (options.httpOnly !== false) {
    parts.push("HttpOnly");
  }

  parts.push(`Path=${options.path || "/"}`);
  parts.push(`SameSite=${options.sameSite || "Lax"}`);

  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }

  if (options.secure) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

export async function parseRequestBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) {
    return {};
  }

  return JSON.parse(raw);
}

export function sendJson(response, statusCode, payload, headers = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

export function sendText(response, statusCode, payload, headers = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    ...headers,
  });
  response.end(payload);
}

export function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function trimTo(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}…`;
}

export function maskSecret(secret) {
  const value = String(secret || "");
  if (!value) {
    return "";
  }

  if (value.length <= 8) {
    return `${value.slice(0, 2)}***`;
  }

  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

export function sanitizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

export function sanitizeName(name) {
  return String(name || "").trim().replace(/\s+/g, " ").slice(0, 60);
}

export function publicUser(user) {
  if (!user) {
    return null;
  }

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role || "user",
    mustChangePassword: Boolean(user.mustChangePassword),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt || user.createdAt,
  };
}

export function publicInvite(invite, requestOrigin = "") {
  const inviteLink = requestOrigin ? `${requestOrigin}/?invite=${encodeURIComponent(invite.code)}` : "";
  return {
    id: invite.id,
    code: invite.code,
    note: invite.note || "",
    uses: invite.uses || 0,
    maxUses: invite.maxUses || 1,
    revoked: Boolean(invite.revoked),
    expiresAt: invite.expiresAt || null,
    createdAt: invite.createdAt,
    inviteLink,
  };
}

export function publicInstance(instance) {
  return publicInstanceForHost(instance, null);
}

export function publicInstanceForHost(instance, requestHost) {
  const dashboardUrl = requestHost
    ? buildDashboardUrl(requestHost, instance.port)
    : instance.dashboardUrl;

  return {
    id: instance.id,
    name: instance.name,
    slug: instance.slug,
    status: instance.status,
    port: instance.port,
    dashboardUrl,
    containerName: instance.containerName,
    gatewayToken: instance.gatewayToken,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
    provisioning: instance.provisioning || {
      status: "ready",
      percent: 100,
      stage: "ready",
      message: "实例已就绪。",
      updatedAt: instance.updatedAt,
    },
    model: {
      providerId: instance.model.providerId,
      modelId: instance.model.modelId,
      apiMode: instance.model.apiMode,
      baseUrl: instance.model.baseUrl,
      apiKeyMasked: maskSecret(instance.model.apiKey),
    },
    plugins: instance.plugins || {
      allow: [],
      entries: {},
    },
    wechatBinding: instance.wechatBinding || {
      status: "idle",
      updatedAt: null,
      qrMode: null,
      qrPayload: "",
      outputSnippet: "",
      pairedAccounts: [],
    },
  };
}

export function buildDashboardUrl(requestHost, port) {
  const fallbackHostname = "127.0.0.1";
  const rawHost = String(requestHost || "").trim();
  if (!rawHost) {
    return `http://${fallbackHostname}:${port}/`;
  }

  const normalized = rawHost.includes("://") ? rawHost : `http://${rawHost}`;

  try {
    const url = new URL(normalized);
    return `http://${url.hostname}:${port}/`;
  } catch {
    const hostname = rawHost.replace(/:\d+$/, "") || fallbackHostname;
    return `http://${hostname}:${port}/`;
  }
}

export function buildRequestOrigin(request) {
  const forwardedProto = request?.headers?.["x-forwarded-proto"];
  const protocol = String(forwardedProto || "http").split(",")[0].trim() || "http";
  const forwardedHost = request?.headers?.["x-forwarded-host"];
  const host = String(forwardedHost || request?.headers?.host || "").split(",")[0].trim();
  return host ? `${protocol}://${host}` : "";
}

export function guessContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    default:
      return "application/octet-stream";
  }
}

export function isImageFile(filePath) {
  return /\.(png|jpg|jpeg|svg)$/i.test(filePath);
}

export function walkFiles(rootDir, maxDepth = 4, currentDepth = 0) {
  if (!fs.existsSync(rootDir) || currentDepth > maxDepth) {
    return [];
  }

  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath, maxDepth, currentDepth + 1));
      continue;
    }

    files.push(fullPath);
  }

  return files;
}

export function bufferToDataUrl(filePath) {
  const buffer = fs.readFileSync(filePath);
  const contentType = guessContentType(filePath).split(";")[0];
  return `data:${contentType};base64,${buffer.toString("base64")}`;
}
