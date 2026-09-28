# cpay payment service. Build from this folder: docker build -t cpay-payment-service .
#
# The wallet words never go into the image. Mount them as a file and point
# BREEZ_MNEMONIC_FILE at it (see docs/payment-service-deploy.md).

# better-sqlite3 (used by the wallet SDK for its cache) is a native module.
# Build tools stay in this stage so the runtime image does not carry them.
FROM node:22-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-slim
ENV NODE_ENV=production \
    BREEZ_DATA_DIR=/data \
    PORT=8080
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json app.mjs config.mjs ledger.mjs server.mjs service.mjs wallet.mjs withdraw.mjs ./
# The node image ships an unprivileged "node" user (uid 1000).
RUN mkdir -p /data && chown node:node /data
USER node
# The wallet cache. Mount a persistent volume here or the service resyncs
# from scratch on every start.
VOLUME ["/data"]
EXPOSE 8080
# server.mjs handles SIGTERM itself: stops taking requests, waits up to
# SHUTDOWN_TIMEOUT_SECS for sends in flight, then disconnects.
STOPSIGNAL SIGTERM
CMD ["node", "server.mjs"]
