"""Doc search + extractive summary over the SQLAlchemy documentation. No LLM involved.

    uv run --env-file .env app/ingest.py                       # once: fill doc_chunks
    uv run --env-file .env uvicorn --app-dir app app:app --reload
    open http://127.0.0.1:8000/docs

POST /ask     question -> top-k chunks by cosine similarity -> spaCy summary of those chunks
GET  /search  the retrieval step alone
GET  /health  database, chunk count, model names
POST /queue/trace  a traced pgqueuer run for the queue scene in viz/ (queue.html)

The summary is extractive: the sentences it returns are copied from the retrieved chunks, ranked
by how many frequent content words they contain. It is a digest of the relevant passages, not an
answer, which is why every response carries the chunks and their URLs.
"""

import asyncio
import contextvars
import time
from contextlib import asynccontextmanager
from typing import Literal

import spacy
from chunks import DocChunk
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastembed import TextEmbedding
from pydantic import BaseModel, Field
from sqlalchemy import event, func, select, text
from summarize import summarize_text

from db import SessionLocal, engine
from queue_trace import QueueTraceRequest
from queue_trace import run as run_queue_trace
from settings import settings
from vecfield import Field as VecField

# -------------------------------------------------------------------------------
# Models loaded once per process (lifespan), shared by all requests
# -------------------------------------------------------------------------------
state: dict = {}


@asynccontextmanager
async def lifespan(_: FastAPI):
    t0 = time.perf_counter()
    state["nlp"] = spacy.load(settings.spacy_model)
    state["embedder"] = TextEmbedding(settings.embed_model)
    list(state["embedder"].query_embed("warm up"))  # first call loads the ONNX session
    try:
        state["field"] = await asyncio.to_thread(
            VecField.load
        )  # PCA layout of doc_chunks for the city
    except RuntimeError as e:
        print("field unavailable:", e)
    print(
        f"models ready in {time.perf_counter() - t0:.1f}s: {settings.spacy_model}, {settings.embed_model}"
    )
    yield
    await engine.dispose()


app = FastAPI(
    title="SQLAlchemy docs: search + summary",
    description=__doc__,
    lifespan=lifespan,
)
# the three.js city (viz/, Vite dev server or a static build) calls /field and /trace from another origin
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

# -------------------------------------------------------------------------------
# Tracing for the city: SQLAlchemy engine hooks append to whichever list the current
# request installed in this context variable (None outside /trace)
# -------------------------------------------------------------------------------
TRACE: contextvars.ContextVar[list | None] = contextvars.ContextVar(
    "trace", default=None
)
T0: contextvars.ContextVar[float] = contextvars.ContextVar("t0", default=0.0)


def _emit(kind: str, **fields) -> None:
    sink = TRACE.get()
    if sink is not None:
        sink.append(
            {
                "t": round((time.perf_counter() - T0.get()) * 1000, 2),
                "kind": kind,
                "req": REQ.get(),
                "worker": WORKER.get(),
                **fields,
            }
        )


def _pid(dbapi_conn) -> int | None:
    raw = getattr(dbapi_conn, "_connection", dbapi_conn)
    try:
        return raw.info.backend_pid
    except AttributeError:
        return None


@event.listens_for(engine.sync_engine, "connect")
def _on_connect(dbapi_conn, record):
    _emit("connect", conn=0, pid=_pid(dbapi_conn))


@event.listens_for(engine.sync_engine, "checkout")
def _on_checkout(dbapi_conn, record, proxy):
    _emit("checkout", conn=0, pid=_pid(dbapi_conn))


@event.listens_for(engine.sync_engine, "checkin")
def _on_checkin(dbapi_conn, record):
    _emit("checkin", conn=0, pid=_pid(dbapi_conn))


@event.listens_for(engine.sync_engine, "before_cursor_execute")
def _before(conn, cursor, statement, parameters, context, executemany):
    _emit("stmt_start", conn=0, sql=statement.strip()[:48])


@event.listens_for(engine.sync_engine, "after_cursor_execute")
def _after(conn, cursor, statement, parameters, context, executemany):
    _emit("stmt_end", conn=0, sql=statement.strip()[:48])


# -------------------------------------------------------------------------------
# Schemas
# -------------------------------------------------------------------------------
class Hit(BaseModel):
    source: str
    title: str
    url: str
    score: float = Field(description="cosine similarity, 1 = identical direction")
    text: str


class AskRequest(BaseModel):
    query: str = Field(min_length=3, examples=["How does selectinload work?"])
    k: int = Field(settings.search_k, ge=1, le=20, description="chunks to retrieve")
    sentences: int = Field(
        settings.summary_sentences, ge=1, le=15, description="sentences in the summary"
    )
    source_prefix: str | None = Field(
        None, examples=["orm/"], description="restrict to sources starting with this"
    )


class AskResponse(BaseModel):
    query: str
    summary: str
    keywords: list[str]
    hits: list[Hit]
    timings_ms: dict[str, float]


