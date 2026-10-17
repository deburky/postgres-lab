"""Five ways to bulk-load vectors into pgvector, and three ways to read them back, timed on the same rows.

Run:  uv run --env-file .env src/examples/bench/pg_copy.py [--rows 50000] [--dim 384] [--server pg16]

Every method loads the same (title, embedding) rows into `bench.copy_test`, truncated in between,
and is checked afterwards: the row count and one embedding read back must match the source.

  orm          Session.add_all with a mapped class            what app/ingest.py does
  executemany  Core insert() with a list of dicts             SQLAlchemy's insertmanyvalues batching
  copy_text    psycopg COPY FROM STDIN, text format           vectors travel as "[0.1,0.2,...]" strings
  copy_binary  psycopg COPY ... (FORMAT BINARY)               pgvector's binary dumper, numpy rows straight in
  pgpq         Parquet -> Arrow -> pgpq -> COPY BINARY        into a temp FLOAT4[] table, then INSERT ... SELECT
                                                              with the real[] -> vector cast (pgpq has no vector type)

Then the whole table is read back into an (n, dim) numpy array three ways, each checked against the source:

  psycopg_rows  SELECT ... with binary=True, pgvector's loader, np.stack over the rows
  copy_binary   COPY (SELECT ...) TO STDOUT (FORMAT BINARY) decoded in one numpy pass (src/vecio.py)
  adbc_arrow    adbc-driver-postgresql, SELECT embedding::real[] as an Arrow list<float>, reshaped without a copy

There is no index on the table: build HNSW after the load, not during it. Single laptop, single
connection, warm cache; read the ratios, not the milliseconds.
"""

import argparse
import tempfile
import time
from pathlib import Path
from typing import get_args

import numpy as np
import psycopg
import pyarrow as pa
import pyarrow.parquet as pq
from pgpq import ArrowToPostgresBinaryEncoder
from pgvector.psycopg import register_vector
from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    Column,
    Integer,
    MetaData,
    Table,
    Text,
    create_engine,
    insert,
)
from sqlalchemy.orm import DeclarativeBase, Session

from examples.jsonb._common import print_table
from settings import Server, settings
from vecio import arrow_matrix, read_arrow, read_vectors

TABLE = "bench.copy_test"


# -------------------------------------------------------------------------------
# Data: the same rows for every method
# -------------------------------------------------------------------------------
def make_rows(n: int, dim: int) -> tuple[list[str], np.ndarray]:
    rng = np.random.default_rng(42)
    return [f"doc {i}" for i in range(n)], rng.random((n, dim), dtype=np.float32)


def write_parquet(titles: list[str], vecs: np.ndarray, path: Path) -> float:
    """Arrow list<float32> column built straight from the 2-D array; returns the seconds it took."""
    t0 = time.perf_counter()
    n, dim = vecs.shape
    offsets = pa.array(np.arange(0, (n + 1) * dim, dim, dtype=np.int32))
    emb = pa.ListArray.from_arrays(offsets, pa.array(vecs.ravel()))
    pq.write_table(pa.table({"title": pa.array(titles), "embedding": emb}), path)
    return time.perf_counter() - t0


# -------------------------------------------------------------------------------
# Schema
# -------------------------------------------------------------------------------
def make_table(dim: int) -> tuple[Table, type]:
    metadata = MetaData(schema="bench")
    table = Table(
        "copy_test",
        metadata,
        Column("id", Integer, primary_key=True),
        Column("title", Text, nullable=False),
        Column("embedding", Vector(dim), nullable=False),
    )

    class Base(DeclarativeBase):
        pass

    class Row(Base):
        __table__ = table

    return table, Row


def reset(dsn: str, dim: int) -> None:
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
        conn.execute("CREATE SCHEMA IF NOT EXISTS bench")
        conn.execute(f"DROP TABLE IF EXISTS {TABLE}")
        conn.execute(
            f"CREATE TABLE {TABLE} (id bigserial PRIMARY KEY, title text NOT NULL, embedding vector({dim}) NOT NULL)"
        )


