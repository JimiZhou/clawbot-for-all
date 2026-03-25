import { spawn } from "node:child_process";
import {
  nowIso,
  shellEscape,
} from "./utils.mjs";
import { WECHAT_CHANNEL_ID, WECHAT_PLUGIN_SPEC } from "./wechat-plugin.mjs";

const RUNNER_IMAGE = process.env.OPENCLAW_RUNNER_IMAGE || "ghcr.io/jimizhou/clawbot-openclaw-runner:latest";
const RUNNER_PULL_TIMEOUT_MS = Number(process.env.OPENCLAW_RUNNER_PULL_TIMEOUT_MS || 10 * 60 * 1000);
const WECHAT_BIND_TIMEOUT_MS = Number(process.env.OPENCLAW_WECHAT_BIND_TIMEOUT_MS || 10 * 60 * 1000);
const RUNNER_IMAGE_INSPECT_TIMEOUT_MS = 15 * 1000;
const RUNNER_CPUS = String(process.env.OPENCLAW_RUNNER_CPUS || "").trim();
const RUNNER_MEMORY = String(process.env.OPENCLAW_RUNNER_MEMORY || "").trim();

const runnerImageState = {
  image: RUNNER_IMAGE,
  status: "idle",
  source: "unknown",
  message: "等待检查 runner 镜像。",
  imageId: "",
  repoTags: [],
  repoDigests: [],
  createdAt: null,
  size: 0,
  localAvailable: false,
  openclawVersion: "",
  labels: {},
  lastError: "",
  startedAt: null,
  updatedAt: nowIso(),
};

let runnerImageTask = null;
let runtimeLogger = null;

