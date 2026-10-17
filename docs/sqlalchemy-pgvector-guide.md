# SQLAlchemy + pgvector: A Complete Guide

A hands-on guide from setup to production patterns. Assumes Python 3.11+,
PostgreSQL 15+, and familiarity with async SQLAlchemy basics.

---

## 0. Setup

```bash
pip install sqlalchemy asyncpg pgvector psycopg2-binary alembic numpy
```

Start a local Postgres with pgvector:

```bash
docker run -d \
  --name pgvector-dev \
  -e POSTGRES_USER=app \
  -e POSTGRES_PASSWORD=pwd \
  -e POSTGRES_DB=app \
  -p 5432:5432 \
  pgvector/pgvector:pg16
```

---

## 1. Enable the Extension

pgvector must be enabled once per database:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Or do it from Python at startup (shown in Section 3).

---

## 2. Core Concepts

pgvector adds one new Postgres type: `vector(n)` — a fixed-dimension array of
floats stored efficiently with support for three distance operators:

| Operator | Distance       | Use case                        |
|----------|----------------|---------------------------------|
| `<->`    | L2 (Euclidean) | General similarity              |
| `<=>`    | Cosine         | Text/image embeddings           |
| `<#>`    | Inner product  | When vectors are unit-normalised|

The SQLAlchemy `pgvector` package maps this type and exposes the operators
as Python methods.

---

## 3. Database Setup and Engine

```python
# db.py
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy import text

engine = create_async_engine(
    "postgresql+asyncpg://app:pwd@localhost/app",
    pool_size=10,
    max_overflow=20,
    pool_timeout=30,
    pool_recycle=1800,
    pool_pre_ping=True,  # recover from idle connection drops
    echo=False,
)

SessionLocal = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)

async def init_db():
    """Enable pgvector extension and create tables."""
    async with engine.begin() as conn:
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        await conn.run_sync(Base.metadata.create_all)
```

---

## 4. Defining Models

```python
# models.py
from sqlalchemy import String, Text, DateTime, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from pgvector.sqlalchemy import Vector
import uuid

class Base(DeclarativeBase):
    pass

class Document(Base):
    __tablename__ = "documents"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True,
        default=uuid.uuid4,
    )
    content: Mapped[str] = mapped_column(Text, nullable=False)
    source: Mapped[str] = mapped_column(String(255), nullable=True)
    embedding: Mapped[list[float]] = mapped_column(Vector(1536), nullable=True)
    created_at: Mapped[DateTime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
    )
```

`Vector(n)` is the pgvector SQLAlchemy type. The dimension `n` must match
your embedding model's output dimension — 1536 for OpenAI `text-embedding-3-small`,
512 for many image models, 768 for `sentence-transformers`.

---

## 5. Inserting Embeddings

```python
# crud.py
import numpy as np
from sqlalchemy import select
from models import Document

async def insert_document(session: AsyncSession, content: str, embedding: list[float]) -> Document:
    doc = Document(content=content, embedding=embedding)
    session.add(doc)
    await session.commit()
    await session.refresh(doc)
    return doc

async def bulk_insert_documents(session: AsyncSession, records: list[dict]) -> None:
    """Efficient bulk insert using Core insert statement."""
    from sqlalchemy import insert
    from models import Document

    stmt = insert(Document).values(records)
    await session.execute(stmt)
    await session.commit()
```

Embeddings are passed as plain Python lists or numpy arrays — pgvector handles
the serialisation:

```python
embedding = [0.12, -0.34, 0.56, ...]          # list[float]
embedding = np.array([0.12, -0.34, 0.56, ...]) # numpy array also works
```

---

## 6. Similarity Search

This is the core operation. pgvector exposes distance methods on the column:

```python
from pgvector.sqlalchemy import Vector
from sqlalchemy import select, func

async def similarity_search(
    session: AsyncSession,
    query_embedding: list[float],
    top_k: int = 10,
    threshold: float = 0.8,
) -> list[Document]:

    stmt = (
        select(Document)
        .order_by(Document.embedding.cosine_distance(query_embedding))
        .limit(top_k)
    )
    result = await session.execute(stmt)
    return list(result.scalars())
```

Available distance methods on any `Vector` column:

```python
col.l2_distance(vector)       # Euclidean — <->
col.cosine_distance(vector)   # Cosine    — <=>
col.max_inner_product(vector) # Inner product — <#>
```

### Returning the distance score

```python
from sqlalchemy import func

distance = Document.embedding.cosine_distance(query_embedding).label("distance")

stmt = (
    select(Document, distance)
    .order_by(distance)
    .limit(top_k)
)

rows = await session.execute(stmt)
for doc, dist in rows:
    print(doc.content, dist)
```

### Filtering before search

