# postgres-lab

Local playground for Postgres as an application backend, starting from the guide in
[`docs/sqlalchemy-pgvector-guide.md`](docs/sqlalchemy-pgvector-guide.md): SQLAlchemy sync and async,
pgvector (HNSW, diskann, PRISM on Postgres 18), PgBouncer, logical replication, a job queue with
pgqueuer, access as code with pgsesame and Pulumi, and Kubernetes (kind, k3d, k3s).

| Vector search, sync vs async | A job queue on SKIP LOCKED | Retries with backoff |
| --- | --- | --- |
| ![city](out/city.gif) | ![queue](out/queue.gif) | ![queue retry](out/queue-retry.gif) |

## Layout

```
docker/Dockerfile               Postgres 16 + pgvector + pgvectorscale (diskann) image, from pgvector/pgvector:pg16
docker/postgres-pgvector.yaml   compose file: container `pgvector-dev`, data in a named volume
docker/Dockerfile.pg18          Postgres 18 + pgvector + pgvectorscale + pg_vectorsearch (prism) + pgmq, built from source
docker/pg18.yaml                compose file: container `pg18-dev` on port 5441
docker/initdb/*.sql             run once on first start: CREATE EXTENSION vector, vectorscale
.env.example                    copy to .env; DB credentials, DATABASE_URL, COMPOSE_FILE
.devcontainer/                  VS Code dev container: Python 3.12 + uv, with `db` as a compose sidecar
src/settings.py                 typed settings (pydantic-settings): validated DSNs for every server, engine knobs
src/db.py                       engine + session factory + init_db()   (guide §3)
src/models.py                   Base, Document with Vector(1536)       (guide §4)
src/main.py                     smoke test: insert + cosine search     (guide §14)
src/vecio.py                    read pgvector columns back as numpy (binary COPY decoder) or Arrow (ADBC)
notebooks/                      all the notebooks, one folder:
  jsonb_playground.ipynb          Postgres JSONB via SQLAlchemy, every query returned as a DataFrame
  pgvector_playground.ipynb       pgvector: distances, kNN, CTEs, HNSW vs DiskANN, recall, concurrency; pg16, pgrust or kind (papermill parameters)
  sync_vs_async.ipynb             sync vs async SQLAlchemy side by side (engines, sessions, lazy loading, gather, run_sync)
  pgbouncer_playground.ipynb      PgBouncer measured (connection cost, client count, queueing, transaction-pooling traps)
  pglite_playground.ipynb         PGlite (Postgres in WebAssembly) via py-pglite for tests, with its limits
  logical_replication.ipynb       CDC without Debezium: a second pg16 subscribed to the first; changes, lag, the failure modes
  doris_cdc.ipynb                 the same stream into Apache Doris with its built-in CDC job: types, latency, vectors, DDL
  pgqueuer_playground.ipynb       pgqueuer taken apart: SKIP LOCKED, NOTIFY, retries, limits, transactional enqueue, drivers
src/examples/jsonb/             the JSONB examples as 4 runnable scripts, with a README
docker/pgbouncer.yaml           PgBouncer 1.25 in front of pg16 on port 6432, transaction pooling
justfile                        every command in this README as a `just` recipe; `just` lists them
k8s/                            kind and k3d cluster configs, manifests, and k3s.py: k3s in one container from the Docker SDK
pulumi/                         access as code: roles, grants, default privileges via pulumi-postgresql
pgsesame/spec.yaml              the same access as one YAML spec, planned and applied by pgsesame
src/examples/bench/             pg16 vs pgrust benchmarks (single-connection + concurrency)
app/                            FastAPI app: embedding search over the SQLAlchemy docs + spaCy extractive summary (no LLM)
app/jobs.py                     the same ingest as a pgqueuer job queue: one job per page, any number of workers
viz/                            three.js: your questions answered live by pgvector HNSW, sync and async side by side on one clock
viz/queue.html                  three.js: a traced pgqueuer run replayed: SKIP LOCKED, NOTIFY, limits, retries
app/queue_trace.py              runs real pgqueuer workers and records the timeline the queue scene plays
```

## First run

```bash
cp .env.example .env            # defaults: app / pwd / app on localhost:5432
uv sync
docker compose -f docker/postgres-pgvector.yaml up -d --build
uv run --env-file .env src/main.py
```

Expected output: the pgvector version and three documents ordered by cosine distance.

`.env` sets `COMPOSE_FILE=docker/postgres-pgvector.yaml`, so from the project root
plain `docker compose ...` works too and `-f` can be dropped.

Every command in this README also exists as a `just` recipe (`brew install just`, then `just`
to list them): `just db` starts pg16, `just smoke` runs the smoke test, `just k8s-up k3s` brings
up a cluster. The recipes load `.env` themselves.

## Dev container

`.devcontainer/` gives you a ready-made Linux workspace: Python 3.12, uv, the project's
dependencies, the Docker CLI, kubectl, and the pg16 + pgvector database already running next to it.
Nothing needs to be installed on the host except Docker Desktop and VS Code (or the devcontainer CLI).

### How it is put together

| File | Role |
|---|---|
| `.devcontainer/devcontainer.json` | the definition: which compose services to run, features, env vars, VS Code extensions, post-create hook |
| `.devcontainer/docker-compose.yml` | adds a `dev` service (image `mcr.microsoft.com/devcontainers/python:3.12`) on top of `docker/postgres-pgvector.yaml`, so `dev` and `db` share a network |
| `.devcontainer/post-create.sh` | runs once after the container is built: installs uv, `uv sync`, copies `.env.example` to `.env` if missing, runs the smoke test |

