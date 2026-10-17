"""The retrieval table: chunks of the SQLAlchemy documentation with their embeddings.

Lives on the project's `Base` (src/models.py) so `create_all` / `init_db()` create it, but in its
own table so the notebooks' `documents` (Vector(1536)) stay untouched.
"""

from pgvector.sqlalchemy import Vector
from sqlalchemy import Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from models import Base
from settings import settings

DOCS_BASE_URL = "https://docs.sqlalchemy.org/en/20/"


class DocChunk(Base):
    __tablename__ = "doc_chunks"

    id: Mapped[int] = mapped_column(primary_key=True)
    source: Mapped[str] = mapped_column(
        String(200)
    )  # path under doc/build, e.g. "tutorial/data_select.rst"
    title: Mapped[str] = mapped_column(
        String(300)
    )  # section heading the chunk belongs to
    ordinal: Mapped[int] = mapped_column(Integer)  # position within the source file
    text: Mapped[str] = mapped_column(Text)
    embedding: Mapped[list[float]] = mapped_column(Vector(settings.embed_dim))

    __table_args__ = (
        UniqueConstraint("source", "ordinal", name="uq_doc_chunks_source_ordinal"),
        Index(
            "ix_doc_chunks_embedding_hnsw",
            "embedding",
            postgresql_using="hnsw",
            postgresql_ops={"embedding": "vector_cosine_ops"},
        ),
    )

    @property
    def url(self) -> str:
        return DOCS_BASE_URL + self.source.removesuffix(".rst") + ".html"
