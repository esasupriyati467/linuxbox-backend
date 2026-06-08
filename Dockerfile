# LinuxBox Sandbox backend image.
# Ubuntu base + bahasa pemrograman umum, lalu Node backend yang mem-bridge
# PTY (bash) ke WebSocket. Setiap koneksi WS = sesi bash baru di workspace user.

FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=UTC \
    NODE_VERSION=20.x

# Tools dasar + bahasa: bash, python3, nodejs, npm, git
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg sudo locales tzdata \
      bash coreutils findutils grep sed gawk less nano vim-tiny \
      git python3 python3-pip python3-venv build-essential \
      make g++ pkg-config \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && locale-gen en_US.UTF-8 \
    && rm -rf /var/lib/apt/lists/*

ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

# User non-root yang akan menjalankan PTY (lebih aman).
RUN useradd -m -s /bin/bash -u 1001 sandbox \
    && mkdir -p /workspaces \
    && chown -R sandbox:sandbox /workspaces

WORKDIR /app

# Install deps backend lebih dulu agar cache-friendly.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server.js ./

RUN chown -R sandbox:sandbox /app
USER sandbox

ENV PORT=8080 \
    WORKSPACES_ROOT=/workspaces \
    SANDBOX_SHELL=/bin/bash

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "server.js"]