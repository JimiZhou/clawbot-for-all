#!/bin/sh
set -eu

mkdir -p "${OPENCLAW_HOME}" /workspace

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
  }
}
EOF
fi

exec openclaw gateway --allow-unconfigured --bind lan --port "${OPENCLAW_PORT}"