# -------------------------------------------------------------------------------
# Retrieval
# -------------------------------------------------------------------------------
async def embed_query(q: str) -> list[float]:
    # ONNX inference is CPU-bound and synchronous: keep it off the event loop
    vec = await asyncio.to_thread(lambda: next(iter(state["embedder"].query_embed(q))))
    return vec.tolist()


async def search(q: str, k: int, source_prefix: str | None) -> list[Hit]:
    qvec = await embed_query(q)
    distance = DocChunk.embedding.cosine_distance(qvec).label("distance")
    stmt = select(DocChunk, distance).order_by(distance).limit(k)
    if source_prefix:
        stmt = stmt.where(DocChunk.source.startswith(source_prefix))
    async with SessionLocal() as session:
        rows = (await session.execute(stmt)).all()
    return [
        Hit(
            source=c.source,
            title=c.title,
            url=c.url,
            score=round(1 - d, 4),
            text=c.text,
        )
        for c, d in rows
    ]


# -------------------------------------------------------------------------------
# Endpoints
# -------------------------------------------------------------------------------
@app.get("/health")
async def health() -> dict:
    async with SessionLocal() as session:
        version = await session.scalar(text("SELECT version()"))
        chunks = await session.scalar(select(func.count()).select_from(DocChunk))
    return {
        "database": version.split(",")[0],
        "doc_chunks": chunks,
        "embed_model": settings.embed_model,
        "spacy_model": settings.spacy_model,
    }


@app.get("/search", response_model=list[Hit])
async def search_endpoint(
    q: str = Query(min_length=3, examples=["expire_on_commit"]),
    k: int = Query(settings.search_k, ge=1, le=20),
    source_prefix: str | None = Query(None),
) -> list[Hit]:
    return await search(q, k, source_prefix)


@app.post("/ask", response_model=AskResponse)
async def ask(req: AskRequest) -> AskResponse:
    t0 = time.perf_counter()
    hits = await search(req.query, req.k, req.source_prefix)
    t1 = time.perf_counter()
    if not hits:
        raise HTTPException(404, "no chunks in doc_chunks; run app/ingest.py first")

    # Rank order matters: the summariser weighs words by frequency across the whole text, so the
    # best-matching chunks first means their vocabulary dominates the scoring.
    corpus = "\n\n".join(h.text for h in hits)
    result = await asyncio.to_thread(
        summarize_text,
        corpus,
        state["nlp"],
        summary_sentence_count=req.sentences,
        top_keyword_count=8,
        query=req.query,  # sentences mentioning the question's terms outrank merely dense ones
        length_penalty=0.75,  # 0 = plain sum (longest sentences win), 1 = mean (shortest win)
    )
    t2 = time.perf_counter()
    if result.error:
        raise HTTPException(422, result.error)

    return AskResponse(
        query=req.query,
        summary=result.summary,
        keywords=[w for w, _ in result.top_keywords],
        hits=hits,
        timings_ms={
            "retrieve": round((t1 - t0) * 1000, 1),
            "summarize": round((t2 - t1) * 1000, 1),
        },
    )


# -------------------------------------------------------------------------------
# For the city (viz/): the layout of the docs, and one fully traced question
# -------------------------------------------------------------------------------
@app.get("/field")
async def field() -> dict:
    """The doc chunks as points: ids, titles, sources, and PCA coordinates in [-1, 1]^3."""
    if "field" not in state:
        raise HTTPException(503, "doc_chunks is empty; run app/ingest.py first")
    f: VecField = state["field"]
    return {
        "table": {
            "name": "doc_chunks",
            "rows": len(f.ids),
            "dim": int(f.comps.shape[1]),
            "k": settings.search_k,
            "index": "hnsw (embedding vector_cosine_ops)",
            "embed_model": settings.embed_model,
        },
        "field": f.as_json(),
    }


class TraceRequest(BaseModel):
    questions: list[str] = Field(
        min_length=1,
        max_length=20,
        examples=[["How does selectinload work?", "What does expire_on_commit do?"]],
    )
    mode: Literal["sync", "async"] = "async"
    k: int = Field(5, ge=1, le=20)


REQ: contextvars.ContextVar[int] = contextvars.ContextVar("req", default=0)
WORKER: contextvars.ContextVar[str] = contextvars.ContextVar("worker", default="loop")
KNN = text(
    "SELECT id, title, embedding <=> CAST(:q AS vector) AS distance FROM doc_chunks ORDER BY distance LIMIT :k"
)


def _attach(eng) -> None:
    """The same hooks as on the app engine, for an engine created per /trace call."""

    @event.listens_for(eng, "connect")
    def on_connect(dbapi_conn, record):
        cur = dbapi_conn.cursor()
        cur.execute(
            "SET enable_seqscan = off"
        )  # 404 rows: make the planner take the index
        cur.close()
        _emit("connect", conn=0, pid=_pid(dbapi_conn))

    @event.listens_for(eng, "checkout")
    def on_checkout(dbapi_conn, record, proxy):
        _emit("checkout", conn=0, pid=_pid(dbapi_conn))

    @event.listens_for(eng, "checkin")
    def on_checkin(dbapi_conn, record):
        _emit("checkin", conn=0, pid=_pid(dbapi_conn))

    @event.listens_for(eng, "before_cursor_execute")
    def before(conn, cursor, statement, parameters, context, executemany):
        _emit("stmt_start", conn=0, sql=statement.strip()[:48])

    @event.listens_for(eng, "after_cursor_execute")
    def after(conn, cursor, statement, parameters, context, executemany):
        _emit("stmt_end", conn=0, sql=statement.strip()[:48])


