FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV VITE_AUTH_ENABLED=false
ENV MOLE_PRESET=node
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --legacy-peer-deps
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip python3-venv ca-certificates tzdata \
 && python3 -m venv /opt/yf \
 && /opt/yf/bin/pip install --no-cache-dir yfinance \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8090
ENV PYTHON=/opt/yf/bin/python
ENV TZ=America/Toronto
COPY --from=build /app/.output ./.output
COPY --from=build /app/src/lib/debate-job.mjs ./src/lib/debate-job.mjs
COPY --from=build /app/src/data/universe.ts ./src/data/universe.ts
COPY scripts/debate-batch.mjs ./scripts/debate-batch.mjs
COPY scripts/desk.sh ./scripts/desk.sh
RUN chmod +x /app/scripts/desk.sh
EXPOSE 8090
CMD ["node", ".output/server/index.mjs"]