Combine a WHERE clause with ORDER BY distance — pgvector applies the filter
first, then ranks:

```python
stmt = (
    select(Document)
    .where(Document.source == "internal")
    .order_by(Document.embedding.cosine_distance(query_embedding))
    .limit(top_k)
)
```

Note: at high filter ratios (e.g. filtering out 95% of rows), HNSW recall
degrades. See Section 9 on indexing for mitigation.

---

## 7. Relationships: Embeddings Alongside Structured Data

A common pattern: store entity data in one table, embeddings in another.
This keeps the main table lean and lets you evolve the embedding dimension
independently.

```python
# models.py
from sqlalchemy.orm import relationship
from sqlalchemy import ForeignKey
import uuid

class Customer(Base):
    __tablename__ = "customers"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(255))
    credit_score: Mapped[int] = mapped_column(nullable=True)
    embedding: Mapped["CustomerEmbedding"] = relationship(
        back_populates="customer",
        uselist=False,
        lazy="selectin",  # auto-loaded with the parent
    )

class CustomerEmbedding(Base):
    __tablename__ = "customer_embeddings"

    customer_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("customers.id", ondelete="CASCADE"),
        primary_key=True,
    )
    embedding: Mapped[list[float]] = mapped_column(Vector(512))
    model_version: Mapped[str] = mapped_column(String(50))  # track which model generated it
    customer: Mapped["Customer"] = relationship(back_populates="embedding")
```

Query with join:

```python
from sqlalchemy.orm import selectinload

stmt = (
    select(Customer)
    .join(CustomerEmbedding)
    .where(Customer.credit_score >= 600)
    .order_by(
        CustomerEmbedding.embedding.cosine_distance(query_embedding)
    )
    .limit(10)
    .options(selectinload(Customer.embedding))
)
```

---

## 8. CTEs and Window Functions

SQLAlchemy CTEs make complex queries composable without raw SQL.

### CTE for candidate retrieval then reranking

```python
from sqlalchemy import select, func

# Step 1: retrieve top-100 candidates by vector distance
candidates = (
    select(
        Document.id,
        Document.content,
        Document.embedding.cosine_distance(query_embedding).label("vector_dist"),
    )
    .order_by("vector_dist")
    .limit(100)
    .cte("candidates")
)

# Step 2: rerank within the CTE (e.g. blend with a text score)
stmt = (
    select(
        candidates.c.id,
        candidates.c.content,
        candidates.c.vector_dist,
    )
    .order_by(candidates.c.vector_dist)
    .limit(10)
)

rows = await session.execute(stmt)
```

### Row number window function

```python
from sqlalchemy import func, over

row_num = func.row_number().over(
    order_by=Document.embedding.cosine_distance(query_embedding)
).label("rank")

stmt = select(Document, row_num).limit(20)
```

---

## 9. Indexing

Without an index, pgvector does exact nearest-neighbour search (sequential
scan). This is fine up to ~100K rows; beyond that you need an ANN index.

### HNSW (recommended)

HNSW (Hierarchical Navigable Small World) gives the best query speed/recall
tradeoff. Added in pgvector 0.5.0.

```python
from sqlalchemy import Index, text
from sqlalchemy.schema import DDL
from sqlalchemy import event

# Define HNSW index on the model
hnsw_index = Index(
    "ix_documents_embedding_hnsw",
    Document.embedding,
    postgresql_using="hnsw",
    postgresql_with={"m": 16, "ef_construction": 64},
    postgresql_ops={"embedding": "vector_cosine_ops"},
)

# Attach to metadata so create_all() picks it up
Document.__table__.append_constraint(hnsw_index)
```

Or create directly in SQL:

```sql
CREATE INDEX CONCURRENTLY ix_documents_embedding_hnsw
ON documents
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);
```

HNSW parameters:
- `m`: number of connections per node (16 is a good default; higher = better recall, more memory)
- `ef_construction`: search depth during build (64 default; higher = better recall, slower build)
- `ef_search`: query-time parameter, set per-session: `SET hnsw.ef_search = 100`

### IVFFlat (legacy, simpler)

```sql
CREATE INDEX ON documents
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);
```

Use HNSW unless you have a specific reason not to — it doesn't require
a training pass and handles insertions without rebuild.

### Operator class mapping

| Distance method       | Index op class          |
|-----------------------|-------------------------|
| `cosine_distance`     | `vector_cosine_ops`     |
| `l2_distance`         | `vector_l2_ops`         |
| `max_inner_product`   | `vector_ip_ops`         |

The index op class must match the distance method you query with.

---

## 10. Alembic Migrations

```bash
alembic init alembic
```

In `alembic/env.py`, configure async support:

