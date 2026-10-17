"""Reading pgvector columns back as numpy or Arrow, fast.

    from vecio import read_vectors, read_arrow

    vecs = read_vectors(conn, "SELECT embedding FROM doc_chunks ORDER BY id")   # psycopg conn -> (n, dim) float32
    table = read_arrow(dsn, "SELECT id, embedding::real[] AS embedding FROM doc_chunks")  # ADBC -> pyarrow.Table
    m = arrow_matrix(table["embedding"])                                          # list<float> column -> (n, dim)

`read_vectors` streams `COPY (query) TO STDOUT (FORMAT BINARY)` and decodes pgvector's wire format
in one numpy pass: per value an int16 dimension, an int16 that is always 0, then big-endian
float32s. `read_arrow` goes through ADBC, which does not know the `vector` type (it comes back as an
opaque binary column), so cast to `real[]` in SQL and it arrives as `list<float>`.
"""

import numpy as np
import psycopg
import pyarrow as pa

COPY_HEADER = 19  # 11-byte signature, int32 flags, int32 extension length


def read_vectors(conn: psycopg.Connection, query: str) -> np.ndarray:
    """One vector column, `query` selecting exactly that column; rows in the query's order."""
    with conn.cursor().copy(f"COPY ({query}) TO STDOUT (FORMAT BINARY)") as copy:
        buf = b"".join(copy)
    body = memoryview(buf)[COPY_HEADER:-2]  # trailer: int16 -1
    if len(body) == 0:
        return np.empty((0, 0), dtype=np.float32)
    # per row: int16 column count, int32 field length, then the vector: int16 dim, int16 unused, dim floats
    dim = int.from_bytes(body[6:8], "big")
    row_bytes = 2 + 4 + 4 + 4 * dim
    rows = np.frombuffer(body, dtype=np.uint8).reshape(-1, row_bytes)
    return rows[:, 10:].copy().view(">f4").astype(np.float32, copy=False).reshape(-1, dim)


def read_arrow(dsn: str, query: str) -> pa.Table:
    """The query as an Arrow table through ADBC; `dsn` is a plain postgresql:// URL."""
    import adbc_driver_postgresql.dbapi as adbc

    with adbc.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(query)
        return cur.fetch_arrow_table()


def arrow_matrix(column: pa.ChunkedArray | pa.ListArray) -> np.ndarray:
    """A list<float> column with equal-length lists as an (n, dim) array, without copying the floats."""
    arr = column.combine_chunks() if isinstance(column, pa.ChunkedArray) else column
    flat = arr.values.to_numpy(zero_copy_only=False)
    return flat.reshape(len(arr), -1)
