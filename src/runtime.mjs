import path from "node:path";
import { spawn } from "node:child_process";
import {
  nowIso,
} from "./utils.mjs";

const RUNNER_IMAGE = process.env.OPENCLAW_RUNNER_IMAGE || "clawbot-openclaw-runner:local";
const WECHAT_BIND_TIMEOUT_MS = Number(process.env.OPENCLAW_WECHAT_BIND_TIMEOUT_MS || 10 * 60 * 1000);
const WECHAT_PLUGIN_SPEC = "@tencent-weixin/openclaw-weixin";
const WECHAT_CHANNEL_ID = "openclaw-weixin";

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

export async function ensureRunnerImage(projectRoot) {
  const inspect = await runProcess("docker", ["image", "inspect", RUNNER_IMAGE]);
  if (inspect.code === 0) {
    return;
  }

  const dockerfilePath = path.join(projectRoot, "containers", "openclaw-runner", "Dockerfile");
  const build = await runProcess("docker", ["build", "-t", RUNNER_IMAGE, "-f", dockerfilePath, "."], {
    cwd: projectRoot,
    timeoutMs: 10 * 60 * 1000,
  });

  if (build.timedOut) {
    throw new Error("构建 OpenClaw 运行镜像超时（10 分钟）。请检查 Docker 拉取基础镜像和 npm 安装是否可访问外网。");
  }

  if (build.code !== 0) {
    throw new Error(`构建 OpenClaw 运行镜像失败:\n${build.stderr || build.stdout}`);
  }
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
  await ensureRunnerImage(projectRoot);
  await stopInstance(instance);

  const result = await runProcess("docker", [
    "run",
    "-d",
    "--name",
    instance.containerName,
    "--restart",
    "unless-stopped",
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
  const qrLines = lines.filter((line) => /[█▀▄▌▐▓▒]/.test(line));
  if (qrLines.length < 4) {
    return "";
  }

  return qrLines.join("\n");
}

function buildWechatCommand() {
  return `
set -e
PLUGIN_DIR="/var/lib/openclaw/.openclaw/extensions/${WECHAT_CHANNEL_ID}"
if [ ! -d "$PLUGIN_DIR" ]; then
  if openclaw plugins install "${WECHAT_PLUGIN_SPEC}"; then
    :
  else
    openclaw plugins update "${WECHAT_CHANNEL_ID}"
  fi
  openclaw config set plugins.entries.${WECHAT_CHANNEL_ID}.enabled true
  openclaw gateway restart
  sleep 4
fi
openclaw config set plugins.entries.${WECHAT_CHANNEL_ID}.enabled true
openclaw channels login --channel ${WECHAT_CHANNEL_ID} --verbose
openclaw gateway restart
`.trim();
}

function inferWechatState(output, current = {}) {
  const next = {
    ...current,
    status: current.status || "starting",
    updatedAt: nowIso(),
    outputSnippet: tailSnippet(output || current.outputSnippet || "", 2000),
  };

  const dataUrl = extractQrDataUrl(output);
  if (dataUrl) {
    next.status = "waiting_scan";
    next.qrMode = "image";
    next.qrPayload = dataUrl;
  }

  const link = extractQrLink(output);
  if (!next.qrPayload && link) {
    next.status = "waiting_scan";
    next.qrMode = "image";
    next.qrPayload = link;
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

  if (/Downloading |Extracting |Installing |正在启动微信扫码登录/i.test(output) && !next.qrPayload) {
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
        outputSnippet: tailSnippet(String(error.message || error), 3000),
      });
  });

  return child;
}