```python
from logging.config import fileConfig
from sqlalchemy.ext.asyncio import async_engine_from_config
from sqlalchemy import pool
from alembic import context
from models import Base

config = context.config
fileConfig(config.config_file_name)
target_metadata = Base.metadata

def run_migrations_online():
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    import asyncio

    async def do_run():
        async with connectable.connect() as connection:
            await connection.run_sync(context.configure, connection=connection, target_metadata=target_metadata)
            async with context.begin_transaction():
                await connection.run_sync(context.run_migrations)

    asyncio.run(do_run())
```

Enable pgvector in the first migration:

```python
# alembic/versions/0001_initial.py
from alembic import op

def upgrade():
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    # rest of table creation follows

def downgrade():
    op.execute("DROP EXTENSION IF EXISTS vector")
```

Generate migrations after model changes:

```bash
alembic revision --autogenerate -m "add documents table"
alembic upgrade head
```

Note: Alembic autogenerate does not detect `Vector` column changes (dimension
changes). Write those migration steps manually.

---

## 11. Upsert Pattern

Common in embedding pipelines: insert if not exists, update embedding if
content changed.

```python
from sqlalchemy.dialects.postgresql import insert as pg_insert

async def upsert_document(session: AsyncSession, content: str, source: str, embedding: list[float]):
    stmt = pg_insert(Document).values(
        content=content,
        source=source,
        embedding=embedding,
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=["source"],  # assumes source is a unique key
        set_={"embedding": stmt.excluded.embedding, "content": stmt.excluded.content},
    )
    await session.execute(stmt)
    await session.commit()
```

---

## 12. Async Pipeline: Concurrent Embedding + Search

This is where async pays off — pipelining embedding generation (external
API call) with metadata fetch:

```python
import asyncio

async def search_pipeline(
    session: AsyncSession,
    query: str,
    user_id: uuid.UUID,
) -> list[dict]:

    # fire off embedding API call and user context fetch concurrently
    embedding, user_docs = await asyncio.gather(
        get_embedding(query),                          # async HTTP to embedding API
        get_user_documents(session, user_id),          # async DB query
    )

    results = await similarity_search(session, embedding, top_k=10)

    return [
        {"content": doc.content, "source": doc.source}
        for doc in results
    ]

async def get_embedding(text: str) -> list[float]:
    # replace with your embedding provider
    import httpx
    async with httpx.AsyncClient() as client:
        response = await client.post(
            "https://api.openai.com/v1/embeddings",
            headers={"Authorization": f"Bearer {API_KEY}"},
            json={"input": text, "model": "text-embedding-3-small"},
        )
        return response.json()["data"][0]["embedding"]
```

---

## 13. Lambda / Serverless Considerations

When running in AWS Lambda (relevant for your scoring APIs), use `NullPool`
to avoid holding idle connections between invocations:

```python
from sqlalchemy.pool import NullPool

engine = create_async_engine(
    "postgresql+asyncpg://...",
    poolclass=NullPool,  # no connection pooling — Lambda is stateless
)
```

Each Lambda invocation gets a fresh connection and closes it on exit.
For high-throughput APIs, put RDS Proxy in front so connection overhead
is absorbed by the proxy rather than hitting Postgres directly.

---

## 14. Full Working Example

```python
# main.py
import asyncio
import uuid
import numpy as np
from db import init_db, SessionLocal
from models import Document
from crud import insert_document, similarity_search

async def main():
    await init_db()

    async with SessionLocal() as session:
        async with session.begin():
            # insert a few documents with random embeddings (replace with real ones)
            for i in range(5):
                await insert_document(
                    session,
                    content=f"Document number {i}",
                    embedding=np.random.rand(1536).tolist(),
                )

    async with SessionLocal() as session:
        query_vec = np.random.rand(1536).tolist()
        results = await similarity_search(session, query_vec, top_k=3)
        for doc in results:
            print(doc.id, doc.content)

asyncio.run(main())
```

---

## Quick Reference

| Task                        | Key API                                      |
|-----------------------------|----------------------------------------------|
| Define vector column        | `mapped_column(Vector(n))`                   |
| Cosine similarity search    | `.order_by(col.cosine_distance(vec))`        |
| L2 similarity search        | `.order_by(col.l2_distance(vec))`            |
| Return distance score       | `col.cosine_distance(vec).label("dist")`     |
| HNSW index                  | `postgresql_using="hnsw"`                    |
| Upsert                      | `pg_insert(...).on_conflict_do_update(...)`  |
| CTE                         | `select(...).cte("name")`                    |
| Bulk insert                 | `insert(Model).values([...])`                |
| Lambda pool                 | `poolclass=NullPool`                         |
| Enable extension            | `CREATE EXTENSION IF NOT EXISTS vector`      |
