"""Smoke test: guide section 14. Run with `uv run src/main.py`."""

import asyncio

import numpy as np
from sqlalchemy import select, text

from db import SessionLocal, engine, init_db
from models import EMBEDDING_DIM, Document


async def main() -> None:
    await init_db()

    async with engine.connect() as conn:
        version = await conn.scalar(
            text("SELECT extversion FROM pg_extension WHERE extname = 'vector'")
        )
        print(f"pgvector extension version: {version}")

    async with SessionLocal() as session, session.begin():
        for i in range(5):
            session.add(
                Document(
                    content=f"Document number {i}",
                    source="smoke-test",
                    embedding=np.random.rand(EMBEDDING_DIM).tolist(),
                )
            )

    async with SessionLocal() as session:
        query_vec = np.random.rand(EMBEDDING_DIM).tolist()
        distance = Document.embedding.cosine_distance(query_vec).label("distance")
        stmt = select(Document, distance).order_by(distance).limit(3)
        for doc, dist in await session.execute(stmt):
            print(f"{doc.id}  {doc.content:<20}  cosine_distance={dist:.4f}")


if __name__ == "__main__":
    asyncio.run(main())
