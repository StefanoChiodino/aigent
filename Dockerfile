FROM node:22-slim

# Create non-root user for the agent
RUN groupadd --gid 1000 aigent && \
    useradd --uid 1000 --gid aigent --shell /bin/bash --create-home aigent

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

# Create workspace directory and give agent ownership
RUN mkdir -p /workspace && chown aigent:aigent /workspace

# Give agent ownership of the app directory (for node_modules anonymous volume)
RUN chown -R aigent:aigent /app

# Copy entrypoint
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Switch to non-root user
USER aigent

WORKDIR /workspace

ENTRYPOINT ["/app/entrypoint.sh"]
