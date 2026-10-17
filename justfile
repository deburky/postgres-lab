# Command runner for the playground. `just` lists everything; `just <recipe> --help` does not exist,
# so the comment above each recipe is its documentation. Recipes run from the repo root with .env
# loaded, so `uv run` needs no --env-file here.
#
# https://just.systems/man/en/formatting-and-dumping-justfiles.html

set dotenv-load
set positional-arguments # recipe args reach the shell as $1.. so quoted values stay whole
set shell := ["bash", "-euo", "pipefail", "-c"]

image := "sqlalchemy-pgvector-db:pg16"
pgvector_nb := "notebooks/pgvector_playground.ipynb"
small := '-p N_DOCS 5000 -p BENCH_SECONDS 1 -y "CONCURRENCY_LEVELS: [1, 8]"'

default:
    @just --list --unsorted

# -------------------------------------------------------------------------------
# Databases in compose: pg16 (pgvector + pgvectorscale), pg18 (+ pg_vectorsearch), its logical-replication replica, Doris, pgrust, pgbouncer, ducklake
# -------------------------------------------------------------------------------
_compose server:
    @case {{ server }} in \
      pg16) echo "-f docker/postgres-pgvector.yaml" ;; \
      pg18) echo "-f docker/pg18.yaml" ;; \
      replica) echo "-f docker/postgres-pgvector.yaml --profile replica" ;; \
      doris) echo "-f docker/postgres-pgvector.yaml --profile doris" ;; \
      pgrust) echo "-f docker/pgrust.yaml" ;; \
      pgbouncer) echo "-f docker/pgbouncer.yaml" ;; \
      ducklake) echo "-f docker/ducklake.yaml" ;; \
      *) echo "server must be pg16, pg18, replica, doris, pgrust, pgbouncer or ducklake" >&2; exit 1 ;; \
    esac

# start a compose server (pg16 and pg18 build their images on first use): just db pg18, just db replica, just db doris
[group('db')]
db server="pg16":
    docker compose $(just _compose {{ server }}) up -d {{ if server =~ "^pg1[68]$" { "--build" } else { "" } }}

# stop a compose server; `just db-down pg16 -v` wipes its data volume too
[group('db')]
db-down server="pg16" *flags:
    docker compose $(just _compose {{ server }}) down "${@:2}"

# psql inside a compose server's container
[group('db')]
psql server="pg16":
    docker compose $(just _compose {{ server }}) exec {{ if server == "replica" { "replica" } else { "db" } }} psql -U app -d app

# MySQL-protocol shell on the Doris FE (the doris profile must be up)
[group('db')]
doris-sql:
    docker exec -it doris-fe mysql -uroot -h127.0.0.1 -P9030

# smoke test against any server known to src/settings.py: insert + cosine search
[group('db')]
smoke server="pg16":
    DATABASE_URL=$(PYTHONPATH=src uv run python -c "from settings import settings; print(settings.sqlalchemy_url('{{ server }}'))") uv run src/main.py

# -------------------------------------------------------------------------------
# Notebooks and benchmarks
# -------------------------------------------------------------------------------
# run the pgvector notebook with papermill against a server -> out/pgvector_<server>.ipynb
[group('notebooks')]
pgvector server="pg16" *args:
    DB_ECHO=false uv run papermill {{ pgvector_nb }} out/pgvector_{{ server }}.ipynb -p SERVER {{ server }} "${@:2}"

# run any other notebook with papermill: just nb pglite_playground
[group('notebooks')]
nb name *args:
    DB_ECHO=false uv run papermill notebooks/{{ name }}.ipynb out/{{ name }}.ipynb --cwd notebooks "${@:2}"

# pg16 vs pgrust (compare, concurrency) or the vector loaders (pg_copy): just bench pg_copy --rows 20000
[group('notebooks')]
bench which="compare" *args:
    uv run src/examples/bench/{{ which }}.py "${@:2}"

# -------------------------------------------------------------------------------
# The app (doc search + spaCy summary) and the three.js city
# -------------------------------------------------------------------------------
# fetch, chunk and embed the SQLAlchemy docs into doc_chunks (once; ~2 min the first time)
[group('app')]
ingest:
    DB_ECHO=false uv run app/ingest.py

# serve the API on :8000 (/docs, /ask, /trace, /field)
[group('app')]
app:
    DB_ECHO=false uv run uvicorn --app-dir app app:app

# ask the running app a question: just ask "What does expire_on_commit do?"
[group('app')]
ask question k="5":
    curl -s localhost:8000/ask -H 'content-type: application/json' -d '{"query": "{{ question }}", "k": {{ k }}, "sentences": 3}' | jq .

# pgqueuer: pgq with PGDSN taken from DATABASE_URL and app/ importable: just pgq backlog, just pgq dashboard
[group('app')]
pgq *args:
    @PGDSN="${DATABASE_URL/+psycopg/}" PYTHONPATH=src:app DB_ECHO=false uv run pgq "$@"

# create pgqueuer's tables, then queue one ingest job per page: just queue-ingest orm/
[group('app')]
queue-ingest prefix="":
    @just pgq verify --expect present >/dev/null 2>&1 || just pgq install
    @PYTHONPATH=src:app DB_ECHO=false uv run app/jobs.py enqueue {{ prefix }}

# a queue worker (run it in several terminals); `just queue-worker drain` exits once the queue is empty
[group('app')]
queue-worker mode="continuous":
    @just pgq run jobs:create_pgqueuer --mode {{ mode }}

# the city on :5173 and the job queue on :5173/queue.html, in dev mode (needs `just app` running)
[group('viz')]
[working-directory('viz')]
viz:
    npm install && npm run dev

