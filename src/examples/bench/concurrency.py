"""Concurrency benchmark: N connections at once against pg16+pgvector and pgrust.

Run:  uv run --env-file .env src/examples/bench/concurrency.py [--levels 1,4,16,32] [--seconds 3]

For each server: build a `bench` schema once (vectors + HNSW, jsonb + GIN), then for each
workload and each concurrency level open that many pooled connections and let every one of
them run the query in a tight loop for `--seconds`. Reports throughput (queries/s) and p95
latency. Ratio > 1 means pgrust did more work per second.

Workloads
    knn hnsw        indexed point lookup, random query vector each time
    jsonb @> gin    indexed containment, random country + tag
    group by + avg  full-table analytic scan (CPU bound, shows core scaling)
    insert 1 row    single-row insert + commit (write path / commit cost)

Docker Desktop's VM caps the cores available to BOTH servers, so what you are comparing is
how well each engine uses the same N cores, not raw hardware.
"""
import argparse
import asyncio
import json
import os
import random
import time
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from examples.bench.compare import COUNTRIES, DIM, rand_event, rand_vec
from examples.jsonb._common import print_table

TAGS = ["promo", "new", "returning", "api", "2fa"]


async def setup(engine: AsyncEngine, n_docs: int, n_events: int) -> None:
    random.seed(42)
    async with engine.begin() as conn:
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        await conn.execute(text("DROP SCHEMA IF EXISTS bench CASCADE"))
        await conn.execute(text("CREATE SCHEMA bench"))
        await conn.execute(text(f"CREATE TABLE bench.docs (id serial PRIMARY KEY, emb vector({DIM}))"))
        await conn.execute(text("CREATE TABLE bench.events (id serial PRIMARY KEY, kind text, payload jsonb)"))
        docs = [{"e": rand_vec()} for _ in range(n_docs)]
        for i in range(0, n_docs, 2000):
            await conn.execute(text("INSERT INTO bench.docs (emb) VALUES (:e)"), docs[i : i + 2000])
        ins = text("INSERT INTO bench.events (kind, payload) VALUES (:kind, CAST(:payload AS jsonb))")
        for i in range(0, n_events, 2000):
            batch = [
                {"kind": r["kind"], "payload": json.dumps(r["payload"])}
                for r in (rand_event(j) for j in range(i, min(i + 2000, n_events)))
            ]
            await conn.execute(ins, batch)
        await conn.execute(text("CREATE INDEX ON bench.docs USING hnsw (emb vector_cosine_ops)"))
        await conn.execute(text("CREATE INDEX ON bench.events USING gin (payload jsonb_path_ops)"))
        await conn.execute(text("ANALYZE bench.docs"))
        await conn.execute(text("ANALYZE bench.events"))


QUERY_VECS = [rand_vec() for _ in range(256)]

WORKLOADS: dict[str, tuple[str, Any]] = {
    "knn hnsw": (
        "SELECT id FROM bench.docs ORDER BY emb <=> :q LIMIT 10",
        lambda: {"q": random.choice(QUERY_VECS)},
    ),
    "jsonb @> gin": (
        "SELECT count(*) FROM bench.events WHERE payload @> CAST(:doc AS jsonb)",
        lambda: {"doc": json.dumps({"user": {"country": random.choice(COUNTRIES)}, "tags": [random.choice(TAGS)]})},
    ),
    "group by + avg": (
        "SELECT kind, count(*), avg((payload->>'amount')::numeric) FROM bench.events GROUP BY kind",
        lambda: {},
    ),
    "insert 1 row": (
        "INSERT INTO bench.events (kind, payload) VALUES ('bench', CAST(:doc AS jsonb))",
        lambda: {"doc": json.dumps(rand_event(0)["payload"])},
    ),
}


async def worker(engine: AsyncEngine, sql: str, params: Any, deadline: float, out: list[float]) -> None:
    stmt = text(sql)
    async with engine.connect() as conn:
        while time.perf_counter() < deadline:
            p = params()
            t0 = time.perf_counter()
            await conn.execute(stmt, p)
            await conn.commit()  # one transaction per query, like a real request would
            out.append((time.perf_counter() - t0) * 1000)


async def run_level(url: str, name: str, level: int, seconds: float) -> tuple[float, float, float]:
    """Return (queries/sec, p50 ms, p95 ms) for `level` concurrent connections."""
    sql, params = WORKLOADS[name]
    engine = create_async_engine(url, pool_size=level, max_overflow=0)
    # open all connections before the clock starts
    conns = [await engine.connect() for _ in range(level)]
    for c in conns:
        await c.close()
    lat: list[float] = []
    t0 = time.perf_counter()
    await asyncio.gather(*(worker(engine, sql, params, t0 + seconds, lat) for _ in range(level)))
    elapsed = time.perf_counter() - t0
    await engine.dispose()
    lat.sort()
    p = lambda q: lat[min(len(lat) - 1, int(len(lat) * q))]  # noqa: E731
    return len(lat) / elapsed, p(0.50), p(0.95)


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--docs", type=int, default=20_000)
    ap.add_argument("--events", type=int, default=50_000)
    ap.add_argument("--levels", default="1,4,16,32")
    ap.add_argument("--seconds", type=float, default=3.0)
    args = ap.parse_args()
    levels = [int(x) for x in args.levels.split(",")]

    targets = {
        "pg16": os.environ["DATABASE_URL"],
        "pgrust": os.environ["PGRUST_DATABASE_URL"],
    }
    for name, url in targets.items():
        print(f"setting up {name} ... ", end="", flush=True)
        t0 = time.perf_counter()
        eng = create_async_engine(url)
        await setup(eng, args.docs, args.events)
        await eng.dispose()
        print(f"{time.perf_counter() - t0:.1f}s")

    a, b = list(targets)
    results: dict[str, dict[str, dict[int, tuple[float, float, float]]]] = {a: {}, b: {}}
    for wl in WORKLOADS:
        for srv, url in targets.items():
            results[srv][wl] = {}
            print(f"  {wl:<16} {srv:<7}", end="", flush=True)
            for lvl in levels:
                results[srv][wl][lvl] = await run_level(url, wl, lvl, args.seconds)
                print(f" x{lvl}", end="", flush=True)
            print()

    print(f"\n{args.docs:,} vectors, {args.events:,} jsonb rows, {args.seconds:.0f}s per cell. "
          f"qps = queries/sec (higher is better), p95 = ms.\n")
    for wl in WORKLOADS:
        rows = []
        for lvl in levels:
            qa, _, pa = results[a][wl][lvl]
            qb, _, pb = results[b][wl][lvl]
            rows.append((lvl, round(qa), round(qb), f"{qb / qa:.2f}x", round(pa, 1), round(pb, 1)))
        print(f"=== {wl}")
        print_table(["conns", f"{a} qps", f"{b} qps", "pgrust/pg16", f"{a} p95", f"{b} p95"], rows)
        print()

    for url in targets.values():
        eng = create_async_engine(url)
        async with eng.begin() as conn:
            await conn.execute(text("DROP SCHEMA IF EXISTS bench CASCADE"))
        await eng.dispose()


if __name__ == "__main__":
    asyncio.run(main())