def _embed_sync(q: str) -> list[float]:
    return next(iter(state["embedder"].query_embed(q))).tolist()


def _sync_one(eng, i: int, question: str, k: int, out: dict) -> None:
    """One question, blocking: embed, then the kNN on the single pooled connection."""
    REQ.set(i)
    WORKER.set("main")
    _emit("request_start")
    _emit("embed_start", model=settings.embed_model)
    qvec = _embed_sync(question)
    _emit("embed_end", dim=len(qvec))
    _emit("pool_ask")
    with eng.begin() as conn:
        rows = conn.execute(KNN, {"q": str(qvec), "k": k}).all()
    out[i] = (qvec, rows)
    _emit("request_end", rows=len(rows))


async def _async_one(eng, i: int, question: str, k: int, out: dict) -> None:
    """One question as an asyncio task: embed off the loop, then the kNN on its own connection."""
    REQ.set(i)
    WORKER.set("loop")
    _emit("request_start")
    _emit("embed_start", model=settings.embed_model)
    qvec = await asyncio.to_thread(_embed_sync, question)
    _emit("embed_end", dim=len(qvec))
    _emit("pool_ask")
    async with eng.begin() as conn:
        rows = (await conn.execute(KNN, {"q": str(qvec), "k": k})).all()
    out[i] = (qvec, rows)
    _emit("request_end", rows=len(rows))


@app.post("/trace")
async def trace_batch(req: TraceRequest) -> dict:
    """Answer a batch of questions sync (one connection, one after another) or async (one task and
    one connection each, asyncio.gather), with every step traced. Returns the scenario the city plays.
    """
    if "field" not in state:
        raise HTTPException(503, "doc_chunks is empty; run app/ingest.py first")
    f: VecField = state["field"]
    questions = [q.strip() for q in req.questions if q.strip()]
    if not questions:
        raise HTTPException(422, "no questions")
    events: list = []
    out: dict = {}
    TRACE.set(events)
    T0.set(time.perf_counter())
    url = settings.sqlalchemy_url("pg16")
    if req.mode == "sync":
        from sqlalchemy import create_engine

        eng = create_engine(url, pool_size=1, max_overflow=0)
        _attach(eng)

        def run_all() -> None:
            for i, q in enumerate(questions):
                _sync_one(eng, i, q, req.k, out)

        await asyncio.to_thread(
            run_all
        )  # the whole batch blocks one thread, as sync code does
        eng.dispose()
    else:
        from sqlalchemy.ext.asyncio import create_async_engine

        aeng = create_async_engine(url, pool_size=len(questions), max_overflow=0)
        _attach(aeng.sync_engine)
        await asyncio.gather(
            *(_async_one(aeng, i, q, req.k, out) for i, q in enumerate(questions))
        )
        await aeng.dispose()
    TRACE.set(None)
    end = max(e["t"] for e in events if e["kind"] == "request_end")
    conns: dict[int, dict] = {}
    for e in events:
        if e["kind"] == "connect":
            conns[e["pid"]] = {
                "slot": len(conns),
                "pid": e["pid"],
                "connected_at": e["t"],
            }
    return {
        "name": req.mode,
        "title": "Sync" if req.mode == "sync" else "Async",
        "description": (
            "One thread, one connection: each question waits for the previous answer."
            if req.mode == "sync"
            else "One event loop, one task and one connection per question, all in flight at once."
        ),
        "config": {
            "requests": len(questions),
            "concurrency": req.mode,
            "pool_size": 1 if req.mode == "sync" else len(questions),
        },
        "plan": None,
        "duration_ms": end,
        "events": events,
        "connections": list(conns.values()),
        "samples": [],
        "queries": [
            {
                "id": i,
                "text": q,
                "point": f.project(out[i][0]),
                "results": [
                    {
                        "id": r.id,
                        "title": r.title,
                        "distance": round(float(r.distance), 4),
                    }
                    for r in out[i][1]
                ],
            }
            for i, q in enumerate(questions)
        ],
    }


# -------------------------------------------------------------------------------
# For the queue scene (viz/queue.html): real pgqueuer workers, traced
# -------------------------------------------------------------------------------
QUEUE_LOCK = asyncio.Lock()  # one run at a time: they share the viz_job rows


@app.post("/queue/trace")
async def queue_trace(req: QueueTraceRequest) -> dict:
    """Start pgqueuer workers, enqueue jobs, drain them, and return the timeline the scene plays."""
    async with QUEUE_LOCK:
        return await run_queue_trace(req)
