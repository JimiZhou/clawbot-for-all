import fs from "node:fs";
import path from "node:path";
import { ensureDir, nowIso } from "./utils.mjs";

let serverLogFilePath = "";

function normalizeMeta(meta) {
  if (meta instanceof Error) {
    return {
      name: meta.name,
      message: meta.message,
      stack: meta.stack,
    };
  }

  return meta;
}

function stringifyMeta(meta) {
  if (meta === undefined) {
    return "";
  }

  try {
    return JSON.stringify(normalizeMeta(meta));
  } catch {
    return String(meta);
  }
}

export function initServerLogger(dataDir) {
  const logsDir = path.join(dataDir, "logs");
  ensureDir(logsDir);
  serverLogFilePath = path.join(logsDir, "server.log");
  if (!fs.existsSync(serverLogFilePath)) {
    fs.writeFileSync(serverLogFilePath, "", "utf8");
  }
  return serverLogFilePath;
}

export function getServerLogPath() {
  return serverLogFilePath;
}

export function logServer(level, message, meta = undefined) {
  const timestamp = nowIso();
  const normalizedLevel = String(level || "info").toUpperCase();
  const metaText = stringifyMeta(meta);
  const line = `${timestamp} [${normalizedLevel}] ${String(message || "")}${metaText ? ` ${metaText}` : ""}`;

  if (serverLogFilePath) {
    fs.appendFileSync(serverLogFilePath, `${line}\n`, "utf8");
  }

  if (normalizedLevel === "ERROR" || normalizedLevel === "WARN") {
    process.stderr.write(`${line}\n`);
    return;
  }

  process.stdout.write(`${line}\n`);
}

export function readServerLogs(tail = 400) {
  if (!serverLogFilePath || !fs.existsSync(serverLogFilePath)) {
    return {
      path: serverLogFilePath,
      text: "",
      totalLines: 0,
      updatedAt: null,
    };
  }

  const raw = fs.readFileSync(serverLogFilePath, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const stat = fs.statSync(serverLogFilePath);

  return {
    path: serverLogFilePath,
    text: lines.slice(-Math.max(1, Number(tail) || 400)).join("\n"),
    totalLines: lines.length,
    updatedAt: stat.mtime.toISOString(),
  };
}
