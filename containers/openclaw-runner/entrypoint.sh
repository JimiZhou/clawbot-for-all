#!/bin/sh
set -eu

mkdir -p "${OPENCLAW_HOME}" /workspace

if [ -d "${OPENCLAW_PREINSTALLED_HOME}/.openclaw" ]; then
  mkdir -p "${OPENCLAW_HOME}/.openclaw"
  cp -R -n "${OPENCLAW_PREINSTALLED_HOME}/.openclaw/." "${OPENCLAW_HOME}/.openclaw/"
fi

PLUGIN_DIR="${OPENCLAW_HOME}/.openclaw/extensions/${OPENCLAW_WECHAT_CHANNEL_ID}"
if [ -d "${PLUGIN_DIR}" ]; then
  mkdir -p "${PLUGIN_DIR}/node_modules"
  ln -sfn /usr/local/lib/node_modules/openclaw "${PLUGIN_DIR}/node_modules/openclaw"
fi

if [ ! -f "${OPENCLAW_CONFIG_PATH}" ]; then
  cat > "${OPENCLAW_CONFIG_PATH}" <<'EOF'
{
  "gateway": {
    "bind": "lan",
    "port": 18789
  },
  "agents": {
    "defaults": {
      "workspace": "/workspace"
    }
  },
  "plugins": {
    "allow": [
      "openclaw-weixin"
    ],
    "entries": {
      "openclaw-weixin": {
        "enabled": true
      }
    }
  }
}
EOF
fi

exec openclaw gateway --allow-unconfigured --bind lan --port "${OPENCLAW_PORT}"
