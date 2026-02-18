FROM node:22-slim

WORKDIR /app

# Install common tools the agent might need
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    wget \
    git \
    jq \
    ca-certificates \
    procps \
    && rm -rf /var/lib/apt/lists/*

# Copy package files and install deps (as root, before switching user)
COPY package.json package-lock.json ./
RUN npm ci

# Install tsx globally so it's always available (not affected by volume mounts)
RUN npm install -g tsx

# Copy tsconfig (needed by tsx at runtime)
COPY tsconfig.json ./

# Create workspace directory and give node user ownership
RUN mkdir -p /workspace && chown node:node /workspace

# Give node user ownership of the app directory (for node_modules anonymous volume)
RUN chown -R node:node /app

# Copy entrypoint
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Non-root user. Uses node:22-slim's built-in 'node' user (uid 1000).
# This matches typical host user UIDs, which means bind-mounted volumes
# work without permission issues. The tradeoff: nproc ulimits are shared
# with host processes under the same UID. We set nproc high enough to
# accommodate both, and rely on memory/CPU limits as the primary safeguard.
USER node

WORKDIR /workspace

ENTRYPOINT ["/app/entrypoint.sh"]