function tailSnippet(output, maxLength = 2000) {
  const text = String(output || "");
  if (text.length <= maxLength) {
    return text;
  }

  return `…${text.slice(-(maxLength - 1))}`;
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...(options.env || {}),
      },
    });

    let stdout = "";
    let stderr = "";
    const timeoutMs = options.timeoutMs || 0;
    let timeoutId = null;
    let timedOut = false;

    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs);
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      resolve({
        code,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

function extractQrDataUrl(output) {
  const match = output.match(/data:image\/[a-zA-Z+.-]+;base64,[A-Za-z0-9+/=]+/);
  return match ? match[0] : "";
}

function extractQrLink(output) {
  const labeledMatch =
    output.match(/二维码链接:\s*(\S+)/) ||
    output.match(/QR Code URL:\s*(\S+)/i);
  if (labeledMatch) {
    return labeledMatch[1];
  }

  const directMatch = output.match(/https:\/\/[^\s"'<>]+/);
  return directMatch ? directMatch[0] : "";
}

function logRuntime(level, message, meta = undefined) {
  runtimeLogger?.(level, message, meta);
}

export function setRuntimeLogger(logger) {
  runtimeLogger = typeof logger === "function" ? logger : null;
}

function buildRunnerResourceArgs() {
  const args = [];

  if (RUNNER_CPUS) {
    args.push("--cpus", RUNNER_CPUS);
  }

  if (RUNNER_MEMORY) {
    args.push("--memory", RUNNER_MEMORY);
  }

  return args;
}

function patchRunnerImageState(patch = {}) {
  Object.assign(runnerImageState, patch, {
    image: RUNNER_IMAGE,
    updatedAt: nowIso(),
  });
}

async function inspectRunnerImage() {
  const result = await runProcess("docker", ["image", "inspect", RUNNER_IMAGE, "--format", "{{json .}}"], {
    timeoutMs: RUNNER_IMAGE_INSPECT_TIMEOUT_MS,
  });

  if (result.timedOut) {
    throw new Error(`检查 runner 镜像超时：${RUNNER_IMAGE}`);
  }

  if (result.code !== 0) {
    return null;
  }

  const raw = JSON.parse(result.stdout.trim());
  const labels = raw?.Config?.Labels && typeof raw.Config.Labels === "object" ? raw.Config.Labels : {};

  return {
    image: RUNNER_IMAGE,
    imageId: raw?.Id || "",
    repoTags: Array.isArray(raw?.RepoTags) ? raw.RepoTags : [],
    repoDigests: Array.isArray(raw?.RepoDigests) ? raw.RepoDigests : [],
    createdAt: raw?.Created || null,
    size: Number(raw?.Size || 0),
    labels,
    openclawVersion: labels["io.clawbot.openclaw.version"] || "",
  };
}

async function syncRunnerImageStateFromLocal({ source = "local", message = "Runner 镜像已就绪。", startedAt = null } = {}) {
  const image = await inspectRunnerImage();
  if (!image) {
    patchRunnerImageState({
      status: "missing",
      source: "missing",
      message: "本地尚未找到 runner 镜像。",
      imageId: "",
      repoTags: [],
      repoDigests: [],
      createdAt: null,
      size: 0,
      localAvailable: false,
      openclawVersion: "",
      labels: {},
      lastError: "",
      startedAt,
    });
    return null;
  }

  patchRunnerImageState({
    status: "ready",
    source,
    message,
    imageId: image.imageId,
    repoTags: image.repoTags,
    repoDigests: image.repoDigests,
    createdAt: image.createdAt,
    size: image.size,
    localAvailable: true,
    openclawVersion: image.openclawVersion,
    labels: image.labels,
    lastError: "",
    startedAt,
  });

  return image;
}

async function pullRunnerImage({ trigger = "manual", force = false } = {}) {
  if (runnerImageTask) {
    return runnerImageTask;
  }

  const startedAt = nowIso();
  runnerImageTask = (async () => {
    if (!force) {
      const local = await syncRunnerImageStateFromLocal({
        source: "local",
        message: trigger === "startup"
          ? "Server 启动时检测到本地已存在 runner 镜像。"
          : "Runner 镜像已在本地缓存，可直接启动实例。",
        startedAt,
      });
      if (local) {
        logRuntime("info", `Runner 镜像已就绪：${RUNNER_IMAGE}`, {
          source: trigger === "startup" ? "startup-local-cache" : "local-cache",
          openclawVersion: local.openclawVersion,
          imageId: local.imageId,
        });
        return local;
      }
    }

    logRuntime("info", `开始拉取 runner 镜像：${RUNNER_IMAGE}`, {
      trigger,
      force,
    });

    patchRunnerImageState({
      status: "pulling",
      source: force ? "refresh" : trigger,
      message: force ? "管理员触发了 runner 镜像刷新，正在拉取最新镜像。" : "正在拉取 runner 镜像，请稍候。",
      startedAt,
      lastError: "",
    });

    const pull = await runProcess("docker", ["pull", RUNNER_IMAGE], {
      timeoutMs: RUNNER_PULL_TIMEOUT_MS,
    });

    if (pull.timedOut) {
      const error = new Error(
        `拉取 OpenClaw runner 镜像超时（${Math.round(RUNNER_PULL_TIMEOUT_MS / 60000)} 分钟）：${RUNNER_IMAGE}。请检查 VPS 到 GHCR 的网络连通性，或通过 OPENCLAW_RUNNER_PULL_TIMEOUT_MS 调大超时时间。`,
      );
      patchRunnerImageState({
        status: "error",
        source: force ? "refresh" : trigger,
        message: error.message,
        lastError: error.message,
        localAvailable: false,
        startedAt,
      });
      logRuntime("error", error.message, {
        image: RUNNER_IMAGE,
        trigger,
      });
      throw error;
    }

    if (pull.code !== 0) {
      const errorMessage =
        `拉取 OpenClaw runner 镜像失败：${RUNNER_IMAGE}\n${pull.stderr || pull.stdout}\n请确认 OPENCLAW_RUNNER_IMAGE 配置正确，且当前服务器已具备拉取 GHCR 镜像的权限。`;
      patchRunnerImageState({
        status: "error",
        source: force ? "refresh" : trigger,
        message: errorMessage,
        lastError: errorMessage,
        localAvailable: false,
        startedAt,
      });
      logRuntime("error", errorMessage, {
        image: RUNNER_IMAGE,
        trigger,
      });
      throw new Error(errorMessage);
    }

    const pulledImage = await syncRunnerImageStateFromLocal({
      source: force ? "refresh" : "pull",
      message: force ? "Runner 镜像已刷新完成。" : "Runner 镜像已拉取完成，可直接创建实例。",
      startedAt,
    });

    if (!pulledImage) {
      const error = new Error(`Runner 镜像拉取后仍无法在本地读取：${RUNNER_IMAGE}`);
      patchRunnerImageState({
        status: "error",
        source: force ? "refresh" : trigger,
        message: error.message,
        lastError: error.message,
        localAvailable: false,
        startedAt,
      });
      logRuntime("error", error.message, {
        image: RUNNER_IMAGE,
        trigger,
      });
      throw error;
    }

    logRuntime("info", `Runner 镜像已拉取完成：${RUNNER_IMAGE}`, {
      trigger,
      openclawVersion: pulledImage.openclawVersion,
      imageId: pulledImage.imageId,
      repoDigests: pulledImage.repoDigests,
    });

    return pulledImage;
  })();

  try {
    return await runnerImageTask;
  } finally {
    runnerImageTask = null;
  }
}

export async function ensureRunnerImage() {
  await pullRunnerImage({ trigger: "ensure" });
}

export function warmRunnerImageInBackground() {
  void pullRunnerImage({ trigger: "startup" }).catch((error) => {
    logRuntime("error", `[runner-image] ${error.message || error}`);
  });
}

export async function refreshRunnerImage() {
  await pullRunnerImage({ trigger: "admin", force: true });
  return getRunnerImageStatus();
}

export function getRunnerImageStatus() {
  return {
    ...runnerImageState,
    repoTags: [...runnerImageState.repoTags],
    repoDigests: [...runnerImageState.repoDigests],
    labels: { ...runnerImageState.labels },
  };
}

export async function inspectInstance(instance) {
  const result = await runProcess("docker", [
    "inspect",
    "--format",
    "{{json .State}}",
    instance.containerName,
  ]);

  if (result.code !== 0) {
    return {
      running: false,
      status: "stopped",
    };
  }

  const state = JSON.parse(result.stdout.trim());
  return {
    running: Boolean(state.Running),
    status: state.Status || "unknown",
    startedAt: state.StartedAt || null,
  };
}

export async function startInstance(projectRoot, paths, instance) {
  await ensureRunnerImage();
  await stopInstance(instance);

  const resourceArgs = buildRunnerResourceArgs();

  const result = await runProcess("docker", [
    "run",
    "-d",
    "--name",
    instance.containerName,
    "--restart",
    "unless-stopped",
    ...resourceArgs,
    "-p",
    `${instance.port}:18789`,
    "-e",
    "OPENCLAW_HOME=/var/lib/openclaw",
    "-e",
    "OPENCLAW_CONFIG_PATH=/var/lib/openclaw/openclaw.json",
    "-v",
    `${paths.homeDir}:/var/lib/openclaw`,
    "-v",
    `${paths.workspaceDir}:/workspace`,
    RUNNER_IMAGE,
  ], {
    timeoutMs: 60 * 1000,
  });

  if (result.code !== 0) {
    throw new Error(`启动实例失败:\n${result.stderr || result.stdout}`);
  }

  logRuntime("info", `实例容器已启动：${instance.containerName}`, {
    port: instance.port,
    cpus: RUNNER_CPUS || null,
    memory: RUNNER_MEMORY || null,
    image: RUNNER_IMAGE,
  });

  return inspectInstance(instance);
}

export async function stopInstance(instance) {
  await runProcess("docker", ["rm", "-f", instance.containerName]);
  return {
    running: false,
    status: "stopped",
  };
}

export async function restartInstance(projectRoot, paths, instance) {
  await stopInstance(instance);
  return startInstance(projectRoot, paths, instance);
}

export async function execInstanceShell(instance, command, options = {}) {
  const result = await runProcess("docker", ["exec", instance.containerName, "/bin/sh", "-lc", command], {
    timeoutMs: options.timeoutMs || 60 * 1000,
  });

  if (result.timedOut) {
    throw new Error(`实例命令执行超时：${command}`);
  }

  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `实例命令执行失败：${command}`);
  }

  return `${result.stdout}${result.stderr}`.trim();
}

export async function getInstanceStats(instance) {
  const result = await runProcess(
    "docker",
    ["stats", "--format", "{{json .}}", "--no-stream", instance.containerName],
    { timeoutMs: 5000 },
  );

  if (result.timedOut || result.code !== 0) {
    return null;
  }

  try {
    const raw = JSON.parse(result.stdout.trim());
    return {
      cpuPercent: raw.CPUPerc || "0.00%",
      memUsage: raw.MemUsage || "0B / 0B",
      memPercent: raw.MemPerc || "0.00%",
      netIO: raw.NetIO || "0B / 0B",
      pids: raw.PIDs || "0",
    };
  } catch {
    return null;
  }
}

export async function getInstanceLogs(instance, tail = 200) {
  const result = await runProcess("docker", ["logs", "--tail", String(tail), instance.containerName], {
    timeoutMs: 30 * 1000,
  });

  if (result.timedOut) {
    throw new Error("读取实例日志超时。");
  }

  if (result.code !== 0 && !`${result.stderr}${result.stdout}`.includes("No such container")) {
    throw new Error(result.stderr || result.stdout || "读取实例日志失败。");
  }

  return `${result.stdout}${result.stderr}`.trim();
}

function extractAsciiQr(output) {
  const lines = output.split(/\r?\n/);
  const isQrLine = (line) => /[█▀▄▌▐▓▒░#]/.test(line) && line.trim().length >= 10;

  let bestRun = [];
  let currentRun = [];
  for (const line of lines) {
    if (isQrLine(line)) {
      currentRun.push(line);
    } else {
      if (currentRun.length > bestRun.length) bestRun = currentRun;
      currentRun = [];
    }
  }
  if (currentRun.length > bestRun.length) bestRun = currentRun;

  if (bestRun.length < 4) return "";
  return bestRun.join("\n");
}

function buildWechatCommand() {
  return `
set -e
PLUGIN_DIR="/var/lib/openclaw/.openclaw/extensions/${WECHAT_CHANNEL_ID}"
if [ ! -d "$PLUGIN_DIR" ]; then
  echo "Runner 镜像内未找到预装微信插件：${WECHAT_PLUGIN_SPEC}" >&2
  exit 1
fi
openclaw config set plugins.entries.${WECHAT_CHANNEL_ID}.enabled true
openclaw channels login --channel ${WECHAT_CHANNEL_ID} --verbose
`.trim();
}

function inferWechatState(output, current = {}) {
  const next = {
    ...current,
    status: current.status || "starting",
    updatedAt: nowIso(),
    outputSnippet: tailSnippet(output || current.outputSnippet || "", 2000),
    qrLink: current.qrLink || "",
  };

  const dataUrl = extractQrDataUrl(output);
  const link = extractQrLink(output);
  if (link) {
    next.qrLink = link;
  }

  if (dataUrl) {
    next.status = "waiting_scan";
    next.qrMode = "image";
    next.qrPayload = dataUrl;
  }

  const asciiQr = extractAsciiQr(output);
  if (!next.qrPayload && asciiQr) {
    next.status = "waiting_scan";
    next.qrMode = "ascii";
    next.qrPayload = asciiQr;
  }

  if (/已扫码|scaned|scanned/i.test(output)) {
    next.status = "scanned";
  }

  if (/连接成功|login confirmed|与微信连接成功/i.test(output)) {
    next.status = "connected";
  }

  if (/Checking |Starting |正在检查微信插件|正在启动微信扫码登录/i.test(output) && !next.qrPayload) {
    next.status = "starting";
  }

  return next;
}

export function startWechatBindJob(instance, handlers = {}) {
  const child = spawn(
    "docker",
    ["exec", instance.containerName, "/bin/sh", "-lc", buildWechatCommand()],
    {
      env: process.env,
    },
  );

  let combinedOutput = "";
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, WECHAT_BIND_TIMEOUT_MS);

  const emitUpdate = () => {
    handlers.onUpdate?.(inferWechatState(combinedOutput));
  };

  child.stdout.on("data", (chunk) => {
    combinedOutput += chunk.toString("utf8");
    emitUpdate();
  });

  child.stderr.on("data", (chunk) => {
    combinedOutput += chunk.toString("utf8");
    emitUpdate();
  });

  child.on("close", (code) => {
    clearTimeout(timeoutId);

    if (timedOut) {
      handlers.onExit?.({
        status: "error",
        updatedAt: nowIso(),
        qrMode: null,
        qrPayload: "",
        qrLink: "",
        outputSnippet: tailSnippet(`${combinedOutput}\n微信绑定命令执行超时。`, 3000),
      });
      return;
    }

    if (code === 0) {
      handlers.onExit?.({
        ...inferWechatState(combinedOutput, { status: "connected" }),
        status: "connected",
      });
      return;
    }

      handlers.onExit?.({
        ...inferWechatState(combinedOutput, { status: "error" }),
        status: "error",
        outputSnippet: tailSnippet(combinedOutput || "微信绑定命令执行失败。", 3000),
      });
  });

  child.on("error", (error) => {
    clearTimeout(timeoutId);
      handlers.onExit?.({
        status: "error",
        updatedAt: nowIso(),
        qrMode: null,
        qrPayload: "",
        qrLink: "",
        outputSnippet: tailSnippet(String(error.message || error), 3000),
      });
  });

  return child;
}

function buildInteractiveDockerExecArgs(instance, command) {
  return ["exec", "-i", instance.containerName, "/bin/sh", "-lc", command];
}

function buildScriptInvocation(command, args) {
  if (process.platform === "darwin") {
    return {
      command: "script",
      args: ["-q", "/dev/null", command, ...args],
    };
  }

  const fullCommand = [command, ...args].map((part) => shellEscape(part)).join(" ");
  return {
    command: "script",
    args: ["-qec", fullCommand, "/dev/null"],
  };
}

export function startInteractiveInstanceCommand(instance, command, options = {}, handlers = {}) {
  const dockerArgs = buildInteractiveDockerExecArgs(instance, command);
  const scriptInvocation = buildScriptInvocation("docker", dockerArgs);
  const child = spawn(scriptInvocation.command, scriptInvocation.args, {
    env: {
      ...process.env,
      ...(options.env || {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let combinedOutput = "";
  let timedOut = false;
  const timeoutMs = Number(options.timeoutMs || 15 * 60 * 1000);
  const timeoutId = timeoutMs > 0
    ? setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs)
    : null;

  const emitUpdate = () => {
    handlers.onUpdate?.({
      output: combinedOutput,
      updatedAt: nowIso(),
    });
  };

  child.stdout.on("data", (chunk) => {
    combinedOutput += chunk.toString("utf8");
    emitUpdate();
  });

  child.stderr.on("data", (chunk) => {
    combinedOutput += chunk.toString("utf8");
    emitUpdate();
  });

  child.on("close", (code, signal) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    handlers.onExit?.({
      code,
      signal,
      timedOut,
      output: combinedOutput,
      updatedAt: nowIso(),
    });
  });

  child.on("error", (error) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    handlers.onExit?.({
      code: 1,
      signal: null,
      timedOut: false,
      output: combinedOutput ? `${combinedOutput}\n${error.message || error}` : String(error.message || error),
      updatedAt: nowIso(),
    });
  });

  return {
    child,
    cancel() {
      child.kill("SIGTERM");
    },
  };
}

export function sendInteractiveInput(job, text) {
  if (!job?.child?.stdin || job.child.stdin.destroyed) {
    throw new Error("当前交互式会话不可写入。");
  }

  job.child.stdin.write(text);
}
