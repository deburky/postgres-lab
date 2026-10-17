"""Typed settings for the playground, read from the environment and `.env` (pydantic-settings).

    from settings import settings
    settings.database_url            # PostgresDsn, validated at import time
    settings.sqlalchemy_url()        # str for create_engine / create_async_engine
    settings.sqlalchemy_url("pgrust") / settings.sqlalchemy_url("pgbouncer")

Precedence: real environment variables beat `.env`, which beats the defaults below. Compose
(`POSTGRES_*`), Pulumi (`PULUMI_*`) and `COMPOSE_FILE` live in the same `.env` but are not
modelled here; `extra="ignore"` lets them through.
"""

from typing import Literal

from pydantic import Field, MySQLDsn, PostgresDsn
from pydantic_settings import BaseSettings, SettingsConfigDict

Server = Literal[
    "pg16", "pg18", "pgrust", "pgbouncer", "replica", "ducklake",
    "k8s-pg16", "k8s-pgrust", "k3d-pg16", "k3d-pgrust", "k3s-pg16", "k3s-pgrust",
]


class Settings(BaseSettings):
    # -------------------------------------------------------------------------------
    # Database endpoints. PostgresDsn accepts the SQLAlchemy driver schemes
    # (postgresql+psycopg, postgresql+asyncpg, ...) and rejects anything malformed.
    # -------------------------------------------------------------------------------
    database_url: PostgresDsn = Field(
        "postgresql+psycopg://app:pwd@localhost:5432/app",
        description="pg16 + pgvector + pgvectorscale (docker/postgres-pgvector.yaml)",
    )
    pg18_database_url: PostgresDsn = Field(
        "postgresql+psycopg://app:pwd@localhost:5441/app",
        description="pg18 + pgvector + pgvectorscale + pg_vectorsearch (docker/pg18.yaml)",
    )
    ducklake_database_url: PostgresDsn = Field(
        "postgresql+psycopg://app:pwd@localhost:5443/app",
        description="pg18 + pg_ducklake: DuckLake tables on Parquet (docker/ducklake.yaml)",
    )
    pgrust_database_url: PostgresDsn = Field(
        "postgresql+psycopg://app:pwd@localhost:5433/app",
        description="pgrust v0.2 (docker/pgrust.yaml)",
    )
    pgbouncer_database_url: PostgresDsn = Field(
        "postgresql+psycopg://app:pwd@localhost:6432/app",
        description="PgBouncer in front of pg16, transaction pooling (docker/pgbouncer.yaml)",
    )
    replica_database_url: PostgresDsn = Field(
        "postgresql+psycopg://app:pwd@localhost:5440/app",
        description="second pg16 subscribed to the first with logical replication (--profile replica)",
    )
    k8s_pg16_database_url: PostgresDsn = (
        "postgresql+psycopg://app:pwd@localhost:5434/app"
    )
    k8s_pgrust_database_url: PostgresDsn = (
        "postgresql+psycopg://app:pwd@localhost:5435/app"
    )
    k3d_pg16_database_url: PostgresDsn = (
        "postgresql+psycopg://app:pwd@localhost:5436/app"
    )
    k3d_pgrust_database_url: PostgresDsn = (
        "postgresql+psycopg://app:pwd@localhost:5437/app"
    )
    k3s_pg16_database_url: PostgresDsn = Field(
        "postgresql+psycopg://app:pwd@localhost:5438/app",
        description="pg16 on the k3s container k8s/k3s.py starts through the Docker SDK",
    )
    k3s_pgrust_database_url: PostgresDsn = (
        "postgresql+psycopg://app:pwd@localhost:5439/app"
    )
    doris_url: MySQLDsn = Field(
        "mysql+pymysql://root@localhost:9030",
        description="Apache Doris FE, MySQL protocol (docker/postgres-pgvector.yaml --profile doris)",
    )

    # -------------------------------------------------------------------------------
    # Engine tuning (src/db.py)
    # -------------------------------------------------------------------------------
    db_pool_size: int = 10
    db_max_overflow: int = 20
    db_echo: bool = Field(True, description="log every SQL statement SQLAlchemy emits")

    # -------------------------------------------------------------------------------
    # Doc search app (app/): embeddings, summariser, corpus
    # -------------------------------------------------------------------------------
    embed_model: str = Field(
        "BAAI/bge-small-en-v1.5", description="fastembed model name (ONNX, CPU)"
    )
    embed_dim: int = Field(
        384,
        description="must match embed_model; changing it means recreating doc_chunks",
    )
    spacy_model: str = "en_core_web_sm"
    docs_ref: str = Field(
        "main",
        description="sqlalchemy/sqlalchemy git ref the .rst files are fetched from",
    )
    chunk_words: int = Field(250, description="target words per chunk at ingest")
    search_k: int = Field(
        5, description="default number of chunks retrieved per question"
    )
    summary_sentences: int = Field(
        4, description="default sentences in the extractive summary"
    )

    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    def sqlalchemy_url(self, server: Server = "pg16") -> str:
        """The DSN for `server` as the plain string SQLAlchemy's engine factories want."""
        urls = {
            "pg16": self.database_url,
            "pg18": self.pg18_database_url,
            "pgrust": self.pgrust_database_url,
            "pgbouncer": self.pgbouncer_database_url,
            "replica": self.replica_database_url,
            "ducklake": self.ducklake_database_url,
            "k8s-pg16": self.k8s_pg16_database_url,
            "k8s-pgrust": self.k8s_pgrust_database_url,
            "k3d-pg16": self.k3d_pg16_database_url,
            "k3d-pgrust": self.k3d_pgrust_database_url,
            "k3s-pg16": self.k3s_pg16_database_url,
            "k3s-pgrust": self.k3s_pgrust_database_url,
        }
        return str(urls[server])


settings = Settings()

if __name__ == "__main__":
    # `uv run src/settings.py` prints what the process would use, passwords masked.
    import re

    for name, value in settings.model_dump().items():
        if isinstance(value, (PostgresDsn, MySQLDsn)):
            value = re.sub(r"://([^:/@]+):[^@]+@", r"://\1:***@", str(value))
        print(f"{name:<24} {value}")
