"""Fetch a slice of the SQLAlchemy documentation, chunk it, embed it, store it in `doc_chunks`.

    uv run --env-file .env app/ingest.py            # all PAGES
    uv run --env-file .env app/ingest.py tutorial/  # only sources starting with a prefix

Idempotent: every run replaces the chunks of each page it processes. Set DB_ECHO=false in .env
unless you want every INSERT logged.
"""

import asyncio
import re
import sys
import time

import httpx
from fastembed import TextEmbedding
from sqlalchemy import delete, func, select

from chunks import DocChunk
from db import SessionLocal, init_db
from settings import settings

# -------------------------------------------------------------------------------
# Corpus: paths under doc/build in the sqlalchemy/sqlalchemy repository (MIT licensed)
# -------------------------------------------------------------------------------
PAGES = [
    "tutorial/index.rst",
    "tutorial/engine.rst",
    "tutorial/dbapi_transactions.rst",
    "tutorial/metadata.rst",
    "tutorial/data.rst",
    "tutorial/data_insert.rst",
    "tutorial/data_select.rst",
    "tutorial/data_update.rst",
    "tutorial/orm_data_manipulation.rst",
    "tutorial/orm_related_objects.rst",
    "orm/quickstart.rst",
    "orm/session_basics.rst",
    "orm/session_state_management.rst",
    "orm/extensions/asyncio.rst",
    "orm/queryguide/relationships.rst",
    "orm/relationship_persistence.rst",
    "orm/basic_relationships.rst",
    "orm/declarative_tables.rst",
    "core/pooling.rst",
    "core/connections.rst",
]
RAW = "https://raw.githubusercontent.com/sqlalchemy/sqlalchemy/{ref}/doc/build/{path}"

# -------------------------------------------------------------------------------
# reStructuredText -> prose. Heuristics, not a parser: enough to keep the sentences and drop
# the doctest transcripts and markup that would pollute both embeddings and the summariser.
# -------------------------------------------------------------------------------
HEADING_UNDERLINE = re.compile(r"^([=\-~^\"'`#*+]){3,}\s*$")
ROLE = re.compile(r":[\w:.+-]+:`([^`]*)`")  # :class:`~sqlalchemy.orm.Session` -> Session
ROLE_TARGET = re.compile(r"^(.*?)\s*<[^>]*>$")  # "Title <target>" -> Title
INLINE_LITERAL = re.compile(r"``([^`]*)``")
DOCTEST_OR_SQL = re.compile(
    r"^\s*(>>>|\.\.\.\s|{sql}|{execsql}|{opensql}|{stop}|{printsql}|BEGIN\b|COMMIT\b|ROLLBACK\b|"
    r"SELECT\b|INSERT\b|UPDATE\b|DELETE\b|CREATE\b|FROM\b|WHERE\b|JOIN\b|\[\(|\[\.\.\.\]|\(\d|\[SQL:)"
)
DIRECTIVE = re.compile(r"^\s*\.\.\s+(\w[\w-]*)::\s*(.*)$")
LABEL_OR_COMMENT = re.compile(r"^\s*\.\.(\s+_[^:]+:.*|\s*$|\s+[^\w].*)$")


