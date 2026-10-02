FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV VITE_AUTH_ENABLED=false
ENV MOLE_PRESET=node
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8090
COPY --from=build /app/.output ./.output
EXPOSE 8090
CMD ["node", ".output/server/index.mjs"]
