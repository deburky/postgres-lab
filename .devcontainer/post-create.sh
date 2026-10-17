#!/usr/bin/env bash
# Runs once inside the dev container after it is created (devcontainer.json postCreateCommand).
set -euo pipefail

# The .venv mount is a named volume owned by root on first use; hand it to the container user.
sudo chown -R "$(id -u):$(id -g)" .venv ~/.cache/uv

# uv: fast installer that also manages the Python version from .python-version
if ! command -v uv >/dev/null; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
fi

# Project + dev dependencies (pandas, ipykernel, papermill, docker, ...) into the Linux venv
uv sync

# .env is git-ignored; start from the example. DATABASE_URL is overridden by containerEnv anyway.
[ -f .env ] || cp .env.example .env

# Smoke test: pgvector version + a cosine search against the `db` sidecar
uv run src/main.py