Inside the container the database is reachable as host `db`, not `localhost`. `devcontainer.json`
sets `DATABASE_URL=postgresql+psycopg://app:pwd@db:5432/app` as a container variable, and
`load_dotenv()` never overrides a variable that already exists, so the `localhost` value in `.env`
is simply ignored there. The same `.env` works on the host and in the container.

### Use it from VS Code

1. Install the **Dev Containers** extension (`ms-vscode-remote.remote-containers`).
2. Open the project folder and run **Dev Containers: Reopen in Container** from the command palette
   (VS Code also offers it in a toast when it sees `.devcontainer/`).
3. First time: the image is pulled, the features are installed, and `post-create.sh` runs. Expect a
   few minutes. The terminal shows the smoke test output at the end (pgvector version, three rows).
4. Work as usual. The Python interpreter is `.venv/bin/python` inside the container; pick it as the
   Jupyter kernel for the notebooks. Ruff, Python, Jupyter, Docker and Prettier extensions are
   installed in the container automatically.
5. **Dev Containers: Reopen Folder Locally** returns to the host. Closing the window stops both
   `dev` and `db` (`shutdownAction: stopCompose`); the database volume `pgdata` is kept.

Rebuild after changing anything under `.devcontainer/` with **Dev Containers: Rebuild Container**.

### Use it from the terminal (no VS Code)

```bash
npx @devcontainers/cli up --workspace-folder .                               # build + start dev and db
npx @devcontainers/cli exec --workspace-folder . uv run src/main.py           # run a command inside
npx @devcontainers/cli exec --workspace-folder . bash                         # interactive shell
docker compose -f docker/postgres-pgvector.yaml -f .devcontainer/docker-compose.yml down   # stop both
```

### Inside the container

- `uv run src/<script>.py` works without `--env-file`: `DATABASE_URL` and `PYTHONPATH` are already
  in the environment.
- `.venv` is a named Docker volume (`dev-venv`), separate from the macOS `.venv` on the host, because
  the compiled wheels differ. Both directories coexist without conflict.
- The Docker CLI talks to the **host's** daemon (`docker-outside-of-docker`). `docker ps` shows the
  same containers as on the host, so the pgvector notebook's container lookup works, and
  `docker compose -f docker/pgrust.yaml up -d` starts pgrust on the host as usual. Reach it from the
  container through `host.docker.internal:5433` rather than `localhost`, i.e. set
  `PGRUST_DATABASE_URL=postgresql+psycopg://app:pwd@host.docker.internal:5433/app` for that session.
- Bind-mount paths in compose files are host paths, so `docker compose ... up --build` for the pg16
  image should run on the host; inside, use the already built image.
- `kubectl` is installed; `kind` is not, create the cluster from the host and the kubeconfig at
  `~/.kube/config` is not shared, so copy it in or use `kind export kubeconfig` on the host and mount it.

## Everyday commands

| Task                              | Command                                                       |
|-----------------------------------|---------------------------------------------------------------|
| Start / stop the DB               | `docker compose up -d` / `docker compose down`                |
| Wipe data and re-run init scripts | `docker compose down -v && docker compose up -d`              |
| psql shell                        | `docker compose exec db psql -U app -d app`                   |
| Tail Postgres logs                | `docker compose logs -f db`                                   |
| Run a script                      | `uv run --env-file .env src/<script>.py`                      |

## Drivers

`DATABASE_URL` in `.env` chooses the DBAPI. Both are installed:

- `postgresql+psycopg://...` — psycopg 3 (default). One driver for sync and async engines, so Alembic and the app can share it.
- `postgresql+asyncpg://...` — what the guide uses. Async only.

Switching is a one-line change in `.env`; no code changes needed.

## pgrust (optional second server)