def truncate(dsn: str) -> None:
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute(f"TRUNCATE {TABLE}")


def check(dsn: str, titles: list[str], vecs: np.ndarray, method: str) -> None:
    """The load must have landed every row, and the bytes must be the floats we sent."""
    with psycopg.connect(dsn) as conn:
        register_vector(conn)
        n = conn.execute(f"SELECT count(*) FROM {TABLE}").fetchone()[0]
        assert n == len(titles), f"{method}: {n} rows, expected {len(titles)}"
        probe = len(titles) // 2
        got = conn.execute(f"SELECT embedding FROM {TABLE} WHERE title = %s", (titles[probe],)).fetchone()[0]
        assert np.allclose(got.to_numpy(), vecs[probe], atol=1e-6), f"{method}: row {probe} came back different"


# -------------------------------------------------------------------------------
# The five loaders
# -------------------------------------------------------------------------------
def load_orm(url: str, Row: type, titles: list[str], vecs: np.ndarray) -> None:
    engine = create_engine(url)
    with Session(engine) as session:
        session.add_all(Row(title=t, embedding=v) for t, v in zip(titles, vecs))
        session.commit()
    engine.dispose()


def load_executemany(url: str, table: Table, titles: list[str], vecs: np.ndarray) -> None:
    engine = create_engine(url)
    with engine.begin() as conn:
        conn.execute(insert(table), [{"title": t, "embedding": v} for t, v in zip(titles, vecs)])
    engine.dispose()


def load_copy_text(dsn: str, titles: list[str], vecs: np.ndarray) -> None:
    with psycopg.connect(dsn) as conn:
        register_vector(conn)
        with conn.cursor() as cur, cur.copy(f"COPY {TABLE} (title, embedding) FROM STDIN") as copy:
            for t, v in zip(titles, vecs):
                copy.write_row((t, v))
        conn.commit()


def load_copy_binary(dsn: str, titles: list[str], vecs: np.ndarray) -> None:
    with psycopg.connect(dsn) as conn:
        register_vector(conn)
        with conn.cursor() as cur, cur.copy(f"COPY {TABLE} (title, embedding) FROM STDIN (FORMAT BINARY)") as copy:
            copy.set_types(["text", "vector"])
            for t, v in zip(titles, vecs):
                copy.write_row((t, v))
        conn.commit()


PHASES: dict[str, float] = {}  # the two halves of the pgpq load, reported under the table


def load_pgpq(dsn: str, parquet: Path) -> None:
    """The pattern from pg_copy.py: stage the Arrow batches in a temp table pgpq can describe, then cast."""
    reader = pq.ParquetFile(parquet)
    encoder = ArrowToPostgresBinaryEncoder(reader.schema_arrow)
    cols = ", ".join(f'"{c.name}" {c.data_type.ddl()}' for c in encoder.schema().columns)
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(f"CREATE TEMP TABLE pgpq_stage ({cols})")
        t0 = time.perf_counter()
        with cur.copy("COPY pgpq_stage FROM STDIN (FORMAT BINARY)") as copy:
            copy.write(encoder.write_header())
            for batch in reader.iter_batches(batch_size=5000):
                copy.write(encoder.write_batch(batch))
            copy.write(encoder.finish())
        PHASES["pgpq COPY into the FLOAT4[] stage"] = time.perf_counter() - t0
        t0 = time.perf_counter()
        cur.execute(f"INSERT INTO {TABLE} (title, embedding) SELECT title, embedding::vector FROM pgpq_stage")
        conn.commit()
        PHASES["pgpq INSERT ... SELECT with the real[] -> vector cast"] = time.perf_counter() - t0


# -------------------------------------------------------------------------------
# The three readers: whole table -> (n, dim) float32, in id order
# -------------------------------------------------------------------------------
def read_psycopg_rows(dsn: str) -> np.ndarray:
    with psycopg.connect(dsn) as conn:
        register_vector(conn)
        rows = conn.execute(f"SELECT embedding FROM {TABLE} ORDER BY id", binary=True).fetchall()
    return np.stack([r[0].to_numpy() for r in rows])


