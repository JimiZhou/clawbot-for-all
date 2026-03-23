#!/bin/sh
set -eu

mkdir -p "${OPENCLAW_HOME}" /workspace

if [ -d "${OPENCLAW_PREINSTALLED_HOME}/.openclaw" ]; then
  mkdir -p "${OPENCLAW_HOME}/.openclaw"
  cp -R -n "${OPENCLAW_PREINSTALLED_HOME}/.openclaw/." "${OPENCLAW_HOME}/.openclaw/"
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
