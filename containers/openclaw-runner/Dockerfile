FROM node:22-bookworm-slim

ARG OPENCLAW_VERSION=latest

LABEL io.clawbot.openclaw.version="${OPENCLAW_VERSION}"

ENV OPENCLAW_HOME=/var/lib/openclaw \
    OPENCLAW_CONFIG_PATH=/var/lib/openclaw/openclaw.json \
    OPENCLAW_PORT=18789 \
    OPENCLAW_PREINSTALLED_HOME=/opt/openclaw-preinstalled \
    OPENCLAW_WECHAT_CHANNEL_ID=openclaw-weixin \
    OPENCLAW_WECHAT_PLUGIN_SPEC=@tencent-weixin/openclaw-weixin \
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
       '  },' \
       '  "plugins": {' \
       '    "entries": {' \
       '      "openclaw-weixin": {' \
       '        "enabled": true' \
       '      }' \
       '    }' \
       '  }' \
       '}' \
       > "${OPENCLAW_PREINSTALLED_HOME}/openclaw.json" \
    && OPENCLAW_HOME="${OPENCLAW_PREINSTALLED_HOME}" \
       OPENCLAW_CONFIG_PATH="${OPENCLAW_PREINSTALLED_HOME}/openclaw.json" \
       openclaw plugins install "${OPENCLAW_WECHAT_PLUGIN_SPEC}" \
    && test -d "${OPENCLAW_PREINSTALLED_HOME}/.openclaw/extensions/${OPENCLAW_WECHAT_CHANNEL_ID}"

WORKDIR /workspace

COPY containers/openclaw-runner/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
