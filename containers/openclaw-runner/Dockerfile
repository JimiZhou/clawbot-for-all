FROM node:22-bookworm-slim

ARG OPENCLAW_VERSION=2026.6.1
ARG OPENCLAW_WECHAT_PLUGIN_SPEC=@tencent-weixin/openclaw-weixin@2.4.4

LABEL io.clawbot.openclaw.version="${OPENCLAW_VERSION}"

ENV OPENCLAW_HOME=/var/lib/openclaw \
    OPENCLAW_CONFIG_PATH=/var/lib/openclaw/openclaw.json \
    OPENCLAW_PORT=18789 \
    OPENCLAW_PREINSTALLED_HOME=/opt/openclaw-preinstalled \
    OPENCLAW_WECHAT_CHANNEL_ID=openclaw-weixin \
    OPENCLAW_WECHAT_PLUGIN_SPEC="${OPENCLAW_WECHAT_PLUGIN_SPEC}" \
    OPENCLAW_VERSION="${OPENCLAW_VERSION}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates python3 \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g "openclaw@${OPENCLAW_VERSION}"

RUN mkdir -p "${OPENCLAW_PREINSTALLED_HOME}" \
    && printf '%s\n' \
       '{' \
       '  "gateway": {' \
       '    "bind": "lan",' \
       '    "port": 18789,' \
       '    "controlUi": {' \
       '      "enabled": true,' \
       '      "root": "/usr/local/lib/node_modules/openclaw/dist/control-ui",' \
       '      "allowInsecureAuth": true,' \
       '      "dangerouslyDisableDeviceAuth": true,' \
       '      "dangerouslyAllowHostHeaderOriginFallback": true' \
       '    }' \
       '  },' \
       '  "agents": {' \
       '    "defaults": {' \
       '      "workspace": "/workspace"' \
       '    }' \
       '  }' \
       '}' \
       > "${OPENCLAW_PREINSTALLED_HOME}/openclaw.json" \
    && export OPENCLAW_HOME="${OPENCLAW_PREINSTALLED_HOME}" \
    && export OPENCLAW_CONFIG_PATH="${OPENCLAW_PREINSTALLED_HOME}/openclaw.json" \
    && echo "y" | openclaw plugins install "${OPENCLAW_WECHAT_PLUGIN_SPEC}" \
    && PLUGIN_DIR=$(find "${OPENCLAW_PREINSTALLED_HOME}" -type d -name "*openclaw-weixin*" | head -1) \
    && test -n "${PLUGIN_DIR}" \
    && TARGET_PLUGIN_DIR="${OPENCLAW_PREINSTALLED_HOME}/.openclaw/extensions/${OPENCLAW_WECHAT_CHANNEL_ID}" \
    && mkdir -p "${TARGET_PLUGIN_DIR}" \
    && if [ "$(cd "${PLUGIN_DIR}" && pwd)" != "$(cd "${TARGET_PLUGIN_DIR}" && pwd)" ]; then cp -R "${PLUGIN_DIR}/." "${TARGET_PLUGIN_DIR}/"; fi \
    && cd "${TARGET_PLUGIN_DIR}" \
    && npm prune --omit=dev \
    && mkdir -p "${OPENCLAW_PREINSTALLED_HOME}/.openclaw/extensions/${OPENCLAW_WECHAT_CHANNEL_ID}/node_modules" \
    && ln -sfn /usr/local/lib/node_modules/openclaw \
       "${OPENCLAW_PREINSTALLED_HOME}/.openclaw/extensions/${OPENCLAW_WECHAT_CHANNEL_ID}/node_modules/openclaw" \
    && test -d "${OPENCLAW_PREINSTALLED_HOME}/.openclaw/extensions/${OPENCLAW_WECHAT_CHANNEL_ID}"

WORKDIR /workspace

COPY containers/openclaw-runner/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