# build the city and serve the bundle on :4173, which the recorder expects
[group('viz')]
[working-directory('viz')]
viz-preview:
    npm install && npm run build && npm run preview

# record the city headlessly on the GPU into out/city*.mp4 and .gif: just record light 12
[group('viz')]
[working-directory('viz')]
record theme="dark" seconds="9":
    CITY_THEME={{ theme }} node record.mjs {{ seconds }}

# -------------------------------------------------------------------------------
# Local Kubernetes: kind (kubeadm in a container), k3d (k3s + load balancer), or k3s from k8s/k3s.py
# Host ports: kind 5434/5435, k3d 5436/5437, k3s 5438/5439 (see .env)
# -------------------------------------------------------------------------------
_image-check:
    @docker image inspect {{ image }} >/dev/null 2>&1 || { echo "build the image first: just db pg16"; exit 1; }

_k8s-apply-wait:
    #!/usr/bin/env bash
    set -euo pipefail
    kubectl apply -f k8s/pg16.yaml -f k8s/pgrust.yaml
    for app in pg16 pgrust; do
        until kubectl get pod -l app=$app -o name 2>/dev/null | grep -q pod; do sleep 1; done
        kubectl wait --for=condition=ready pod -l app=$app --timeout=300s
    done

# create a cluster, load the local pg16 image, deploy both databases, wait until ready: just k8s-up k3d
[group('k8s')]
k8s-up cluster="k3s": _image-check
    #!/usr/bin/env bash
    set -euo pipefail
    case {{ cluster }} in
      kind) kind create cluster --config k8s/kind-cluster.yaml
            kind load docker-image {{ image }} --name pgbench
            just _k8s-apply-wait
            echo "pg16 on localhost:5434, pgrust on localhost:5435" ;;
      k3d)  k3d cluster create --config k8s/k3d-cluster.yaml
            k3d image import {{ image }} --cluster pgbench
            just _k8s-apply-wait
            echo "pg16 on localhost:5436, pgrust on localhost:5437" ;;
      k3s)  uv run k8s/k3s.py up ;;
      *)    echo "cluster must be kind, k3d or k3s" >&2; exit 1 ;;
    esac

# delete a cluster (data is emptyDir, nothing to keep)
[group('k8s')]
k8s-down cluster="k3s":
    #!/usr/bin/env bash
    set -euo pipefail
    case {{ cluster }} in
      kind) kind delete cluster --name pgbench ;;
      k3d)  k3d cluster delete pgbench ;;
      k3s)  uv run k8s/k3s.py down ;;
      *)    echo "cluster must be kind, k3d or k3s" >&2; exit 1 ;;
    esac

# the pgvector notebook against a cluster's pg16 at small sizes -> out/pgvector_<server>.ipynb
[group('k8s')]
k8s-test cluster="k3s":
    just pgvector {{ if cluster == "kind" { "k8s-pg16" } else if cluster == "k3d" { "k3d-pg16" } else { "k3s-pg16" } }} {{ small }}

# pods, services, and the containers behind every cluster
[group('k8s')]
k8s-status:
    @kubectl config current-context 2>/dev/null || true
    @kubectl get pods,svc 2>/dev/null || true
    @docker ps --format '  {{{{.Names}}}}\t{{{{.Image}}}}\t{{{{.Ports}}}}' | grep -E 'pgbench|k3d-' || echo "  no cluster containers running"
    @uv run k8s/k3s.py status 2>/dev/null | tail -n +2 || true

# -------------------------------------------------------------------------------
# Access as code: pgsesame (pgsesame/spec.yaml); the Pulumi stack in pulumi/ does the same job
# -------------------------------------------------------------------------------
# validate, plan or apply the spec against a server: just sesame plan pg18, just sesame apply pg16
[group('access')]
sesame action="plan" server="pg18" *flags:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ "{{ action }}" = "validate" ]; then exec uv run sesame validate pgsesame/spec.yaml; fi
    url=$(PYTHONPATH=src uv run python -c "from settings import settings; print(settings.sqlalchemy_url('{{ server }}'))")
    # plan exits 2 when there are changes (terraform's -detailed-exitcode); that is not a failure here
    SESAME_DSN="${url/+psycopg/}" uv run sesame {{ action }} pgsesame/spec.yaml "${@:3}" || [ $? -eq 2 ]

# write a spec from what a server grants today (start here on an existing database)
[group('access')]
sesame-import server="pg18":
    #!/usr/bin/env bash
    set -euo pipefail
    url=$(PYTHONPATH=src uv run python -c "from settings import settings; print(settings.sqlalchemy_url('{{ server }}'))")
    SESAME_DSN="${url/+psycopg/}" uv run sesame import -o out/sesame_{{ server }}.yaml --schema public

# copy the executed notebooks into the book; run them first (just nb <name>, just pgvector pg18)
[group('book')]
book-notebooks:
    cp out/pgvector_pg18.ipynb book/notebooks/pgvector_playground.ipynb
    cp out/pgqueuer_playground.ipynb out/pgmq_playground.ipynb out/doris_cdc.ipynb out/pg_ducklake_playground.ipynb out/logical_replication.ipynb out/pglite_playground.ipynb book/notebooks/
    cp notebooks/sync_vs_async.ipynb notebooks/jsonb_playground.ipynb notebooks/pgbouncer_playground.ipynb book/notebooks/

# the book: the replaying viz into book/viz, then quarto into book/_book (CI does the same on push)
[group('book')]
book:
    cd viz && npm ci && npm run build:book
    quarto render book

# live preview of the book while editing
[group('book')]
book-preview:
    quarto preview book
