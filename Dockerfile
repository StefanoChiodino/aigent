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

# Copy package files and install deps
COPY package.json package-lock.json ./
RUN npm ci --production=false

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# Default working directory for the agent's workspace
RUN mkdir -p /workspace
WORKDIR /workspace

ENTRYPOINT ["node", "/app/dist/index.js"]
