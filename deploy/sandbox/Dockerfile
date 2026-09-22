# opensession-runner — prebaked image for the Docker sandbox provider
# (docs/self-hosting-sandboxes.md; operator guide: docs/self-hosting-sandboxes.md)
#
# Contains the exact toolchain an Open Session runner needs to execute an agent run
# inside a container: bun (pinned to host), node LTS, git, gh, ripgrep, the Claude
# Code CLI (pinned to host, at the identical host path), and the Open Session runner
# bundle with node_modules — which vendors the codex binary (@openai/codex-linux-x64)
# and the Claude Agent SDK (@anthropic-ai/claude-agent-sdk).
#
# PATH PARITY IS LOAD-BEARING. The runner config points at
# /home/ubuntu/.local/bin/claude and /home/ubuntu/projects/opensession, and the
# session worktree is bind-mounted at its identical host path. So this image must
# reproduce those absolute paths exactly and run as uid 1000 (host `ubuntu`) so
# bind-mounted files keep sane ownership.
#
# Build context is the REPO ROOT (see build.sh); a root .dockerignore trims it.

FROM ubuntu:24.04

# --- version pins (bump these when the host bumps; see README) ---
ARG BUN_VERSION=1.4.0
ARG CLAUDE_VERSION=2.1.280
ARG NODE_MAJOR=24

# Locale parity note: the host runs a full en_US.UTF-8 locale; the image uses
# C.UTF-8 (no `locales` package) on the assumption that nothing in the runner
# path is locale-sensitive beyond UTF-8 text handling (collation/formatting
# differences are accepted). If a tool ever misbehaves on collation, install
# `locales` and generate en_US.UTF-8 instead of chasing it.
ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# --- system packages ---
# ripgrep lives in universe (enabled by default in the ubuntu image). python3 +
# build-essential are for worktrees whose `bun install` builds native deps.
# just + direnv + lsof cover common repo dev-server bring-up chains (port
# probing, `direnv exec`, Justfile-driven `just dev`); the aws CLI is
# deliberately NOT installed — cloud access in bring-ups should ride the
# injected short-lived credentials and language SDKs instead (see
# deploy/sandbox/README.md "Previews in sandboxes").
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        gnupg \
        unzip \
        xz-utils \
        python3 \
        build-essential \
        ripgrep \
        direnv \
        lsof \
    && rm -rf /var/lib/apt/lists/*

# --- just (pinned upstream release) ---
# NOT apt's: noble ships just 1.21, which predates Justfile `mod` support —
# repos whose root Justfile uses modules die with "Modules are currently
# unstable" on the apt version.
ARG JUST_VERSION=1.43.1
RUN curl -fsSL https://just.systems/install.sh \
        | bash -s -- --tag "${JUST_VERSION}" --to /usr/local/bin \
    && just --version

# --- Node.js LTS (NodeSource) ---
# Node major must track the host's (host: v24.x via nvm) — native-module ABI
# and `next dev` behavior are assumed host-equivalent at the same major.
RUN curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# --- GitHub CLI (official apt repo) ---
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# --- Bun (pinned), installed system-wide ---
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local/bun bash -s "bun-v${BUN_VERSION}" \
    && ln -s /usr/local/bun/bin/bun /usr/local/bin/bun \
    && ln -s /usr/local/bun/bin/bun /usr/local/bin/bunx \
    && bun --version

# --- run as the host-matching uid 1000 user `ubuntu` (ships in ubuntu:24.04) ---
# Prepare the exact absolute paths the runner expects, owned by ubuntu.
RUN mkdir -p /home/ubuntu/.local/bin \
             /home/ubuntu/.claude \
             /home/ubuntu/projects/opensession \
    && chown -R ubuntu:ubuntu /home/ubuntu

# Minimal ~/.claude so settingSources:["user"] doesn't error.
RUN echo '{}' > /home/ubuntu/.claude/settings.json \
    && chown ubuntu:ubuntu /home/ubuntu/.claude/settings.json

ENV HOME=/home/ubuntu \
    PATH=/home/ubuntu/.local/bin:/usr/local/bun/bin:/usr/local/bin:/usr/bin:/bin

USER ubuntu

# --- Claude Code CLI (pinned to host version, installed at the identical host path) ---
# The official installer drops the binary under ~/.local/share/claude and symlinks
# ~/.local/bin/claude -> it, matching /home/ubuntu/.local/bin/claude on the host.
# The build FAILS on a version mismatch (an installer that silently serves a
# different build would break host session-resume parity).
RUN curl -fsSL https://claude.ai/install.sh | bash -s "${CLAUDE_VERSION}" \
    && installed="$(/home/ubuntu/.local/bin/claude --version)" \
    && case "$installed" in \
         "${CLAUDE_VERSION}"|"${CLAUDE_VERSION} "*) echo "claude ${installed} OK" ;; \
         *) echo "claude version mismatch: got '$installed', want ${CLAUDE_VERSION}"; exit 1 ;; \
       esac

# --- Open Session runner bundle ---
# Deps first for layer caching: only re-installs when the package manifest,
# lockfile, or one of Bun's declared dependency patches changes.
WORKDIR /home/ubuntu/projects/opensession
COPY --chown=ubuntu:ubuntu package.json bun.lock ./
COPY --chown=ubuntu:ubuntu patches ./patches
COPY --chown=ubuntu:ubuntu packages/core/protocol/package.json ./packages/core/protocol/package.json
COPY --chown=ubuntu:ubuntu packages/core/opensession-server/package.json ./packages/core/opensession-server/package.json
RUN bun install --frozen-lockfile

# App source at the identical absolute path (worktrees are bind-mounted separately).
COPY --chown=ubuntu:ubuntu tsconfig.json ./
COPY --chown=ubuntu:ubuntu packages/core/protocol ./packages/core/protocol
COPY --chown=ubuntu:ubuntu packages/core/opensession-server ./packages/core/opensession-server
COPY --chown=ubuntu:ubuntu scripts/workload-identity-client.ts ./scripts/workload-identity-client.ts

WORKDIR /home/ubuntu

# Pre-create HOME dirs that are PARENTS of bind-mount targets (~/.config/gh,
# ~/.opensession-sessions/sandbox-runs/…, the rpc socket) — if they don't
# exist, docker creates them ROOT-owned when materializing the mount target,
# and then uid-1000 tools cannot write sibling state directories. Runs as USER ubuntu, so ownership is right by construction.
RUN mkdir -p /home/ubuntu/.config \
             /home/ubuntu/.local/share \
             /home/ubuntu/.opensession-sessions

# The workload-identity command is a sandbox client, not an administrative
# server CLI. It receives its exchange lease only through OpenSession-managed
# command environments.
COPY --chown=ubuntu:ubuntu deploy/sandbox/opensession /home/ubuntu/.local/bin/opensession
RUN chmod +x /home/ubuntu/.local/bin/opensession

# Containers are started long-lived and `docker exec`'d into (one per session).
CMD ["sleep", "infinity"]
