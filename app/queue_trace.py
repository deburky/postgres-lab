"""A traced pgqueuer run for the queue scene in viz/ (POST /queue/trace in app.py).

Real workers, a real queue table, real NOTIFYs: `run()` starts W pgqueuer workers on their own
asyncpg connections, enqueues N jobs (all at once, or one at a time), lets the workers drain them,
and returns a timeline of what happened, in milliseconds from the first enqueue:

- `enqueue`: a job row was inserted (id, priority, attempt 0);
- `notify`: the insert trigger's NOTIFY arrived on ch_pgqueuer (heard by an observer connection,
  the same message every idle worker receives);
- `start` / `end`: a worker ran one attempt of a job; `end` says whether it succeeded, and if not,
  whether the job went back to the queue (`retry_ms` until it may run again) or was held as failed.

Jobs only sleep; the point is the queue. Failures are drawn from a seeded RNG per (job, attempt), so
the same parameters give the same story. Every job uses the entrypoint `viz_job`, and its rows are
cleared before and after, so other queues in the same tables are not touched.
"""

import asyncio
import random
import time
from datetime import timedelta
from typing import Literal

import asyncpg
from pgqueuer import PgQueuer, Queries
from pgqueuer.errors import RetryRequested
from pgqueuer.models import Job
from pgqueuer.types import QueueExecutionMode
from pydantic import BaseModel, Field

from settings import settings

ENTRYPOINT = "viz_job"


class QueueTraceRequest(BaseModel):
    jobs: int = Field(24, ge=1, le=200)
    workers: int = Field(3, ge=1, le=8)
    batch_size: int = Field(2, ge=1, le=20, description="rows one dequeue may claim")
    max_concurrent_tasks: int = Field(4, ge=0, le=100, description="jobs one worker holds at once; 0 = no cap, >= 2 x batch_size")
    concurrency_limit: int = Field(0, ge=0, le=50, description="picked jobs at once, across all workers; 0 = no limit")
    job_ms: int = Field(120, ge=1, le=2000, description="how long one attempt sleeps, +-40%")
    fail_rate: float = Field(0.0, ge=0, le=1, description="chance that an attempt raises")
    max_attempts: int = Field(3, ge=1, le=6, description="after this many failed attempts a job is held as failed")
    retry_ms: int = Field(150, ge=10, le=5000, description="first retry delay; doubles per attempt")
    enqueue: Literal["batch", "drip"] = Field("batch", description="all rows in one INSERT, or one job at a time")
    drip_ms: int = Field(60, ge=5, le=2000, description="gap between jobs in drip mode")
    priorities: bool = Field(False, description="random priorities 0..3, so dequeue order differs from insert order")
    seed: int = 7


def plain_dsn() -> str:
    return settings.sqlalchemy_url("pg16").replace("postgresql+psycopg://", "postgresql://")


async def _clear(conn: asyncpg.Connection) -> None:
    for table in ("pgqueuer", "pgqueuer_log", "pgqueuer_statistics"):
        await conn.execute(f"DELETE FROM {table} WHERE entrypoint = $1", ENTRYPOINT)


