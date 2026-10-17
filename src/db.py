"""Engine + session factory (guide section 3)."""

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from models import Base
from settings import settings

# Validated at import time by src/settings.py (env var DATABASE_URL beats .env beats the default).
DATABASE_URL = settings.sqlalchemy_url("pg16")

engine = create_async_engine(
    DATABASE_URL,
    pool_size=settings.db_pool_size,
    max_overflow=settings.db_max_overflow,
    pool_timeout=30,
    pool_recycle=1800,
    pool_pre_ping=True,
    echo=settings.db_echo,  # DB_ECHO=false in .env silences the SQL log
)

SessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def init_db() -> None:
    """Enable pgvector and create all tables defined on Base."""
    async with engine.begin() as conn:
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        await conn.run_sync(Base.metadata.create_all)