[pgrust](https://github.com/malisper/pgrust) is Postgres 18 rewritten in Rust, shipped as a
drop-in replacement for the official image. `docker/pgrust.yaml` runs it beside the pgvector
container on port 5433, with its own volume, so both can be up at the same time.

```bash
docker compose -f docker/pgrust.yaml up -d
docker compose -f docker/pgrust.yaml exec db psql -U app -d app
docker compose -f docker/pgrust.yaml down        # add -v to wipe its data
```

Point any script at it by overriding the URL (a shell variable beats the value in `.env`):

```bash
DATABASE_URL=$PGRUST_DATABASE_URL uv run --env-file .env src/main.py
```

Verified on v0.2: pgvector 0.8.5 is bundled (HNSW index included), and the pgvector smoke
test plus all four JSONB examples run unchanged. Other third-party extensions do not load,
and upstream calls it not production-ready.

`src/examples/bench/compare.py` runs the same workload against both servers and prints a
side-by-side table (vector insert, exact and HNSW kNN, HNSW build, JSONB insert, `@>` with
and without GIN, JSONPath, GROUP BY, unnest + aggregate). Single laptop, single connection,
read the ratios not the milliseconds:

```bash
uv run --env-file .env src/examples/bench/compare.py --docs 20000 --events 50000
```

`src/examples/bench/concurrency.py` does the same with N connections at once (default
1, 4, 16, 32) and reports queries/sec and p95 latency per level for an indexed kNN, an
indexed JSONB containment, a full-table GROUP BY, and single-row inserts:

```bash
uv run --env-file .env src/examples/bench/concurrency.py --levels 1,4,16,32 --seconds 3
```

### Bulk-loading vectors: ORM vs COPY vs pgpq

`src/examples/bench/pg_copy.py` loads the same 50,000 × 384-dim rows into a pgvector table five
ways and checks each load (row count, one embedding read back): ORM `add_all` (what
`app/ingest.py` does), Core `insert()` with a list of dicts, psycopg `COPY` in text format, psycopg
`COPY ... (FORMAT BINARY)` with pgvector's binary dumper, and
[pgpq](https://github.com/adriangb/pgpq) (Parquet → Arrow → Postgres binary, the pattern from
[pgvector_db/pg_copy.py](https://github.com/deburky/pgvector_db/blob/main/src/pgvector_db/pg_copy.py)).
pgpq has no `vector` type, so its rows land in a temp `FLOAT4[]` table and a second `INSERT ... SELECT`
casts them. The staging `COPY` alone is slower than the direct one too: a Postgres array carries a
4-byte length in front of every element on the wire, so `FLOAT4[]` is twice the bytes of `vector`.
Plain binary `COPY` with numpy rows wins whenever the data is not already sitting in Parquet:

```bash
uv run --env-file .env src/examples/bench/pg_copy.py --rows 50000 --dim 384
```

```
    method   | seconds | rows/s |  MB/s | vs orm
-------------+---------+--------+-------+--------
 orm         |    11.5 |   4347 |   6.7 | 1.0x
 executemany |     8.3 |   6024 |   9.3 | 1.4x
 copy_text   |     6.8 |   7358 |  11.3 | 1.7x
 copy_binary |    0.56 |  89363 | 137.3 | 20.6x
 pgpq        |    1.32 |  37746 |  58.0 | 8.7x
(5 rows)
   1.04s  pgpq COPY into the FLOAT4[] stage
   0.32s  pgpq INSERT ... SELECT with the real[] -> vector cast
```

Build the HNSW index after a load like this, not before: maintaining it row by row costs more than
one build over the finished table.

The same script then reads the table back as an (n, dim) numpy array three ways, each checked
against the source: psycopg rows with pgvector's binary loader and `np.stack`; `COPY ... TO STDOUT
(FORMAT BINARY)` decoded in one numpy pass; and [ADBC](https://arrow.apache.org/adbc/)
(`adbc-driver-postgresql`) into an Arrow table. ADBC does not know the `vector` type (it arrives as an
opaque binary column), so the query casts to `real[]`, which lands as `list<float>` and reshapes into
numpy without copying the floats. `src/vecio.py` keeps the COPY decoder and the ADBC reader for the
notebooks:

```
 read back as numpy | seconds | rows/s |  MB/s | vs psycopg_rows
--------------------+---------+--------+-------+-----------------
 psycopg_rows       |    0.53 |  95004 | 145.9 | 1.0x
 copy_binary        |     0.4 | 125512 | 192.8 | 1.3x
 adbc_arrow         |    0.74 |  67889 | 104.3 | 0.7x
```

ADBC is the one to reach for when the destination is Arrow anyway (Polars, DuckDB, Parquet); its
wire cost is the array format again. For numpy, binary `COPY` wins in both directions.

## pgvector notebook on either server

`notebooks/pgvector_playground.ipynb` has a papermill `parameters` cell. `SERVER`
(`"pg16"` or `"pgrust"`) selects the container: the setup cell uses the Docker SDK to find it,
start it if it is stopped, wait for the healthcheck and point `DATABASE_URL` at it. Edit the
value in Jupyter, or run it headless once per server and diff the outputs:

```bash
uv run --env-file .env papermill notebooks/pgvector_playground.ipynb out/pgvector_pg16.ipynb -p SERVER pg16
uv run --env-file .env papermill notebooks/pgvector_playground.ipynb out/pgvector_pgrust.ipynb -p SERVER pgrust
```

## DiskANN (pgvectorscale)

The pg16 image also installs [pgvectorscale](https://github.com/timescale/pgvectorscale) 0.9.1,
Timescale's StreamingDiskANN implementation, as a second ANN index type next to pgvector's HNSW:

```sql
CREATE EXTENSION IF NOT EXISTS vectorscale CASCADE;
CREATE INDEX ON demo_docs USING diskann (embedding vector_cosine_ops);
SET diskann.query_search_list_size = 100;   -- like hnsw.ef_search
SET diskann.query_rescore = 50;             -- candidates re-ranked with the exact vectors
```

The pgvector notebook builds both indexes on the same table and compares build time, size, latency
and recall@10 (the DiskANN subsection skips itself on pgrust, which cannot load extensions). On the
notebook's random 64-dimensional vectors DiskANN's default quantized layout caps at roughly 0.76
recall where HNSW reaches 1.0, because binary quantization suits real embeddings far better than
independent random coordinates; treat that as a property of the test data, not a verdict. The
`storage_layout = 'plain'` variant is left out: in 0.9.1 its build on 20k rows did not finish in
ten minutes and did not respond to `pg_cancel_backend`, only to a container restart.

After changing `docker/Dockerfile`, rebuild with `docker compose build`, and for kind re-run
`kind load docker-image sqlalchemy-pgvector-db:pg16 --name pgbench` before applying the manifests.

## PRISM (pg_vectorsearch) on pg18

[pg_vectorsearch](https://github.com/timescale/pg_vectorsearch) is Timescale's newer vector index
(v0.1.0, October 2026, marked alpha). Its `prism` index partitions the table with k-means, like
IVF, and stores RaBitQ codes with an error bound per vector, so a query scans the `prism.nprobe`
nearest partitions and re-reads full vectors only for candidates the bound cannot settle. It needs
Postgres 18, so it gets its own server rather than a change to the pg16 image:

```bash
just db pg18            # docker compose -f docker/pg18.yaml up -d --build; first build ~1 min
just psql pg18
just pgvector pg18      # the notebook, PRISM subsection included -> out/pgvector_pg18.ipynb
```

`docker/Dockerfile.pg18` starts from `pgvector/pgvector:pg18`, adds the pgvectorscale 0.9.1 pg18
package, and compiles pg_vectorsearch from the release tarball with meson and OpenBLAS in a build
stage (there is no .deb yet). Data lives under `/var/lib/postgresql` because Postgres 18 images
moved `PGDATA` to `/var/lib/postgresql/18/docker`.

PRISM indexes pgvector's `vector` column in place. Only the operator class differs, and queries do
not change:

```sql
CREATE EXTENSION IF NOT EXISTS pg_vectorsearch;
CREATE INDEX ON demo_docs USING prism (embedding vec32_cosine_ops);   -- build after loading: it sizes from the row count
SET prism.nprobe = 40;                                                -- 0 = auto, aims at ~0.95 recall on real embeddings
SELECT * FROM prism_index_settings('demo_docs_embedding_idx');        -- nlist, nprobe, ... and where each value came from
```

In SQLAlchemy that is `Index(..., postgresql_using="prism", postgresql_ops={"embedding": "vec32_cosine_ops"})`.
On the notebook's 20,000 random 64-d vectors (pg18, one laptop run):

| index | build | size | best recall@10 | ms/query at best |
|---|---|---|---|---|
| hnsw (m=16, ef_construction=64) | 2.7 s | 11.4 MB | 0.99 (ef_search 400) | 3.3 |
| diskann (defaults) | 20.3 s | 9.1 MB | 0.76 (search list 400, rescore 400) | 8.3 |
| prism (auto nlist = 144) | 0.3 s | 1.8 MB | 0.98 (nprobe 160, every list) | 3.0 |

The auto `nprobe` (10 here) reaches only about 0.40 recall on this data, since random vectors have
no clusters for the partitions to follow. Recall rises steadily with `nprobe` (0.81 at 40, 0.93 at
80) and nearly matches HNSW once every list is probed, at a sixth of the index size.
Being alpha, upgrades between pre-releases may need `DROP EXTENSION` and a rebuild of its indexes.

## Vector Search with pgvector: sync vs async, live (three.js)

`viz/` is a small three.js scene in the spirit of [PGSimCity](https://github.com/NikolayS/pgsimcity),
with one difference: everything it shows is measured, live. Type questions about SQLAlchemy, one
per line, press Ask. The FastAPI app answers them twice with tracing on (`POST /trace`): once
**sync**, one thread and one connection taking the questions one after another, and once
**async**, one asyncio task and one connection per question under `gather`. The two traces then
play side by side on one clock, sync on the left plate, async on the right, so the async plate is
finished while the sync one is still working through its queue. The two wall times sit top right.

Each plate carries its title (SYNC or ASYNC, with what that means) and three named districts:
Python (one tower), the Postgres backends (one building per pid), and the documentation, `doc_chunks`, laid out as a field by a PCA of the real
embeddings. A question drops in from the sky; the tower pulses amber while `bge-small` embeds
it; the token turns teal on its backend; a white beacon rises in the field at the question's own
embedding position, with the question standing beside it as upright text and a ring widening
while the HNSW walk runs; the five matched chunks turn gold, each with its title and score
standing up from the chunk, and fly back to Python as sparks. No other text is on screen.

```bash
DB_ECHO=false uv run --env-file .env app/ingest.py                    # once: the chunks
DB_ECHO=false uv run --env-file .env uvicorn --app-dir app app:app    # the app; the scene talks to :8000
cd viz && npm install && npm run dev                                  # http://localhost:5173
```

`npm run build` gives a static bundle; point it at another app with `?api=https://host`.
`src/vecfield.py` holds the PCA; `GET /field` serves the layout. The table is small enough that
the planner would pick a sequential scan, so every traced connection sets `enable_seqscan = off`;
the point is the index walk. Drag to orbit, wheel to zoom, camera presets at the bottom, `/`
focuses the questions, Cmd+Enter asks. Both pages are drawn as ink on paper by default, in the
style of a paper and ink web app: white
paper, black ink strokes (screen-space lines, 1.6 px at any zoom), Archivo, sticky-note fills for
whatever is happening (yellow, lime, sky, lilac; peach for a job waiting to retry), violet only on
the one primary button. The Neon button (or `?theme=neon`) brings back the night city with bloom.
`src/theme.ts` holds both palettes and `src/neon.ts` the primitives drawn from them. Stack: Vite, TypeScript, three.js, no framework.

### Recording the city

`npm run record` (in `viz/`, with the app on :8000 and `npx vite preview --port 4173` serving the
build) drives the installed Google Chrome headlessly with Playwright on the real GPU (ANGLE over
Metal, ~60 fps), so nothing on screen is touched. Chrome's screencast hands every rendered frame
over as a lossless PNG, and ffmpeg stitches them into `out/city.mp4` (1920×1080, H.264, 30 fps,
BT.709) and `out/city.gif` (1280 px wide, 20 fps). The clip starts at the moment the automatic
Ask comes back; `node record.mjs 12` records longer, `npm run record:neon` records the neon
palette into `out/city-neon.*`. `npm run record:queue` records the job queue page into `out/queue.*`
(10 s of the SKIP LOCKED run), `npm run record:queue-retry` the Retries preset into
`out/queue-retry.*`; `CITY_PAGE=queue CITY_PRESET=<preset> node record.mjs 10` any other. `CITY_GL=swiftshader` falls back to software
rendering (a few fps) on a machine without a usable GPU.

## A job queue in Postgres, live (three.js)

`viz/queue.html` (the Queue button on the search city) does for pgqueuer what the city does for
sync and async: it shows a measured run, not an animation of the idea. Run (or a preset) calls
`POST /queue/trace`, which starts real pgqueuer workers on their own asyncpg connections,
enqueues the jobs, lets the workers drain them, and returns every enqueue, every NOTIFY the insert
trigger sent (heard by an observer connection), and each attempt's start and end per worker
(`app/queue_trace.py`). The scene replays that timeline over nine seconds; the scrub bar moves
through it by hand.

On the plate, Python inserts on the far side and the rows land in the `pgqueuer` table, one cell
per row, taller with priority. A teal ring spreads from the table for each NOTIFY, and idle workers
flash as it reaches them. A row lights in a worker's hue for exactly as long as that worker holds it
(status `picked`, locked by `FOR UPDATE SKIP LOCKED`), while the job itself sits on the worker's
roof. A successful job's row disappears, because pgqueuer deletes it, and the job drops into the
`pgqueuer_log` strip at the front. A failed attempt goes back to its row in red, with a ring that
shrinks until `execute_after` comes due; after the last attempt the row stays red (`failed`, kept by
`on_failure="hold"`). The counters top right include `picked / concurrency_limit`.

| preset | what to watch |
|---|---|
| SKIP LOCKED | 24 jobs, 3 workers, batches of 2, at most 4 held per worker: three colours share one table and never the same row |
| NOTIFY | one INSERT per job: each one's ring wakes an idle worker, which picks the row within milliseconds |
| Limit | `concurrency_limit = 2` across 3 workers: the counter never passes 2, and some workers get nothing |
| Retries | 30% of attempts fail: red rows waiting out a doubling delay, one held as failed when the seed says so |
| Priority | one worker, one job at a time: tall rows (high priority) are picked first, whatever their insert order |

```bash
just app                       # the API on :8000 (the queue needs no ingest; the search city does)
just viz                       # http://localhost:5173/queue.html
```

`max_concurrent_tasks` is per worker and has to be at least twice `batch_size` (pgqueuer refuses
less); 0 removes the cap, and then the first worker to wake typically claims nearly every row in its
first few dequeues, which is what an uncapped pgqueuer worker does. Runs use the entrypoint
`viz_job` only, clear its rows before and after, and run one at a time. Jobs just sleep (`job ms`,
+-40%), and failures come from a seeded RNG per job and attempt, so the same knobs replay the same
story. The shared neon pieces (wire cages, text sprites) live in `viz/src/neon.ts`.

## Postgres to Postgres: CDC with logical replication

`docker/postgres-pgvector.yaml --profile replica` (`just db replica`) adds a second pg16 on port
5440 that subscribes to the first. The source runs with `wal_level=logical`, which is the one
setting logical decoding needs (on RDS: `rds.logical_replication = 1`). No Debezium, no Kafka:
the source publishes tables, the replica subscribes, and committed inserts, updates and deletes
arrive in commit order a few milliseconds later. `notebooks/logical_replication.ipynb` walks
through it against the project's tables, `vector` column included, and reproduces the three
things that go wrong:

| step | what the notebook shows |
|---|---|
| publication and subscription | the initial copy, then streaming; changes visible on the replica in ~9 ms |
| the slot holds WAL | subscription disabled, 20,000 rows written, 7 MB pinned on the source until it is re-enabled |
| DDL is not replicated | a column added on the source only stops the apply worker; adding it on the replica resumes it |
| conflicts | a row written on the replica collides with the same key from the source; delete it and the stream resumes |

The same stream, consumed by other tools: Debezium reads the slot into Kafka topics, AWS DMS
into Redshift, S3 or another engine, and Redshift zero-ETL is the managed version from RDS or
Aurora PostgreSQL. Redshift cannot subscribe directly. Reach for logical replication when the
target is Postgres and needs no transformation; reach for Debezium when there are several
consumers or the target is not Postgres.

## Postgres to Apache Doris: built-in CDC

[Apache Doris](https://doris.apache.org/) is a columnar analytical database that speaks the MySQL
protocol. Since 4.1 it can follow Postgres itself: one `CREATE JOB ... ON STREAMING FROM POSTGRES`
creates the target tables, copies the rows and streams changes from a slot. `--profile doris`
(`just db doris`) adds one FE (port 9030, web UI on 8030) and one BE next to pg16;
`notebooks/doris_cdc.ipynb` runs a job against the project's pg16 (`just nb doris_cdc`, about a
minute) and `just doris-sql` opens a mysql shell on the FE. What it found on 4.1.4:

| | |
|---|---|
| source side | the job creates its own `doris_pub_<id>` publication (included tables only) and `doris_cdc_<id>` slot, one per job; `DROP JOB` removes both |
| latency | seconds: about 11 with the default `max_interval` of 10, about 5 with 1, because a sync round itself lasts that long |
| types | `jsonb` lands as `text` (documented as `JSON`), `uuid` as `text`, `timestamptz` as `datetime(6)` in the Doris time zone |
| `vector` | auto table creation refuses it; in a pre-created table it arrives as NULL, silently, because the CDC client is Debezium's connector and has no converter for it. A trigger-kept `real[]` copy arrives as `ARRAY<FLOAT>` and Doris's `cosine_distance` gives the same top 5 as pgvector |
| generated columns | copied by the snapshot, then dropped from the Doris table once streaming starts (pg16's pgoutput does not publish them) |
| DDL | added and dropped columns propagate, which pg to pg does not do |

The images are large (4 GB FE, 9 GB BE) and their defaults assume a server: an 8 GB FE heap and a BE
sized to 90% of memory, which on Docker Desktop ends in `MEM_LIMIT_EXCEEDED`. The compose file caps
them (`DORIS_FE_HEAP`, default 1g; `DORIS_BE_MEM`, default 3G, page cache off) at about 3.5 GB for the
pair plus the CDC client under load. The BE also skips its `vm.max_map_count` check
(`SKIP_CHECK_ULIMIT`), which is fine for a playground only.

## The app: doc search + summary, no LLM

`app/` answers a question with the most relevant passages of the SQLAlchemy documentation and an
extractive summary of them. Nothing generates text: the summary sentences are copied from the
retrieved chunks, so every response also carries the chunks with scores and links.

| File | Role |
|---|---|
| `app/chunks.py` | `DocChunk` table: source page, section title, text, `Vector(384)` embedding, HNSW index |
| `app/ingest.py` | fetches 20 `.rst` pages from the sqlalchemy repo, strips doctests and markup, chunks by section (~250 words), embeds with fastembed (`BAAI/bge-small-en-v1.5`, ONNX, CPU), stores them; idempotent |
| `app/summarize.py` | spaCy extractive summariser: sentences ranked by content-word frequency, with an optional query-term boost and length penalty |
| `app/app.py` | FastAPI: `POST /ask`, `GET /search`, `GET /health`, plus `GET /field` and `POST /trace` for the city; models load once at startup |

```bash
docker compose up -d
DB_ECHO=false uv run --env-file .env app/ingest.py                    # ~2 min first time (model download + embedding)
DB_ECHO=false uv run --env-file .env uvicorn --app-dir app app:app     # http://127.0.0.1:8000/docs
curl -s localhost:8000/ask -H 'content-type: application/json' \
     -d '{"query": "What does expire_on_commit do?", "k": 5, "sentences": 3}' | jq .summary
```

`POST /ask` embeds the question, takes the top-`k` chunks by cosine distance (optionally restricted
with `source_prefix`, e.g. `"orm/"`), concatenates them best-first, and summarises. Retrieval takes
about 20 ms, the summary about 120 ms on a laptop. Knobs live in `src/settings.py` (`EMBED_MODEL`,
`CHUNK_WORDS`, `SEARCH_K`, `SUMMARY_SENTENCES`, `DOCS_REF`).

Two things learned while tuning the summariser, both exposed as parameters of `summarize_text`:
the original frequency-sum scoring always picks the longest sentences, so the app divides by
`n_words ** 0.75`; and the scoring knows nothing about the question, so words from the query get a
boost, matched as substrings so `expire_on_commit` also hits `Session.expire_on_commit`. Both
default to off, which reproduces the original algorithm.

### Ingest as a job queue (pgqueuer)

`app/jobs.py` runs the same pipeline through [pgqueuer](https://github.com/janbjorge/pgqueuer), a
job queue that lives in Postgres. Each page is one job row; workers pick rows with
`FOR UPDATE SKIP LOCKED`, wake on `LISTEN/NOTIFY` instead of polling, and a page that fails is
retried with backoff on its own (after three attempts it stays in the table as `failed`, for
`pgq failed` and `pgq requeue`). The embedding model and an HTTP client are loaded once per worker and
reach the jobs through pgqueuer's `Context.resources`.

```bash
just queue-ingest             # pgq install (first time), then one ingest_page job per page
just queue-worker             # a worker; start it in several terminals, they share the queue
just queue-worker drain       # or: work until the queue is empty, then exit
just pgq backlog              # waiting jobs per entrypoint; also `just pgq dashboard`
```

Three details the code relies on. Enqueueing uses a dedupe key per page with `on_conflict="skip"`,
so running `queue-ingest` twice queues nothing new while the first batch waits. The entrypoint has
`concurrency_limit=2`, enforced in the database across every worker, because each job embeds on the
CPU. And each worker registers a `refresh_docs` schedule (`0 3 * * *`) that re-queues every page at
03:00, run by whichever worker gets there first. Two draining workers ingest all 20 pages (407
chunks) in about 18 s, most of it loading the model in each worker.

Workers connect with asyncpg, not psycopg. pgqueuer's psycopg driver waits for notifications while
holding the connection lock for up to a second, and the worker loop's queries queue behind it: with
a concurrency limit, five trivial jobs took 15 s on psycopg and 0.07 s on asyncpg.
`notebooks/pgqueuer_playground.ipynb` measures it, and walks through every mechanism above with
workers running inside the notebook (`just nb pgqueuer_playground`).

### The other queue design (pgmq)

[pgmq](https://github.com/pgmq/pgmq) is a queue in the style of Amazon SQS, shipped as a Postgres
extension in plain SQL: `pgmq.send`, `pgmq.read`, `pgmq.delete`, `pgmq.archive`, callable from
any language. `read` claims a message by pushing its visibility timeout (`vt`) ahead; a consumer
that crashes leaves it alone, and the message reappears when `vt` passes. pgqueuer instead marks a
job `picked` and keeps a heartbeat fresh while the job runs, so the two expire a claim
differently, though both claim with `FOR UPDATE SKIP LOCKED`.

pgmq 1.13 has no PGDG package for Postgres 18, so `docker/Dockerfile.pg18` builds it with PGXS
and `docker/initdb-pg18/03-enable-pgmq.sql` enables it. `notebooks/pgmq_playground.ipynb`
(`just nb pgmq_playground`, on pg18) covers send and read, the visibility timeout as crash
recovery, delete vs archive vs pop, extending a lease with `set_vt`, retries and a dead-letter
queue built from `read_ct`, four consumers sharing 400 messages with no double delivery, waiting
by polling vs `read_with_poll` vs NOTIFY (about 12 ms median for NOTIFY), delayed messages, FIFO
groups, topic routing with wildcards, transactional enqueue, and a pgmq vs pgqueuer table.

## Settings

`src/settings.py` is a `pydantic-settings` model: every server URL (`DATABASE_URL`,
`PG18_DATABASE_URL`, `PGRUST_DATABASE_URL`, `PGBOUNCER_DATABASE_URL`, `K8S_*`) is a validated `PostgresDsn`, plus the
engine knobs `DB_POOL_SIZE`, `DB_MAX_OVERFLOW` and `DB_ECHO`. `src/db.py` reads from it, so a
malformed URL fails at import with a clear message instead of at first query. Environment
variables beat `.env`, which beats the defaults in the file. `uv run src/settings.py` prints the
resolved values with passwords masked. Set `DB_ECHO=false` in `.env` to silence the SQL log in
the notebooks.

## PgBouncer

`docker/pgbouncer.yaml` runs PgBouncer 1.25 next to the pg16 container (it joins that compose
project's network) on port 6432 in transaction mode with a pool of 10 server connections:

```bash
docker compose up -d                                   # pg16 first
docker compose -f docker/pgbouncer.yaml up -d
psql "postgresql://app:pwd@localhost:6432/pgbouncer" -c "SHOW POOLS"   # admin console
```

`notebooks/pgbouncer_playground.ipynb` measures where it helps and where it does not:
connection cost with and without a pooler (on a laptop with SCRAM it is a wash, and the notebook
explains why), 200 clients against `max_connections = 100`, queueing when clients outnumber the
pool, the transaction-pooling traps (temp tables and `SET` leaking between clients, shown live),
prepared statements with psycopg 3 and asyncpg (`max_prepared_statements` is set), and the cost
of the extra hop. Settings to try are in the compose file.

## PGlite

`notebooks/pglite_playground.ipynb` runs the project's models on
[PGlite](https://pglite.dev/), Postgres 17 compiled to WebAssembly, through
[py-pglite](https://pypi.org/project/py-pglite/) (needs Node.js on the kernel's PATH, which the first
cell checks and repairs for a Dock-launched VS Code; the dev container installs Node; the package is fetched on first
start). No container: it starts in about a second, `create_all` works, pgvector is bundled, and
the notebook ends with a pytest fixture that gives each test a rolled-back transaction, run from
the notebook (`pytest` is a dev dependency now). Four limits found while writing it, all
demonstrated or documented in the notebook: one connection at a time (a second one segfaulted
psycopg), client messages above about 6 KB break the bridge (so no 1536-dim vectors from Python;
generate them server-side), roughly half native speed, and py-pglite 0.5.3 kills every PGlite
process on the machine whenever a manager starts or stops.

## Access as code (Pulumi)

`pulumi/` manages *who may do what* in the database: two NOLOGIN group roles (`app_ro`,
`app_rw`), schema usage, table and sequence grants, default privileges for objects the `app` role
creates later, and login roles that get access only through group membership. Tables, schemas and
extensions are not its business; they stay with the application and Alembic. The program is Python
(`pulumi/__main__.py`) using `pulumi-postgresql`, a bridge of the same provider Terraform uses.

```bash
brew install pulumi
uv sync                                  # installs the "pulumi" dependency group too
docker compose up -d
cd pulumi
pulumi stack init dev                    # first time only; the repo ships Pulumi.dev.yaml for it
pulumi preview                           # what would change
pulumi up                                # apply
pulumi preview --refresh                 # drift check: re-read the cluster first, then diff
pulumi destroy                           # drop the roles and grants this stack created
```

- `.env` sets `PULUMI_BACKEND_URL=file://~` (state under `~/.pulumi`, no Pulumi Cloud account) and
  `PULUMI_CONFIG_PASSPHRASE=dev`, the key for the `secure:` values in `Pulumi.dev.yaml`. Those are
  throwaway local passwords (the compose `pwd`, plus `reporter-pw` and `ingest-pw` for two demo
  users). For a real cluster use a different stack with its own passphrase kept out of the repo, or a
  cloud KMS secrets provider.
- Add a user with two config lines: `pulumi config set --path users.<name>.member_of app_ro` and
  `pulumi config set --secret password_<name> ...`. Add a schema with `--path 'schemas[1]' analytics`.
- The grants are chained with `depends_on` in the program; without that the provider runs them in
  parallel and Postgres fails with "tuple concurrently updated".
- A plain `pulumi preview` compares the spec with the last applied *state*. To detect changes made by
  hand in the database, use `--refresh`.

## Access as code (pgsesame)

[pgsesame](https://github.com/almostly/pgsesame) does the Pulumi stack's job from one YAML file:
`pgsesame/spec.yaml` declares the same `app_ro` / `app_rw` groups, the `reporter` and `ingest`
users, the schema, table and sequence grants, and the default privileges for tables `app` creates
later. There is no state file: `plan` reads the catalog and prints the SQL that would make it match.

```bash
just sesame validate          # check the spec, no database
just sesame plan pg18         # the SQL it would run (exit 2 means changes, the recipe accepts it)
just sesame apply pg18        # run it in one transaction
just sesame plan pg18         # empty again: nothing drifted
just sesame-import pg16       # write out/sesame_pg16.yaml from what pg16 grants today
```

The recipes build `SESAME_DSN` from the server's URL in `src/settings.py`, so any server name works.
User passwords come from `SESAME_REPORTER_PASSWORD` and `SESAME_INGEST_PASSWORD` in `.env`
(`password_env` in the spec), never from the file. Revokes, drops and ownership changes need
explicit flags (`--allow-revoke`, `--allow-drop`, `--allow-owner`), passed through as
`just sesame apply pg18 --allow-revoke`.

Compared with Pulumi: there is no state to drift from (every plan is a refresh), grants on existing
objects are expanded per table in the plan, and there is no need to chain resources against
"tuple concurrently updated", since everything runs in one transaction. The two tools should not
both manage the same roles on one server; pick one per database.

## Same servers on local Kubernetes: kind and k3d

`k8s/` runs the two images as pods on a local cluster, so the pgvector notebook can be pointed at
`k8s-pg16` / `k8s-pgrust` (kind) or `k3d-pg16` / `k3d-pgrust` (k3d) and the concurrency tables
compared with the compose ones. Both clusters are containers inside Docker Desktop's VM, so this
measures Kubernetes networking and pod overhead on the *same* cores, not a different substrate.
The manifests `k8s/pg16.yaml` and `k8s/pgrust.yaml` are identical for both.

The `justfile` wraps the whole lifecycle, one recipe per step with the cluster as its argument:

```bash
just k8s-up kind         # create cluster, load the local pg16 image, deploy both, wait for ready (ports 5434 / 5435)
just k8s-test kind       # pgvector notebook against kind, small sizes -> out/pgvector_k8s-pg16.ipynb
just k8s-down kind
just k8s-up k3d          # the same on k3d (ports 5436 / 5437)
just k8s-up k3s          # k3s in one container through docker-py, no kind/k3d/kubectl (ports 5438 / 5439); the default
just k8s-status          # pods, services, and the containers behind them
```

What the two tools do differently, measured here on the same laptop:

| | kind (`k8s/kind-cluster.yaml`) | k3d (`k8s/k3d-cluster.yaml`) |
|---|---|---|
| distribution | stock Kubernetes built with kubeadm | k3s: one binary, SQLite datastore, trimmed component set |
| node image | `kindest/node`, 1.3 GB | `rancher/k3s`, about 250 MB |
| cluster create | about 60 s once the image is local | about 80 s including the image pull; about 15 s after |
| host ports | `extraPortMappings` straight onto the node container `pgbench-control-plane` | published on a separate load-balancer container `k3d-pgbench-serverlb` (`@loadbalancer` in the config) |
| local image | `kind load docker-image` | `k3d image import` (8 s) |
| from Python | no (kubeadm runs inside the node) | yes: `k8s/k3s.py`, the same k3s node via docker-py, without k3d |
| extras on by default | none | Traefik ingress and a local-path storage class; the config disables Traefik |
| the notebook looks for | the node container | the load-balancer container |

Both were verified end to end: cluster up, both pods ready, the notebook run through the
`just k8s-test` recipe with the server resolved by the Docker SDK. For the benchmark itself the choice
does not change the result; pick kind when you want a stock Kubernetes, k3d when you want it fast
and small.

### k3s from Python: no cluster CLI at all

Docker Desktop's own Kubernetes is switched on in its settings, outside the engine, and kind's
node needs kubeadm run inside it, so neither can be started from the Docker SDK. k3s can: it is
one binary that bootstraps the whole cluster, which is why k3d is a thin wrapper around the Go
Docker client. `k8s/k3s.py` does the same with docker-py in about 150 lines, for the pgvector
notebook's `k3s-pg16` / `k3s-pgrust` servers:

1. runs `rancher/k3s` as a privileged container `pgbench-k3s` (tmpfs on `/run` and `/var/run`, the
   API server on host port 6445, the NodePorts on 5438 and 5439) and waits for the node;
2. streams images from the local Docker cache in with `docker save` and `ctr images import`, so
   nothing is pulled twice; what is missing locally k3s pulls itself;
3. drops `pg16.yaml` / `pgrust.yaml` into k3s's auto-deploy directory
   (`/var/lib/rancher/k3s/server/manifests`), which k3s applies on its own, so there is no kubectl
   call; the ConfigMap they share goes in as its own file;
4. waits for the pods and for Postgres to answer on the host port.

```bash
uv run k8s/k3s.py up --server pg16     # ~40 s cold, 10 s when the container exists
uv run k8s/k3s.py status
KUBECONFIG=out/k3s/kubeconfig.yaml kubectl get pods,svc     # if you do want kubectl
uv run k8s/k3s.py down
```

The notebook calls `k3s.up()` itself when `SERVER="k3s-pg16"` and the container does not exist,
so `just k8s-test k3s` works from a clean machine with only Docker. What k3d adds on top: the
load-balancer container in front of the ports, multi-node clusters, and a CLI that knows how to
grow and shrink them.

## Notes

- `init_db()` also runs `CREATE EXTENSION IF NOT EXISTS vector`, so the app works even against a Postgres that was not started from this Dockerfile.
- `Vector(1536)` in `src/models.py` is the dimension for OpenAI `text-embedding-3-small`. Change `EMBEDDING_DIM` to match your model; the table must be recreated (or migrated) afterwards.
- `echo=True` in `src/db.py` (the current setting) logs every SQL statement SQLAlchemy emits, which is useful while learning. In the notebooks this log lands in every cell's output, and a papermill run becomes hard to read. Set it to `False` for clean outputs; both notebooks print the SQL they send themselves via their `sql()` helper.