async def run(req: QueueTraceRequest) -> dict:
    rng = random.Random(req.seed)
    durations = [req.job_ms * rng.uniform(0.6, 1.4) for _ in range(req.jobs)]
    priorities = [rng.randint(0, 3) if req.priorities else 0 for _ in range(req.jobs)]
    events: list[dict] = []
    t0 = 0.0
    now = lambda: 1000 * (time.perf_counter() - t0)  # noqa: E731
    finished = asyncio.Event()
    final = 0

    conn = await asyncpg.connect(plain_dsn())
    queries = Queries.from_asyncpg_connection(conn)
    if not await queries.schema_is_installed():
        await queries.install()
    await _clear(conn)

    # the observer: hears what every idle worker hears
    observer = await asyncpg.connect(plain_dsn())

    def on_notify(_c, _pid, _channel, payload: str) -> None:
        if t0 and '"operation" : "insert"' in payload:
            events.append({"t": now(), "kind": "notify"})

    await observer.add_listener("ch_pgqueuer", on_notify)

    # -------------------------------------------------------------------------------
    # Workers: each its own connection and queue manager, all running one entrypoint
    # -------------------------------------------------------------------------------
    def make_handler(worker: int):
        async def handler(job: Job) -> None:
            nonlocal final
            i = int(job.payload or b"-1")  # our label 0..jobs-1, carried in the payload
            attempt = job.attempts
            events.append({"t": now(), "kind": "start", "job": i, "worker": worker, "attempt": attempt})
            await asyncio.sleep(durations[i] / 1000)
            end = {"t": 0.0, "kind": "end", "job": i, "worker": worker, "attempt": attempt}
            if random.Random(f"{req.seed}:{i}:{attempt}").random() >= req.fail_rate:
                events.append(end | {"t": now(), "ok": True})
            elif attempt + 1 < req.max_attempts:
                # back to 'queued' with execute_after = now + delay, attempts + 1
                delay = req.retry_ms * 2**attempt
                events.append(end | {"t": now(), "ok": False, "retry_ms": delay})
                raise RetryRequested(delay=timedelta(milliseconds=delay), reason="flaky")
            else:
                events.append(end | {"t": now(), "ok": False, "held": True})
            final += 1
            if final >= req.jobs:
                finished.set()
            if not events[-1]["ok"]:
                raise RuntimeError(f"job {i} failed on its last attempt")  # on_failure="hold" keeps the row

        return handler

    # pgqueuer insists on a per-worker cap of at least two batches; without one a worker keeps
    # dequeuing until it holds every row it can see
    cap = max(req.max_concurrent_tasks, 2 * req.batch_size) if req.max_concurrent_tasks else None
    wconns, pgqs = [], []
    for w in range(req.workers):
        wc = await asyncpg.connect(plain_dsn())
        pgq = PgQueuer.from_asyncpg_connection(wc)
        pgq.entrypoint(ENTRYPOINT, concurrency_limit=req.concurrency_limit, on_failure="hold")(make_handler(w))
        wconns.append(wc)
        pgqs.append(pgq)
    tasks = [
        asyncio.create_task(p.qm.run(mode=QueueExecutionMode.continuous, batch_size=req.batch_size,
                                     max_concurrent_tasks=cap, dequeue_timeout=timedelta(seconds=10)))
        for p in pgqs
    ]
    await asyncio.sleep(0.5)  # every worker reaches its idle LISTEN wait

    # -------------------------------------------------------------------------------
    # Producer
    # -------------------------------------------------------------------------------
    t0 = time.perf_counter()
    if req.enqueue == "batch":
        events.append({"t": now(), "kind": "insert", "jobs": req.jobs})
        await queries.enqueue([ENTRYPOINT] * req.jobs, [str(i).encode() for i in range(req.jobs)], priorities)
        events.extend({"t": now(), "kind": "enqueue", "job": i, "priority": priorities[i]} for i in range(req.jobs))
    else:
        for i in range(req.jobs):
            events.append({"t": now(), "kind": "insert", "jobs": 1})
            await queries.enqueue(ENTRYPOINT, str(i).encode(), priorities[i])
            events.append({"t": now(), "kind": "enqueue", "job": i, "priority": priorities[i]})
            await asyncio.sleep(req.drip_ms / 1000)

    timed_out = False
    try:
        await asyncio.wait_for(finished.wait(), timeout=60)
    except TimeoutError:
        timed_out = True
    duration = now()

    for p in pgqs:
        p.qm.shutdown.set()
    await asyncio.gather(*tasks, return_exceptions=True)
    for wc in wconns:
        await wc.close()
    await observer.close()
    held = await conn.fetchval("SELECT count(*) FROM pgqueuer WHERE entrypoint = $1 AND status = 'failed'", ENTRYPOINT)
    await _clear(conn)
    version = await conn.fetchval("SHOW server_version")
    await conn.close()

    events.sort(key=lambda e: e["t"])
    return {
        "config": req.model_dump(),
        "server": f"PostgreSQL {version}",
        "workers": [str(p.qm.queue_manager_id) for p in pgqs],
        "duration_ms": duration,
        "timed_out": timed_out,
        "held_in_table": held,
        "events": events,
    }
