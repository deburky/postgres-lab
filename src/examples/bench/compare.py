"""Side-by-side micro-benchmark: pgvector/pg16 vs pgrust, same workload, same client.

Run:  uv run --env-file .env src/examples/bench/compare.py [--docs 20000] [--events 50000]

Uses DATABASE_URL (pg16 + pgvector) and PGRUST_DATABASE_URL from .env. Each server gets a
fresh `bench` schema, so nothing in `documents` / `events` is touched.

Numbers include Python + psycopg + SQLAlchemy overhead, which is identical for both
servers, so read the *ratio*, not the absolute milliseconds. Single laptop, single
connection, warm cache: this is a smell test, not a benchmark you should quote.
"""
import argparse
import asyncio
import json
import os
import random
import statistics
import time
from collections.abc import Awaitable, Callable
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, create_async_engine

from examples.jsonb._common import print_table

DIM = 256
SKUS = [f"SKU-{i:03d}" for i in range(50)]
COUNTRIES = ["NG", "GH", "KE", "ZA", "EG"]


def rand_vec() -> str:
    return "[" + ",".join(f"{random.random():.4f}" for _ in range(DIM)) + "]"


def rand_event(i: int) -> dict[str, Any]:
    n_items = random.randint(1, 5)
    items: list[dict[str, Any]] = [
        {"sku": random.choice(SKUS), "qty": random.randint(1, 4), "price": random.randint(100, 5000)}
        for _ in range(n_items)
    ]
    return {
        "kind": random.choice(["login", "purchase", "purchase", "error"]),
        "payload": {
            "user": {"id": random.randint(1, 5000), "country": random.choice(COUNTRIES)},
            "amount": sum(it["qty"] * it["price"] for it in items),
            "items": items,
            "tags": random.sample(["promo", "new", "returning", "api", "2fa"], k=random.randint(0, 3)),
        },
    }


async def timed(conn: AsyncConnection, fn: Callable[[], Awaitable[Any]], reps: int) -> float:
    """Median wall-clock ms over `reps` runs, after one warm-up."""
    await fn()
    samples = []
    for _ in range(reps):
        t0 = time.perf_counter()
        await fn()
        samples.append((time.perf_counter() - t0) * 1000)
    return statistics.median(samples)


async def bench(url: str, n_docs: int, n_events: int) -> dict[str, float]:
    random.seed(42)  # identical data on both servers
    engine = create_async_engine(url, echo=False)
    res: dict[str, float] = {}
    async with engine.begin() as conn:
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        await conn.execute(text("DROP SCHEMA IF EXISTS bench CASCADE"))
        await conn.execute(text("CREATE SCHEMA bench"))
        await conn.execute(text(f"CREATE TABLE bench.docs (id serial PRIMARY KEY, emb vector({DIM}))"))
        await conn.execute(text("CREATE TABLE bench.events (id serial PRIMARY KEY, kind text, payload jsonb)"))

    async with engine.begin() as conn:
        # ---- vectors --------------------------------------------------------
        docs = [{"e": rand_vec()} for _ in range(n_docs)]
        t0 = time.perf_counter()
        for i in range(0, n_docs, 2000):
            await conn.execute(text("INSERT INTO bench.docs (emb) VALUES (:e)"), docs[i : i + 2000])
        res["insert vectors"] = (time.perf_counter() - t0) * 1000

        q = rand_vec()
        knn = text("SELECT id FROM bench.docs ORDER BY emb <=> :q LIMIT 10")
        res["knn exact (seq scan)"] = await timed(conn, lambda: conn.execute(knn, {"q": q}), 10)

        t0 = time.perf_counter()
        await conn.execute(text("CREATE INDEX ON bench.docs USING hnsw (emb vector_cosine_ops)"))
        res["build hnsw"] = (time.perf_counter() - t0) * 1000
        res["knn hnsw"] = await timed(conn, lambda: conn.execute(knn, {"q": q}), 20)

        # ---- jsonb ----------------------------------------------------------
        rows = [rand_event(i) for i in range(n_events)]
        t0 = time.perf_counter()
        ins = text("INSERT INTO bench.events (kind, payload) VALUES (:kind, CAST(:payload AS jsonb))")
        for i in range(0, n_events, 2000):
            batch = [{"kind": r["kind"], "payload": json.dumps(r["payload"])} for r in rows[i : i + 2000]]
            await conn.execute(ins, batch)
        res["insert jsonb"] = (time.perf_counter() - t0) * 1000

        contain = text("""SELECT count(*) FROM bench.events WHERE payload @> '{"user": {"country": "NG"}, "tags": ["promo"]}'""")
        res["jsonb @> (seq scan)"] = await timed(conn, lambda: conn.execute(contain), 10)
        t0 = time.perf_counter()
        await conn.execute(text("CREATE INDEX ON bench.events USING gin (payload jsonb_path_ops)"))
        res["build gin"] = (time.perf_counter() - t0) * 1000
        res["jsonb @> (gin)"] = await timed(conn, lambda: conn.execute(contain), 20)

        agg = text("""
            SELECT kind, count(*), avg((payload->>'amount')::numeric)
            FROM bench.events GROUP BY kind
        """)
        res["group by + avg"] = await timed(conn, lambda: conn.execute(agg), 10)

        unnest = text("""
            SELECT item->>'sku' AS sku, sum((item->>'qty')::int) AS units
            FROM bench.events, jsonb_array_elements(payload->'items') AS item
            GROUP BY sku ORDER BY units DESC LIMIT 5
        """)
        res["unnest items + group by"] = await timed(conn, lambda: conn.execute(unnest), 10)

        path = text("""SELECT count(*) FROM bench.events WHERE payload @? '$.items[*] ? (@.price > 4000)'""")
        res["jsonpath @? (gin)"] = await timed(conn, lambda: conn.execute(path), 10)

        await conn.execute(text("DROP SCHEMA bench CASCADE"))
    await engine.dispose()
    return res


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--docs", type=int, default=20_000)
    ap.add_argument("--events", type=int, default=50_000)
    args = ap.parse_args()

    targets = {
        "pg16+pgvector": os.environ["DATABASE_URL"],
        "pgrust": os.environ["PGRUST_DATABASE_URL"],
    }
    results: dict[str, dict[str, float]] = {}
    for name, url in targets.items():
        print(f"running against {name} ... ", end="", flush=True)
        t0 = time.perf_counter()
        results[name] = await bench(url, args.docs, args.events)
        print(f"{time.perf_counter() - t0:.1f}s")

    a, b = list(targets)
    print(f"\n{args.docs:,} vectors x {DIM} dims, {args.events:,} jsonb rows. Median ms; lower is better.\n")
    rows = []
    for k in results[a]:
        ma, mb = results[a][k], results[b][k]
        rows.append((k, round(ma, 1), round(mb, 1), f"{ma / mb:.2f}x" if mb else "-"))
    print_table(["benchmark", f"{a} ms", f"{b} ms", f"{a}/{b}"], rows)
    print("\nratio > 1 means pgrust was faster on that line.")


if __name__ == "__main__":
    asyncio.run(main())
