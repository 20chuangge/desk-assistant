# Desk Hub 镜像：只装 Node 和（可选的）Chromium，没有构建步骤。
FROM node:22-bookworm-slim

# 浏览器工具需要 chromium；不装也能跑，只是 browser_* 会报 not_configured。
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY config ./config
COPY skills ./skills
COPY workspace ./workspace

ENV HOST=0.0.0.0 \
    ASSIST_ALLOW_REMOTE=1 \
    PORT=4390 \
    BROWSER_HEADLESS=1 \
    CHROME_PATH=/usr/bin/chromium

VOLUME ["/app/data", "/app/workspace"]
EXPOSE 4390

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.mjs"]
