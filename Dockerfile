FROM node:22-slim

WORKDIR /app

# Install common tools the agent might need
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    wget \
    git \
    jq \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy package files and install deps (including devDependencies for tsx)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build (for non-watch fallback)
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# Default working directory for the agent's workspace
RUN mkdir -p /workspace
WORKDIR /workspace

# Watch mode by default — edits to mounted /app/src/ auto-restart
ENTRYPOINT ["npx", "tsx", "--watch", "/app/src/index.tsx"]
