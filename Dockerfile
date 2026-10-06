FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV VITE_AUTH_ENABLED=false
ENV MOLE_PRESET=node
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip python3-venv \
 && python3 -m venv /opt/yf \
 && /opt/yf/bin/pip install --no-cache-dir yfinance \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8090
ENV PYTHON=/opt/yf/bin/python
COPY --from=build /app/.output ./.output
EXPOSE 8090
CMD ["node", ".output/server/index.mjs"]