def clean_inline(text: str) -> str:
    def role(m: re.Match) -> str:
        inner = m.group(1).lstrip("~")
        t = ROLE_TARGET.match(inner)
        inner = t.group(1) if t else inner
        # :class:`_orm.Session` / :meth:`.Session.add` / :class:`sqlalchemy.orm.Session` -> Session / Session.add
        inner = re.sub(r"^(_\w+\.|\.|sqlalchemy(\.\w+)*\.)", "", inner)
        return inner

    text = re.sub(r"(^|\s)[*\-+]\s+(?=\S)", r"\1", text)  # bullet markers
    text = ROLE.sub(role, text)
    text = INLINE_LITERAL.sub(r"\1", text)
    text = re.sub(r"\*\*?([^*]+)\*\*?", r"\1", text)  # *emphasis* / **strong**
    text = re.sub(r"`([^`<]+)\s*<[^>]*>`_", r"\1", text)  # `text <url>`_
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def sections(rst: str) -> list[tuple[str, list[str]]]:
    """Split a page into (heading, paragraphs). Code, doctests and directives are dropped."""
    lines = rst.splitlines()
    out: list[tuple[str, list[str]]] = [("", [])]
    para: list[str] = []
    skip_indented = False  # after a "::" literal block or a code directive

    def flush() -> None:
        nonlocal para
        if para:
            text = clean_inline(" ".join(para))
            if text and not text.startswith((".. ", ":")):
                out[-1][1].append(text)
        para = []

    i = 0
    while i < len(lines):
        line = lines[i]
        nxt = lines[i + 1] if i + 1 < len(lines) else ""
        # heading: a text line followed by an underline at least as long
        if line.strip() and HEADING_UNDERLINE.match(nxt) and len(nxt.strip()) >= len(line.strip()) and not line.startswith(" "):
            flush()
            out.append((clean_inline(line), []))
            skip_indented = False
            i += 2
            continue
        if HEADING_UNDERLINE.match(line):  # overline of a heading, or a transition
            i += 1
            continue
        if not line.strip():
            flush()
            i += 1
            continue
        d = DIRECTIVE.match(line)
        if d:
            flush()
            # prose directives keep their body; code / diagram directives skip it
            skip_indented = d.group(1) in {"sourcecode", "code-block", "code", "doctest", "literalinclude", "image", "figure", "toctree", "raw", "highlight", "container", "topic-note", "sidebar", "index", "module", "autoclass", "autofunction", "automodule", "changelog", "versionadded", "versionchanged", "deprecated"}
            i += 1
            continue
        if LABEL_OR_COMMENT.match(line):
            flush()
            i += 1
            continue
        if line.startswith((" ", "\t")):
            if skip_indented:
                i += 1
                continue
        else:
            skip_indented = False
        if DOCTEST_OR_SQL.match(line):
            flush()
            i += 1
            continue
        if line.rstrip().endswith("::"):
            para.append(line.rstrip()[:-2].rstrip() + ".")
            flush()
            skip_indented = True
            i += 1
            continue
        para.append(line.strip())
        i += 1
    flush()
    return [(h, ps) for h, ps in out if ps]


def chunk_page(source: str, rst: str, target_words: int) -> list[tuple[str, str]]:
    """(title, text) chunks of about `target_words`, never crossing a section boundary."""
    chunks: list[tuple[str, str]] = []
    page_title = source.removesuffix(".rst").replace("_", " ").replace("/", " / ")
    for heading, paras in sections(rst):
        title = heading or page_title
        buf: list[str] = []
        words = 0
        for p in paras:
            n = len(p.split())
            if buf and words + n > target_words:
                chunks.append((title, " ".join(buf)))
                buf, words = [], 0
            buf.append(p)
            words += n
        if buf:
            chunks.append((title, " ".join(buf)))
    return [(t, x) for t, x in chunks if len(x.split()) >= 30]


# -------------------------------------------------------------------------------
# Pipeline
# -------------------------------------------------------------------------------
async def fetch(client: httpx.AsyncClient, path: str) -> tuple[str, str]:
    r = await client.get(RAW.format(ref=settings.docs_ref, path=path))
    r.raise_for_status()
    return path, r.text


async def main(prefix: str = "") -> None:
    pages = [p for p in PAGES if p.startswith(prefix)]
    await init_db()  # creates doc_chunks (and the extension) if missing

    t0 = time.perf_counter()
    async with httpx.AsyncClient(timeout=30) as client:
        fetched = await asyncio.gather(*(fetch(client, p) for p in pages))
    print(f"fetched {len(fetched)} pages in {time.perf_counter() - t0:.1f}s")

    chunks = [(src, i, title, text) for src, rst in fetched for i, (title, text) in enumerate(chunk_page(src, rst, settings.chunk_words))]
    print(f"{len(chunks)} chunks, {sum(len(c[3].split()) for c in chunks):,} words")

    t0 = time.perf_counter()
    model = TextEmbedding(settings.embed_model)  # downloads the ONNX model on first use (~130 MB)
    vectors = list(model.passage_embed([f"{title}\n{text}" for _, _, title, text in chunks], batch_size=64))
    print(f"embedded with {settings.embed_model} in {time.perf_counter() - t0:.1f}s")
    assert len(vectors[0]) == settings.embed_dim, f"model returns {len(vectors[0])} dims, settings.embed_dim is {settings.embed_dim}"

    async with SessionLocal() as session:
        await session.execute(delete(DocChunk).where(DocChunk.source.in_(pages)))
        session.add_all(
            DocChunk(source=src, ordinal=i, title=title[:300], text=text, embedding=vec.tolist())
            for (src, i, title, text), vec in zip(chunks, vectors)
        )
        await session.commit()
        total = await session.scalar(select(func.count()).select_from(DocChunk))
    print(f"stored; doc_chunks now holds {total} chunks")


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else ""))
