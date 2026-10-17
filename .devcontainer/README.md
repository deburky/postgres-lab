# Dev container

A Linux workspace with Python 3.12, uv, the project's dependencies, Node (for the PGlite notebook
and the three.js city), the Docker CLI and kubectl, plus the pg16 + pgvector database running next
to it as the `db` service. Only Docker Desktop is needed on the host.

## Launch from VS Code

1. Install the **Dev Containers** extension (`ms-vscode-remote.remote-containers`).
2. Open this project folder. VS Code shows a toast offering to reopen it in the container; or run
   **Dev Containers: Reopen in Container** from the command palette (Cmd+Shift+P).
3. The first start pulls the image, installs the features and runs `post-create.sh` (uv, `uv sync`,
   `.env` from `.env.example`, the smoke test). Expect a few minutes; the terminal ends with the
   pgvector version and three rows from a cosine search.
4. Pick `.venv/bin/python` as the interpreter and as the Jupyter kernel for the notebooks.
5. **Dev Containers: Reopen Folder Locally** returns to the host. Closing the window stops `dev`
   and `db`; the database volume is kept.

Rebuild after changing anything in this folder: **Dev Containers: Rebuild Container**.

## Launch from the terminal

```bash
npx @devcontainers/cli up --workspace-folder .  # build + start dev and db
npx @devcontainers/cli exec --workspace-folder . bash  # shell inside
npx @devcontainers/cli exec --workspace-folder . uv run src/main.py  # one command inside
docker compose -f docker/postgres-pgvector.yaml -f .devcontainer/docker-compose.yml down  # stop both
```

## What is where

| File | Role |
|---|---|
| `devcontainer.json` | compose services to run, features (Docker CLI, kubectl, Node), env vars, VS Code extensions, post-create hook |
| `docker-compose.yml` | adds the `dev` service on top of `docker/postgres-pgvector.yaml`, so `dev` and `db` share a network |
| `post-create.sh` | runs once after the build: uv, `uv sync`, `.env`, smoke test |

Inside the container the database host is `db`, not `localhost`; `devcontainer.json` sets
`DATABASE_URL` accordingly and it wins over `.env`. `uv run src/<script>.py` needs no `--env-file`.
The Docker CLI talks to the host's daemon, so `docker ps`, the compose files in `docker/`, and the
`just k8s-up` recipes all work from inside (`just` is installed in the container). The full walkthrough is in the
top-level README under "Dev container".
