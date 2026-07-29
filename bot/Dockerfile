FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      dumb-init ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY bot/package.json bot/package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY bot/src ./src
COPY bot/scripts ./scripts

COPY sql/migrations ./sql/migrations

ENV NODE_ENV=production
USER node

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]
