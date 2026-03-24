FROM node:22-bookworm-slim

ARG OPENCLAW_VERSION=2026.3.13
ARG OPENCLAW_WECHAT_PLUGIN_SPEC=@tencent-weixin/openclaw-weixin@1.0.3

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
       '    "port": 18789' \
       '  },' \
       '  "agents": {' \
       '    "defaults": {' \
       '      "workspace": "/workspace"' \
       '    }' \
       '  }' \
       '}' \
       > "${OPENCLAW_PREINSTALLED_HOME}/openclaw.json" \
    && OPENCLAW_HOME="${OPENCLAW_PREINSTALLED_HOME}" \
       OPENCLAW_CONFIG_PATH="${OPENCLAW_PREINSTALLED_HOME}/openclaw.json" \
       openclaw plugins install "${OPENCLAW_WECHAT_PLUGIN_SPEC}" \
    && cd "${OPENCLAW_PREINSTALLED_HOME}/.openclaw/extensions/${OPENCLAW_WECHAT_CHANNEL_ID}" \
    && npm prune --omit=dev \
    && mkdir -p "${OPENCLAW_PREINSTALLED_HOME}/.openclaw/extensions/${OPENCLAW_WECHAT_CHANNEL_ID}/node_modules" \
    && ln -sfn /usr/local/lib/node_modules/openclaw \
       "${OPENCLAW_PREINSTALLED_HOME}/.openclaw/extensions/${OPENCLAW_WECHAT_CHANNEL_ID}/node_modules/openclaw" \
    && test -d "${OPENCLAW_PREINSTALLED_HOME}/.openclaw/extensions/${OPENCLAW_WECHAT_CHANNEL_ID}"

WORKDIR /workspace

COPY containers/openclaw-runner/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
