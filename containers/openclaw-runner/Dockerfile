FROM node:22-bookworm-slim

ENV OPENCLAW_HOME=/var/lib/openclaw \
    OPENCLAW_CONFIG_PATH=/var/lib/openclaw/openclaw.json \
    OPENCLAW_PORT=18789

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates python3 \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g openclaw@latest

WORKDIR /workspace

COPY containers/openclaw-runner/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
