"""Ingest as a job queue in Postgres (pgqueuer): one job per documentation page.

ingest.py does everything in one process: fetch all pages, embed all chunks, write. Here every page
is a row in pgqueuer's queue table; any number of workers pick rows with FOR UPDATE SKIP LOCKED,
wake up on LISTEN/NOTIFY instead of polling, and a failed page is retried with backoff on its own.

    uv run pgq install                                  # once: pgqueuer's tables, triggers, enum
    uv run app/jobs.py enqueue [prefix]                 # one ingest_page job per page in PAGES
    uv run pgq run jobs:create_pgqueuer                 # a worker (start several; Ctrl-C to stop)
    uv run pgq run jobs:create_pgqueuer --mode drain    # work until the queue is empty, then exit
    uv run pgq backlog                                  # what is waiting, per entrypoint

`pgq` reads the DSN from PGDSN; the justfile recipes (`just queue-*`) set it from DATABASE_URL and
put app/ on PYTHONPATH so `jobs:create_pgqueuer` resolves. The worker also registers a nightly
schedule that re-enqueues every page, so the index follows the upstream docs.
"""

import asyncio
import contextlib
import sys
import time
from collections.abc import AsyncIterator

import httpx
import asyncpg
from fastembed import TextEmbedding
from pgqueuer import PgQueuer, Queries
from pgqueuer.executors import DatabaseRetryEntrypointExecutor, EntrypointExecutorParameters
from pgqueuer.models import Context, Job, Schedule
from sqlalchemy import delete

from chunks import DocChunk
from db import SessionLocal, init_db
from ingest import PAGES, chunk_page, fetch
from settings import settings

ENTRYPOINT = "ingest_page"
# Each job embeds on the CPU; more than a couple at once across all workers only adds contention.
# The limit is enforced in the database, so it holds however many workers run.
CONCURRENCY = 2


def plain_dsn() -> str:
    """DATABASE_URL without SQLAlchemy's driver tag, for asyncpg."""
    return settings.sqlalchemy_url("pg16").replace("postgresql+psycopg://", "postgresql://")


# -------------------------------------------------------------------------------
# The job: fetch one page, chunk, embed, replace its rows in doc_chunks
# -------------------------------------------------------------------------------
async def ingest_page(source: str, client: httpx.AsyncClient, model: TextEmbedding) -> int:
    _, rst = await fetch(client, source)
    chunks = chunk_page(source, rst, settings.chunk_words)
    # fastembed blocks (ONNX on the CPU); in a thread the worker keeps answering heartbeats
    vectors = await asyncio.to_thread(
        lambda: list(model.passage_embed([f"{title}\n{text}" for title, text in chunks], batch_size=64))
    )
    async with SessionLocal() as session:
        await session.execute(delete(DocChunk).where(DocChunk.source == source))
        session.add_all(
            DocChunk(source=source, ordinal=i, title=title[:300], text=text, embedding=vec.tolist())
            for i, ((title, text), vec) in enumerate(zip(chunks, vectors))
        )
        await session.commit()
    return len(chunks)


async def enqueue_pages(queries: Queries, prefix: str = "") -> int:
    """One job per page. The dedupe key keeps a page from being queued twice while it waits."""
    pages = [p for p in PAGES if p.startswith(prefix)]
    ids = await queries.enqueue(
        [ENTRYPOINT] * len(pages),
        [p.encode() for p in pages],
        [0] * len(pages),
        dedupe_key=[f"{ENTRYPOINT}:{p}" for p in pages],
        on_conflict="skip",
    )
    return sum(i is not None for i in ids)


# -------------------------------------------------------------------------------
# Worker factory for `pgq run jobs:create_pgqueuer`
# -------------------------------------------------------------------------------
def retrying(params: EntrypointExecutorParameters) -> DatabaseRetryEntrypointExecutor:
    # a GitHub hiccup re-queues the job with a doubling delay; after 3 attempts it is held as 'failed'
    return DatabaseRetryEntrypointExecutor(params, max_attempts=3, backoff_multiplier=2.0)


@contextlib.asynccontextmanager
async def create_pgqueuer() -> AsyncIterator[PgQueuer]:
    """`pgq run` enters this, runs the PgQueuer it yields, and exits it on shutdown."""
    await init_db()  # doc_chunks and the vector extension, as ingest.py does
    # asyncpg, not psycopg: pgqueuer's psycopg driver waits for notifications holding the connection
    # lock for up to a second, which every dequeue then queues behind (notebooks/pgqueuer_playground)
    conn = await asyncpg.connect(plain_dsn())
    try:
        async with httpx.AsyncClient(timeout=30) as http:
            # loaded once per worker and handed to every job through Context.resources
            resources: dict[str, object] = {"http": http, "model": TextEmbedding(settings.embed_model)}
            yield build_pgqueuer(conn, resources)
    finally:
        await conn.close()


def build_pgqueuer(conn: asyncpg.Connection, resources: dict[str, object]) -> PgQueuer:
    pgq = PgQueuer.from_asyncpg_connection(conn, resources=resources)
    queries = Queries(pgq.connection)

    @pgq.entrypoint(ENTRYPOINT, concurrency_limit=CONCURRENCY, on_failure="hold", executor_factory=retrying)
    async def run_ingest_page(job: Job, ctx: Context) -> None:
        source = (job.payload or b"").decode()
        http = ctx.resources["http"]
        model = ctx.resources["model"]
        assert isinstance(http, httpx.AsyncClient) and isinstance(model, TextEmbedding)
        t0 = time.perf_counter()
        n = await ingest_page(source, http, model)
        print(f"job {job.id}: {source} -> {n} chunks in {time.perf_counter() - t0:.1f}s")

    @pgq.schedule("refresh_docs", "0 3 * * *")  # 03:00 every day, whichever worker gets there first
    async def refresh_docs(schedule: Schedule) -> None:
        print(f"schedule {schedule.entrypoint}: queued {await enqueue_pages(queries)} pages")

    return pgq


# -------------------------------------------------------------------------------
# CLI: enqueue from the shell
# -------------------------------------------------------------------------------
async def main(prefix: str) -> None:
    conn = await asyncpg.connect(plain_dsn())
    try:
        queries = Queries.from_asyncpg_connection(conn)
        print(f"queued {await enqueue_pages(queries, prefix)} {ENTRYPOINT} jobs")
    finally:
        await conn.close()


if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] != "enqueue":
        sys.exit("usage: uv run app/jobs.py enqueue [source-prefix]")
    asyncio.run(main(sys.argv[2] if len(sys.argv) > 2 else ""))