def read_copy_binary(dsn: str) -> np.ndarray:
    with psycopg.connect(dsn) as conn:
        return read_vectors(conn, f"SELECT embedding FROM {TABLE} ORDER BY id")


def read_adbc_arrow(dsn: str) -> np.ndarray:
    table = read_arrow(dsn, f"SELECT embedding::real[] AS embedding FROM {TABLE} ORDER BY id")
    return arrow_matrix(table["embedding"])


def source_order(dsn: str) -> np.ndarray:
    """Which source row each table row holds, in id order (the pgpq INSERT ... SELECT need not keep order)."""
    with psycopg.connect(dsn) as conn:
        titles = conn.execute(f"SELECT title FROM {TABLE} ORDER BY id").fetchall()
    return np.array([int(t[0].split()[1]) for t in titles])


# -------------------------------------------------------------------------------
# Main
# -------------------------------------------------------------------------------
def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--rows", type=int, default=50_000)
    ap.add_argument("--dim", type=int, default=settings.embed_dim)
    ap.add_argument("--server", default="pg16", choices=get_args(Server))
    args = ap.parse_args()
    server: Server = args.server

    url = settings.sqlalchemy_url(server)
    dsn = url.replace("postgresql+psycopg://", "postgresql://")
    titles, vecs = make_rows(args.rows, args.dim)
    mb = vecs.nbytes / 1e6
    print(f"{args.rows:,} rows x {args.dim} dims = {mb:.0f} MB of float32, into {TABLE} on {server}")

    table, Row = make_table(args.dim)
    reset(dsn, args.dim)
    parquet = Path(tempfile.mkdtemp(prefix="pg-copy-")) / "rows.parquet"
    parquet_s = write_parquet(titles, vecs, parquet)
    print(f"parquet written in {parquet_s:.2f}s ({parquet.stat().st_size / 1e6:.0f} MB), not counted in the pgpq row")

    methods = [
        ("orm", lambda: load_orm(url, Row, titles, vecs)),
        ("executemany", lambda: load_executemany(url, table, titles, vecs)),
        ("copy_text", lambda: load_copy_text(dsn, titles, vecs)),
        ("copy_binary", lambda: load_copy_binary(dsn, titles, vecs)),
        ("pgpq", lambda: load_pgpq(dsn, parquet)),
    ]
    results: list[tuple[str, float]] = []
    for name, fn in methods:
        truncate(dsn)
        t0 = time.perf_counter()
        fn()
        secs = time.perf_counter() - t0
        check(dsn, titles, vecs, name)
        results.append((name, secs))
        print(f"  {name:<12} {secs:6.2f}s")

    base = results[0][1]
    print()
    print_table(
        ["method", "seconds", "rows/s", "MB/s", "vs orm"],
        [(n, round(s, 2), int(args.rows / s), round(mb / s, 1), f"{base / s:.1f}x") for n, s in results],
    )
    for what, secs in PHASES.items():
        print(f"  {secs:5.2f}s  {what}")
    parquet.unlink()
    parquet.parent.rmdir()

    # ---- read back -------------------------------------------------------------
    print()
    expected = vecs[source_order(dsn)]
    readers = [("psycopg_rows", read_psycopg_rows), ("copy_binary", read_copy_binary), ("adbc_arrow", read_adbc_arrow)]
    reads: list[tuple[str, float]] = []
    for name, fn in readers:
        fn(dsn)  # warm-up: connection, plan, driver import
        t0 = time.perf_counter()
        got = fn(dsn)
        secs = time.perf_counter() - t0
        assert got.shape == expected.shape and np.allclose(got, expected, atol=1e-6), f"{name}: read back different data"
        reads.append((name, secs))
        print(f"  {name:<12} {secs:6.2f}s")
    base = reads[0][1]
    print()
    print_table(
        ["read back as numpy", "seconds", "rows/s", "MB/s", "vs psycopg_rows"],
        [(n, round(s, 2), int(args.rows / s), round(mb / s, 1), f"{base / s:.1f}x") for n, s in reads],
    )


if __name__ == "__main__":
    main()
