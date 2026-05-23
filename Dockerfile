# Build the single binary, ship a slim runtime image with nothing else on PATH.

FROM node:22-bookworm AS builder
RUN apt-get update && apt-get install -y --no-install-recommends unzip ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN --mount=type=cache,target=/root/.npm \
    npm config delete cache --location=project 2>/dev/null || true && \
    npm ci --no-audit --no-fund
COPY tsconfig*.json vite.config.ts svelte.config.js scripts ./scripts/
COPY src ./src
RUN npm run build

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/release/omas /usr/local/bin/omas
RUN chmod +x /usr/local/bin/omas
ENV OMAS_CONFIG_DIR=/config
VOLUME ["/config"]
EXPOSE 7681
ENTRYPOINT ["/usr/local/bin/omas"]
CMD ["serve", "--host", "0.0.0.0", "--port", "7681", "--config-dir", "/config"]
